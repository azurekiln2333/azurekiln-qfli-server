// Online terminal requests cross a separate, fail-closed execution boundary.
const express = require('express');
const { authRequired } = require('../util');
const { audit, terminalRateLimited } = require('../audit');
const terminal = require('../terminal-client');
const pool = require('../terminal-pool');

const router = express.Router();

function admit(req, res, next) {
  req.terminalRequest = terminal.validateRequest(req.body);
  if (terminalRateLimited(req.userId)) {
    return res.status(429).json({ error: '命令执行过于频繁，请稍后再试' });
  }
  next();
}

router.post('/exec', authRequired, admit, async (req, res) => {
  const { command, files } = req.terminalRequest;
  let result;
  try {
    result = await pool.execute(command, req, res, files);
  } catch (error) {
    if (res.destroyed) return;
    throw error;
  }
  await audit(req, { action: 'terminal.exec', target: `terminal:${req.userId}`,
    detail: `length=${command.length} exit=${result.exitCode}` });
  if (!res.destroyed) res.json(result);
});

router.post('/exec/stream', authRequired, admit, async (req, res) => {
  const result = await pool.executeStream(req.terminalRequest, req, res);
  if (!res.destroyed && !res.writableEnded) res.end();
  if (result) {
    await audit(req, { action: 'terminal.exec', target: `terminal:${req.userId}`,
      detail: `length=${req.terminalRequest.command.length} exit=${result.exitCode}` });
  }
});

router.get('/pwd', authRequired, (_req, res) => {
  const info = pool.metadata();
  res.json({ cwd: '/workspace', persistent: false,
    workspaceMiB: info.workspaceMiB, idleSeconds: info.idleSeconds,
    lifetimeSeconds: info.lifetimeSeconds, nodes: info.nodes,
    sessionsPerNode: info.sessionsPerNode,
    queueLimit: 8, queueWaitSeconds: 20 });
});

router.delete('/session', authRequired, async (req, res) => {
  let result;
  try {
    result = await pool.reset(req, res);
  } catch (error) {
    if (res.destroyed) return;
    throw error;
  }
  await audit(req, { action: 'terminal.reset', target: `terminal:${req.userId}` });
  if (!res.destroyed) res.json(result);
});

module.exports = router;