// 社区路由：专区、标签、帖子（教程/讨论）、点赞。
const express = require('express');
const db = require('../db');
const { authOptional, authRequired } = require('../util');
const { audit } = require('../audit');
const { author } = require('../identity');
const { createId } = require('../entity-id');
const moderation = require('../moderation-service');
const { clientIp } = require('../client-ip');

const router = express.Router();

router.get('/zones', async (_req, res) => {
  const rows = await db.prepare('SELECT * FROM zones ORDER BY sort').all();
  res.json({
    items: rows.map((z) => ({ id: z.id, key: z.key, name: z.name })),
  });
});

router.get('/tags', async (req, res) => {
  const { type, zoneId } = req.query;
  const where = [];
  const params = [];
  if (type === 'tutorial' || type === 'discussion') {
    where.push('p.type = ?');
    params.push(type);
  }
  if (zoneId) {
    where.push('p.zone_id = ?');
    params.push(String(zoneId));
  }
  const sql = `
    SELECT pt.tag AS tag, COUNT(*) AS count
    FROM post_tags pt
    JOIN posts p ON p.id = pt.post_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY pt.tag ORDER BY count DESC LIMIT 30`;
  res.json({ items: await db.prepare(sql).all(...params) });
});

const POST_SUMMARY_SELECT = `
  SELECT p.id, p.type, p.title, p.content, p.created_at, p.updated_at,
         p.user_id, p.status, u.gateway_user_id,
         z.name AS zone_name, z.id AS zone_id,
         (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
         (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
  FROM posts p
  JOIN users u ON u.id = p.user_id
  JOIN zones z ON z.id = p.zone_id`;

async function mapSummary(r, userId) {
  const tags = (
    await db.prepare('SELECT tag FROM post_tags WHERE post_id = ?').all(r.id)
  ).map((t) => t.tag);
  const liked = userId
    ? !!(await db
        .prepare('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?')
        .get(r.id, userId))
    : false;
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    status: r.status || 'published',
    excerpt: r.content.length > 120 ? `${r.content.slice(0, 120)}…` : r.content,
    tags,
    zoneId: r.zone_id,
    zoneName: r.zone_name,
    author: await author(r.user_id, r.gateway_user_id),
    likeCount: r.like_count,
    commentCount: r.comment_count,
    liked,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

router.get('/posts', authOptional, async (req, res) => {
  const { type, tag, q } = req.query;
  const zone = req.query.zoneId || req.query.zone;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(5, Number(req.query.pageSize) || 20));
  const where = [];
  const params = [];
  // 先审后发：pending 只对作者本人与管理员可见，其他人只看 published。
  // 管理员需要看到待审列表并处置，因此列表和详情都按其视角放开 pending。
  if (req.user?.is_admin) {
    where.push("p.status IN ('published', 'pending')");
  } else if (req.userId) {
    where.push("(p.status = 'published' OR (p.status = 'pending' AND p.user_id = ?))");
    params.push(req.userId);
  } else {
    where.push("p.status = 'published'");
  }
  if (type === 'tutorial' || type === 'discussion') {
    where.push('p.type = ?');
    params.push(type);
  }
  if (zone) {
    where.push('p.zone_id = ?');
    params.push(String(zone));
  }
  if (tag) {
    where.push('p.id IN (SELECT post_id FROM post_tags WHERE tag = ?)');
    params.push(String(tag));
  }
  if (q) {
    where.push('(p.title LIKE ? OR p.content LIKE ?)');
    const like = `%${String(q).slice(0, 64)}%`;
    params.push(like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    await db.prepare(`SELECT COUNT(*) AS n FROM posts p ${whereSql}`).get(...params)
  ).n;
  const rows = await db
    .prepare(
      `${POST_SUMMARY_SELECT} ${whereSql} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  res.json({
    items: await Promise.all(rows.map((r) => mapSummary(r, req.userId))),
    total,
    page,
    pageSize,
  });
});

router.get('/posts/:id', authOptional, async (req, res) => {
  const row = await db
    .prepare(`${POST_SUMMARY_SELECT} WHERE p.id = ?`)
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: '内容不存在' });
  if (row.status !== 'published' && row.user_id !== req.userId && !req.user?.is_admin) {
    return res.status(404).json({ error: '内容不存在' });
  }
  res.json({ post: { ...(await mapSummary(row, req.userId)), content: row.content } });
});

router.post('/posts', authRequired, async (req, res) => {
  const { type, zoneId, title, content, tags } = req.body || {};
  if (type !== 'tutorial' && type !== 'discussion') {
    return res.status(400).json({ error: '类型必须是 tutorial 或 discussion' });
  }
  const zone = await db.prepare('SELECT id FROM zones WHERE id = ?').get(typeof zoneId === 'string' ? zoneId : '');
  if (!zone) return res.status(400).json({ error: '请选择专区' });
  const trimmedTitle = (title || '').trim();
  if (trimmedTitle.length < 2 || trimmedTitle.length > 80) {
    return res.status(400).json({ error: '标题需为 2-80 字' });
  }
  const trimmedContent = (content || '').trim();
  if (trimmedContent.length < 5 || trimmedContent.length > 50000) {
    return res.status(400).json({ error: '内容需为 5-50000 字' });
  }
  const cleanTags = [...new Set((tags || []))]
    .map((t) => String(t).replace(/^#/, '').trim())
    .filter((t) => t.length > 0 && t.length <= 16)
    .slice(0, 5);
  // 标题、正文、标签都要过审核；先审后发开启时落库为 pending。
  const gate = await moderation.publishGate(req, {
    kind: 'post',
    ip: clientIp(req),
    fields: [
      { scene: 'community.post.title', text: trimmedTitle },
      { scene: 'community.post.content', text: trimmedContent },
      ...cleanTags.map((tag) => ({ scene: 'community.post.tag', text: tag })),
    ],
  });
  const postId = createId('posts');
  await db
    .prepare(
      'INSERT INTO posts (id, user_id, type, zone_id, title, content, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(postId, req.userId, type, zone.id, trimmedTitle, trimmedContent, gate.status);
  const insertTag = db.prepare('INSERT INTO post_tags (post_id, tag) VALUES (?, ?)');
  for (const t of cleanTags) await insertTag.run(postId, t);
  audit(req, { action: 'post.create', target: `post:${postId}`, detail: `${type} ${trimmedTitle} status=${gate.status}` });
  res.json({ id: postId, status: gate.status });
});

router.delete('/posts/:id', authRequired, async (req, res) => {
  const post = await db
    .prepare('SELECT user_id FROM posts WHERE id = ?')
    .get(req.params.id);
  if (!post) return res.status(404).json({ error: '内容不存在' });
  if (post.user_id !== req.userId) {
    return res.status(403).json({ error: '只能删除自己的内容' });
  }
  audit(req, { action: 'post.delete', target: `post:${req.params.id}` });
  await db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/posts/:id/like', authRequired, async (req, res) => {
  const postId = req.params.id;
  const post = await db.prepare('SELECT id FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: '内容不存在' });
  const liked = !!(await db
    .prepare('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?')
    .get(postId, req.userId));
  if (liked) {
    await db.prepare('DELETE FROM likes WHERE post_id = ? AND user_id = ?').run(
      postId,
      req.userId,
    );
  } else {
    await db.prepare('INSERT INTO likes (post_id, user_id) VALUES (?, ?)').run(
      postId,
      req.userId,
    );
  }
  audit(req, { action: liked ? 'post.unlike' : 'post.like', target: `post:${postId}` });
  const likeCount = (
    await db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').get(postId)
  ).n;
  res.json({ liked: !liked, likeCount });
});

module.exports = router;
