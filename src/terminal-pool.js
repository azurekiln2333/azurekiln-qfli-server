// 终端节点池：业务端在共享数据库上协调槽位、用户亲和与操作令牌。
// 任何跨实例决定都在 terminal_coord 单行锁内完成，HTTP 调用一律在事务之外。
const crypto = require('node:crypto');
const db = require('./db');
const terminal = require('./terminal-client');
const { ApiError } = require('./gateway');
const { log } = require('./logging');

const OP_DEADLINE_MS = 100 * 1000;
const IDLE_MS = 120 * 1000;
const SESSION_MS = 30 * 60 * 1000 + 60 * 1000;
const RECLAIM_GRACE_MS = 30 * 1000;
const QUARANTINE_MS = 5 * 60 * 1000;
const PROBE_TTL_MS = 5000;
const MAX_NODES = 16;
// 执行器单节点上限。配置元数据不探测，也不创建沙箱。
const WORKSPACE_MIB = 256;
const SESSIONS_PER_NODE = 1;

const NODE_KEYS = ['id', 'url', 'secret', 'draining'];
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const healthCache = new Map();

function target(url, secret, id) {
  if (typeof url !== 'string' || !url.trim() || typeof secret !== 'string' ||
      !/^[\x21-\x7e]{32,256}$/.test(secret)) {
    throw new ApiError(503, `终端节点 ${id} 缺少地址或有效密钥`);
  }
  let parsed;
  try { parsed = new URL(url.trim()); } catch { throw new ApiError(503, `终端节点 ${id} 地址无效`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:'))) {
    throw new ApiError(503, `终端节点 ${id} 需要本机地址或 HTTPS`);
  }
  return { id, base: parsed.toString().replace(/\/+$/, ''), secret };
}

function parseNodes() {
  const nodes = [];
  const urls = new Set();
  const raw = (process.env.QFLI_TERMINAL_NODES || '').trim();
  if (raw) {
    let list;
    try { list = JSON.parse(raw); } catch { throw new ApiError(503, '终端节点配置不是有效 JSON'); }
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_NODES) {
      throw new ApiError(503, '终端节点数量无效');
    }
    const ids = new Set();
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          Object.keys(entry).some(key => !NODE_KEYS.includes(key)) ||
          typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id) || ids.has(entry.id) ||
          (entry.draining !== undefined && typeof entry.draining !== 'boolean')) {
        throw new ApiError(503, '终端节点配置无效');
      }
      ids.add(entry.id);
      const node = target(entry.url, entry.secret, entry.id);
      if (urls.has(node.base)) throw new ApiError(503, '终端节点地址重复');
      urls.add(node.base);
      nodes.push({ ...node, draining: entry.draining === true });
    }
  }
  const legacyUrl = (process.env.QFLI_TERMINAL_URL || '').trim();
  const legacySecret = process.env.QFLI_TERMINAL_SECRET || '';
  if (legacyUrl || legacySecret) {
    const id = `legacy-${crypto.createHash('sha1').update(legacyUrl).digest('hex').slice(0, 12)}`;
    const node = target(legacyUrl, legacySecret, id);
    if (!nodes.some(existing => existing.base === node.base)) {
      nodes.push({ ...node, draining: false });
    }
  }
  return nodes;
}

function configuration() {
  const nodes = parseNodes();
  if (!nodes.length) throw new ApiError(503, '安全终端服务未配置，已禁止宿主机执行');
  return nodes;
}

// 只返回配置容量。不探测执行器，不创建沙箱。
function metadata() {
  const nodes = configuration();
  return {
    nodes: nodes.length,
    sessionsPerNode: SESSIONS_PER_NODE,
    workspaceMiB: WORKSPACE_MIB,
    idleSeconds: Math.round(IDLE_MS / 1000),
    lifetimeSeconds: Math.round(SESSION_MS / 1000),
  };
}

async function snapshotHealth(nodes) {
  const now = Date.now();
  await Promise.all(nodes.map(async node => {
    const cached = healthCache.get(node.id);
    if (cached && now - cached.at < PROBE_TTL_MS) return;
    const result = await terminal.health(node);
    healthCache.set(node.id, { at: Date.now(), ...result });
  }));
  return healthCache;
}

function nodeHealth(node) {
  const cached = healthCache.get(node.id);
  return cached?.ready === true ? cached : null;
}

// 保守预算：执行器还没有能力元数据的旧版本按 1 会话 1 并发处理。
function spareSession(health) {
  const capacity = health?.capacity;
  if (!capacity) return false;
  return capacity.sessions + 1 <= capacity.sessionsLimit;
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

async function readNow(prepare) {
  return Number((await prepare(db.NOW_SQL).get()).t);
}

async function lockCoord(tx, now) {
  const result = await tx.prepare(
    'UPDATE terminal_coord SET version = version + 1, updated_at = ? WHERE `key` = ?',
  ).run(now, 'pool');
  if (!result.changes) throw new ApiError(503, '终端调度未初始化');
}

function placementOf(decision, nodes) {
  const node = nodes.find(entry => entry.id === decision.nodeId);
  if (!node) throw new ApiError(503, '终端节点已移除，请在原节点完成清理后再使用');
  return { node: { id: node.id, base: node.base, secret: node.secret },
    token: decision.token, reused: decision.reused === true };
}

// 过期槽位先置为回收中并换令牌。HTTP 确认清理在事务外执行。
async function markReclaim(tx, now, row, node, requester) {
  const token = randomToken();
  const updated = await tx.prepare(`UPDATE terminal_slots
    SET phase = 'reclaiming', reclaim_user_id = ?, operation_token = ?,
        operation_deadline = ?, updated_at = ?
    WHERE node_id = ? AND user_id = ? AND phase = ? AND operation_token = ?`)
    .run(requester, token, now + RECLAIM_GRACE_MS, now, node.id, row.user_id,
      row.phase, row.operation_token);
  if (!updated.changes) return { kind: 'retry' };
  return { kind: 'reclaim', nodeId: node.id, token, oldUser: row.user_id,
    requester, releaseOnly: node.draining === true };
}

// 放置决策：同一事务内锁定协调行、读取全部槽位并写入令牌。
async function decide(userId, nodes, health) {
  return db.transaction(async tx => {
    const now = await readNow(tx.prepare);
    await lockCoord(tx, now);
    const rows = await tx.prepare('SELECT * FROM terminal_slots').all();
    const byNode = new Map(rows.map(row => [row.node_id, row]));
    for (const node of nodes) {
      if (byNode.has(node.id)) continue;
      await tx.prepare(`INSERT INTO terminal_slots
        (node_id, user_id, phase, operation_token, updated_at) VALUES (?, NULL, 'free', '', ?)`)
        .run(node.id, now);
      byNode.set(node.id, { node_id: node.id, user_id: null, phase: 'free',
        operation_token: '', operation_deadline: null, idle_deadline: null,
        session_deadline: null, updated_at: now });
    }

    const own = [...byNode.values()].filter(row => row.phase !== 'free' &&
      (row.user_id === userId || row.reclaim_user_id === userId));
    const nodeOf = id => nodes.find(node => node.id === id);
    if (own.length) {
      // 已有分配的用户只允许在原节点复用或先确认清理，绝不因其他节点空闲而改派。
      const other = own.find(row => !nodeOf(row.node_id));
      if (other) return { kind: 'missing', nodeId: other.node_id };
      if (own.length > 1) return { kind: 'quarantine', nodeId: own[1].node_id };
      const assigned = own[0];
      const node = nodeOf(assigned.node_id);
      const healthy = nodeHealth(node);
      if (assigned.phase === 'idle') {
        if (!healthy) return { kind: 'unavailable', nodeId: node.id };
        if (Number(assigned.session_deadline || 0) > now) {
          const token = randomToken();
          const updated = await tx.prepare(`UPDATE terminal_slots
            SET phase = 'reserved', operation_token = ?, operation_deadline = ?,
                idle_deadline = ?, updated_at = ?
            WHERE node_id = ? AND user_id = ? AND phase = 'idle'`)
            .run(token, now + OP_DEADLINE_MS, now + IDLE_MS, now, node.id, userId);
          if (updated.changes) return { kind: 'placed', nodeId: node.id, token, reused: true };
          return { kind: 'retry' };
        }
        // 会话已超时：必须由原节点确认清理后才能重新开始。
        return markReclaim(tx, now, assigned, node, userId);
      }
      if (assigned.phase === 'reserved' || assigned.phase === 'reclaiming') {
        if (Number(assigned.operation_deadline || 0) > now) {
          return { kind: 'conflict', nodeId: node.id };
        }
        // 超时只是恢复触发条件，不证明旧命令已停止。
        return markReclaim(tx, now, assigned, node, userId);
      }
      if (assigned.phase === 'quarantine') {
        if (Number(assigned.operation_deadline || 0) > now) {
          return { kind: 'quarantine', nodeId: node.id };
        }
        return markReclaim(tx, now, assigned, node, userId);
      }
      return { kind: 'quarantine', nodeId: node.id };
    }

    const candidates = [];
    for (const node of nodes) {
      const healthy = nodeHealth(node);
      if (!healthy) continue;
      const row = byNode.get(node.id);
      if (row.phase === 'free' || !row.user_id) {
        if (node.draining || !spareSession(healthy)) continue;
        candidates.push({ node, row, reclaim: false, load: 0 });
        continue;
      }
      const expired = row.phase === 'idle'
        ? Number(row.idle_deadline || 0) <= now
        : Number(row.operation_deadline || 0) <= now;
      if (!expired) continue;
      // draining 节点只做确认清理，不接纳新会话。
      candidates.push({ node, row, reclaim: true, releaseOnly: node.draining, load: 1 });
    }
    candidates.sort((left, right) =>
      left.load - right.load || left.node.id.localeCompare(right.node.id));
    const chosen = candidates[0];
    if (!chosen) {
      const usable = nodes.some(node => !node.draining && nodeHealth(node));
      return { kind: usable ? 'full' : 'unavailable' };
    }

    if (!chosen.reclaim) {
      const token = randomToken();
      const updated = await tx.prepare(`UPDATE terminal_slots
        SET user_id = ?, phase = 'reserved', operation_token = ?, operation_deadline = ?,
            idle_deadline = ?, session_deadline = ?, updated_at = ?
        WHERE node_id = ? AND phase = 'free'`)
        .run(userId, token, now + OP_DEADLINE_MS, now + IDLE_MS, now + SESSION_MS,
          now, chosen.node.id);
      if (updated.changes) {
        return { kind: 'placed', nodeId: chosen.node.id, token, reused: false };
      }
      return { kind: 'retry' };
    }

    // 过期槽位必须先由旧用户确认回收，才能交给新用户。
    return markReclaim(tx, now, chosen.row, chosen.node, userId);
  });
}

async function quarantine(nodeId, token, { keepSession = true } = {}) {
  const now = await db.now();
  const updated = await db.prepare(`UPDATE terminal_slots
    SET phase = 'quarantine', reclaim_user_id = '', operation_deadline = ?, updated_at = ?,
        session_deadline = CASE WHEN ? IS NULL AND session_deadline IS NULL
          THEN ? ELSE session_deadline END
    WHERE node_id = ? AND operation_token = ?`)
    .run(now + QUARANTINE_MS, now, keepSession ? now : null, now + SESSION_MS, nodeId, token);
  return updated.changes > 0;
}

async function completeReclaim(nodeId, token, userId) {
  return db.transaction(async tx => {
    const now = await readNow(tx.prepare);
    await lockCoord(tx, now);
    // 跨实例原子唯一性：同一用户只能拥有一个非空闲节点。
    const conflict = await tx.prepare(`SELECT node_id FROM terminal_slots
      WHERE (user_id = ? OR reclaim_user_id = ?) AND node_id <> ? AND phase <> 'free'
      LIMIT 1`).get(userId, userId, nodeId);
    if (conflict) {
      // 旧会话已确认删除，节点可以安全释放，但绝不绑定第二个节点。
      await tx.prepare(`UPDATE terminal_slots
        SET user_id = NULL, reclaim_user_id = '', phase = 'free', operation_token = '',
            operation_deadline = NULL, idle_deadline = NULL, session_deadline = NULL,
            updated_at = ?
        WHERE node_id = ? AND phase = 'reclaiming' AND operation_token = ?`)
        .run(now, nodeId, token);
      return null;
    }
    const newToken = randomToken();
    const updated = await tx.prepare(`UPDATE terminal_slots
      SET user_id = ?, reclaim_user_id = '', phase = 'reserved', operation_token = ?,
          operation_deadline = ?, idle_deadline = ?, session_deadline = ?, updated_at = ?
      WHERE node_id = ? AND phase = 'reclaiming' AND operation_token = ?`)
      .run(userId, newToken, now + OP_DEADLINE_MS, now + IDLE_MS,
        now + SESSION_MS, now, nodeId, token);
    return updated.changes ? newToken : null;
  });
}

// draining 节点清理后只置为空闲，不交给请求者。
async function releaseReclaim(nodeId, token) {
  return db.transaction(async tx => {
    const now = await readNow(tx.prepare);
    await lockCoord(tx, now);
    const updated = await tx.prepare(`UPDATE terminal_slots
      SET user_id = NULL, reclaim_user_id = '', phase = 'free', operation_token = '',
          operation_deadline = NULL, idle_deadline = NULL, session_deadline = NULL,
          updated_at = ?
      WHERE node_id = ? AND phase = 'reclaiming' AND operation_token = ?`)
      .run(now, nodeId, token);
    return updated.changes > 0;
  });
}

async function place(userId) {
  const nodes = configuration();
  const health = await snapshotHealth(nodes);
  const attempts = nodes.length * 3 + 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const decision = await decide(userId, nodes, health);
    if (decision.kind === 'retry') continue;
    if (decision.kind === 'placed') {
      log('terminal.placement', { nodeId: decision.nodeId, reused: decision.reused });
      return placementOf(decision, nodes);
    }
    if (decision.kind === 'conflict') throw new ApiError(409, '该终端正在执行或回收，请稍后重试');
    if (decision.kind === 'missing') {
      throw new ApiError(503, '终端所在节点已从配置移除，请恢复节点完成清理后再试');
    }
    if (decision.kind === 'quarantine') {
      throw new ApiError(503, '终端状态待恢复，请稍后重试');
    }
    if (decision.kind === 'unavailable') {
      throw new ApiError(503, '安全终端暂不可用，已禁止宿主机执行');
    }
    if (decision.kind === 'full') throw new ApiError(429, '终端会话已满，请稍后重试');

    // decision.kind === 'reclaim'：事务外执行确认清理，再用令牌围栏提交。
    const node = nodes.find(entry => entry.id === decision.nodeId);
    if (!node) {
      if (!await quarantine(decision.nodeId, decision.token)) {
        throw new ApiError(409, '终端状态已变化，请稍后重试');
      }
      continue;
    }
    let resetError;
    try {
      await terminal.reset(node, null, null, decision.oldUser);
    } catch (error) {
      resetError = error;
    }
    if (resetError) {
      healthCache.set(node.id, { at: Date.now(), ready: false, capacity: null });
      // 令牌已失效说明等待期间被 reset 取消或接管，不得再换节点派单。
      if (!await quarantine(decision.nodeId, decision.token)) {
        throw new ApiError(409, '终端状态已变化，请稍后重试');
      }
      log('terminal.reclaim_failed', { nodeId: node.id,
        status: resetError instanceof ApiError ? resetError.status : 0 }, 'error');
      continue;
    }
    healthCache.delete(node.id);
    if (decision.releaseOnly) {
      const released = await releaseReclaim(decision.nodeId, decision.token);
      if (!released) throw new ApiError(409, '终端状态已变化，请稍后重试');
      continue;
    }
    const token = await completeReclaim(decision.nodeId, decision.token, userId);
    // 令牌失效说明等待期间状态被取消或接管，等待中的命令不得再派单。
    if (!token) throw new ApiError(409, '终端状态已变化，请稍后重试');
    log('terminal.placement', { nodeId: decision.nodeId, reused: false, reclaimed: true });
    return placementOf({ nodeId: decision.nodeId, token, reused: false }, nodes);
  }
  throw new ApiError(429, '终端会话已满，请稍后重试');
}

// 结果提交必须带同一令牌，迟到的旧响应不能释放新操作。
async function finalize(placement, outcome) {
  const now = await db.now();
  const base = 'WHERE node_id = ? AND operation_token = ? AND phase = \'reserved\'';
  let result;
  if (outcome === 'idle') {
    result = await db.prepare(`UPDATE terminal_slots
      SET phase = 'idle', operation_token = '', operation_deadline = NULL,
          idle_deadline = ?, updated_at = ? ${base}`)
      .run(now + IDLE_MS, now, placement.node.id, placement.token);
  } else if (outcome === 'release') {
    result = placement.reused
      ? await db.prepare(`UPDATE terminal_slots
          SET phase = 'idle', operation_token = '', operation_deadline = NULL,
              idle_deadline = ?, updated_at = ? ${base}`)
        .run(now + IDLE_MS, now, placement.node.id, placement.token)
      : await db.prepare(`UPDATE terminal_slots
          SET user_id = NULL, reclaim_user_id = '', phase = 'free', operation_token = '',
              operation_deadline = NULL, idle_deadline = NULL, session_deadline = NULL,
              updated_at = ? ${base}`)
        .run(now, placement.node.id, placement.token);
  } else {
    result = await db.prepare(`UPDATE terminal_slots
      SET phase = 'quarantine', reclaim_user_id = '', operation_deadline = ?, updated_at = ? ${base}`)
      .run(now + QUARANTINE_MS, now, placement.node.id, placement.token);
  }
  if (!result.changes) {
    log('terminal.finalize_stale', { nodeId: placement.node.id, outcome });
  }
  if (outcome === 'quarantine') {
    log('terminal.quarantined', { nodeId: placement.node.id });
  }
  return result.changes > 0;
}

function noteTransportFailure(placement, error) {
  const status = error?.executorState?.status;
  if (status === 503 || status === 504) {
    healthCache.set(placement.node.id, { at: Date.now(), ready: false, capacity: null });
  }
}

async function settled(placement, error) {
  noteTransportFailure(placement, error);
  await finalize(placement, error ? terminal.classifyFailure(error) : 'idle');
}

async function execute(command, req, res, files) {
  const placement = await place(req.userId);
  if (req.aborted || res.destroyed) {
    await finalize(placement, 'release');
    throw new ApiError(499, '终端连接已断开');
  }
  try {
    const result = await terminal.execute(placement.node, command, req, res, files);
    await settled(placement, null);
    return result;
  } catch (error) {
    await settled(placement, error);
    throw error;
  }
}

async function executeStream(value, req, res) {
  const placement = await place(req.userId);
  if (req.aborted || res.destroyed) {
    await finalize(placement, 'release');
    return null;
  }
  const emit = terminal.openStream(res);
  try {
    const result = await terminal.executeStream(placement.node, value, req, res, emit);
    await settled(placement, null);
    return result;
  } catch (error) {
    await settled(placement, error);
    if (res.destroyed || res.writableEnded) return null;
    try {
      await emit({ type: 'error',
        message: error instanceof ApiError ? error.message : '安全终端暂不可用',
        status: error instanceof ApiError ? error.status : 503 });
      res.end();
    } catch { res.destroy(); }
    return null;
  }
}

// reset 取消等待中的回收：保留旧用户清理债，轮换令牌使迟到提交失效。
async function cancelReclaim(row, userId) {
  return db.transaction(async tx => {
    const now = await readNow(tx.prepare);
    await lockCoord(tx, now);
    const token = randomToken();
    const updated = await tx.prepare(`UPDATE terminal_slots
      SET phase = 'quarantine', reclaim_user_id = '', operation_token = ?,
          operation_deadline = ?, updated_at = ?
      WHERE node_id = ? AND user_id = ? AND phase = 'reclaiming'
        AND reclaim_user_id = ? AND operation_token = ?`)
      .run(token, now + QUARANTINE_MS, now, row.node_id, row.user_id, userId,
        row.operation_token);
    return updated.changes > 0 ? 'cancelled' : 'conflict';
  });
}

// 回收只作用于该用户当前绑定的节点。没有绑定时幂等成功。
async function reset(req, res) {
  const nodes = configuration();
  const rows = await db.prepare(
    'SELECT * FROM terminal_slots WHERE user_id = ? OR reclaim_user_id = ? ORDER BY node_id',
  ).all(req.userId, req.userId);
  if (!rows.length) return { ok: true };
  for (const row of rows) {
    // 请求者仍在等待旧用户清理：取消预留，不再派单。
    if (row.user_id !== req.userId && row.reclaim_user_id === req.userId) {
      if (await cancelReclaim(row, req.userId) === 'conflict') {
        throw new ApiError(409, '终端状态已变化，请稍后重试');
      }
      continue;
    }
    const decision = await db.transaction(async tx => {
      const now = await readNow(tx.prepare);
      await lockCoord(tx, now);
      if (row.phase === 'reclaiming') return { kind: 'conflict' };
      const token = randomToken();
      const updated = await tx.prepare(`UPDATE terminal_slots
        SET phase = 'reclaiming', operation_token = ?, operation_deadline = ?, updated_at = ?
        WHERE node_id = ? AND user_id = ? AND phase = ? AND operation_token = ?`)
        .run(token, now + RECLAIM_GRACE_MS, now, row.node_id, req.userId,
          row.phase, row.operation_token);
      return updated.changes ? { kind: 'reset', token } : { kind: 'conflict' };
    });
    if (decision.kind === 'conflict') {
      throw new ApiError(409, '该终端正在执行或回收，请稍后重试');
    }
    const node = nodes.find(entry => entry.id === row.node_id);
    if (!node) {
      await quarantine(row.node_id, decision.token);
      throw new ApiError(503, '终端所在节点已从配置移除，请恢复节点完成清理后再试');
    }
    try {
      await terminal.reset(node, req, res, req.userId);
      healthCache.delete(node.id);
    } catch (error) {
      healthCache.set(node.id, { at: Date.now(), ready: false, capacity: null });
      await quarantine(row.node_id, decision.token);
      throw error;
    }
    const cleared = await db.transaction(async tx => {
      const now = await readNow(tx.prepare);
      await lockCoord(tx, now);
      const updated = await tx.prepare(`UPDATE terminal_slots
        SET user_id = NULL, reclaim_user_id = '', phase = 'free', operation_token = '',
            operation_deadline = NULL, idle_deadline = NULL, session_deadline = NULL,
            updated_at = ?
        WHERE node_id = ? AND phase = 'reclaiming' AND operation_token = ?`)
        .run(now, row.node_id, decision.token);
      return updated.changes > 0;
    });
    if (!cleared) throw new ApiError(409, '终端状态已变化，请稍后重试');
  }
  return { ok: true };
}

function resetState() {
  healthCache.clear();
}

module.exports = {
  configuration,
  metadata,
  execute,
  executeStream,
  reset,
  _place: place,
  _finalize: finalize,
  _completeReclaim: completeReclaim,
  _resetState: resetState,
};
