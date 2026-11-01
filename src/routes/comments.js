// 评论路由：两级以上树形回复（一个评论可以被另一个用户回复）。
const express = require('express');
const db = require('../db');
const { authRequired } = require('../util');
const { audit } = require('../audit');
const { author } = require('../identity');
const { createId } = require('../entity-id');

const router = express.Router();

async function fetchComments(postId) {
  const rows = await db
    .prepare(
      `SELECT c.*, u.gateway_user_id
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.post_id = ? ORDER BY c.created_at ASC`,
    )
    .all(postId);
  const byId = new Map();
  const roots = [];
  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      content: r.content,
      createdAt: r.created_at,
      parentId: r.parent_id,
      author: await author(r.user_id, r.gateway_user_id),
      children: [],
    });
  }
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }
  // 回复按时间正序，根评论时间正序。
  const sortRec = (list) => {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    list.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

router.get('/posts/:id/comments', async (req, res) => {
  res.json({ items: await fetchComments(req.params.id) });
});

router.post('/posts/:id/comments', authRequired, async (req, res) => {
  const postId = req.params.id;
  const post = await db.prepare('SELECT id FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: '内容不存在' });
  const { content, parentId } = req.body || {};
  const text = (content || '').trim();
  if (text.length < 1 || text.length > 2000) {
    return res.status(400).json({ error: '评论需为 1-2000 字' });
  }
  let parent = null;
  if (parentId) {
    parent = await db
      .prepare('SELECT id, post_id FROM comments WHERE id = ?')
      .get(typeof parentId === 'string' ? parentId : '');
    if (!parent || parent.post_id !== postId) {
      return res.status(400).json({ error: '回复目标不存在' });
    }
  }
  const commentId = createId('comments');
  await db
    .prepare(
      'INSERT INTO comments (id, post_id, user_id, parent_id, content) VALUES (?, ?, ?, ?, ?)',
    )
    .run(commentId, postId, req.userId, parent ? parent.id : null, text);
  const row = await db
    .prepare(
      `SELECT c.*, u.gateway_user_id
       FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
    )
    .get(commentId);
  res.json({
    comment: {
      id: row.id,
      content: row.content,
      createdAt: row.created_at,
      parentId: row.parent_id,
      author: await author(row.user_id, row.gateway_user_id),
      children: [],
    },
  });
  audit(req, {
    action: 'comment.create',
    target: `post:${postId}${parent ? ` comment:${parent.id}` : ''}`,
    detail: text.slice(0, 200),
  });
});

router.delete('/comments/:id', authRequired, async (req, res) => {
  const comment = await db
    .prepare('SELECT user_id FROM comments WHERE id = ?')
    .get(req.params.id);
  if (!comment) return res.status(404).json({ error: '评论不存在' });
  if (comment.user_id !== req.userId) {
    return res.status(403).json({ error: '只能删除自己的评论' });
  }
  audit(req, { action: 'comment.delete', target: `comment:${req.params.id}` });
  await db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
