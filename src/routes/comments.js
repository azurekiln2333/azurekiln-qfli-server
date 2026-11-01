// 评论路由：两级以上树形回复（一个评论可以被另一个用户回复）。
const express = require('express');
const db = require('../db');
const { authRequired } = require('../util');
const { audit } = require('../audit');
const { author } = require('../identity');
const { createId } = require('../entity-id');
const moderation = require('../moderation-service');
const { clientIp } = require('../client-ip');

const router = express.Router();

// 评论可见性：published 公开；pending 只对作者本人与管理员显示。
function visible(comment, viewer, isAdmin) {
  if (comment.status === 'pending') return isAdmin || comment.userId === viewer;
  return comment.status !== 'rejected';
}

async function fetchComments(postId, viewer = null, isAdmin = false) {
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
    const node = {
      id: r.id,
      content: r.content,
      status: r.status || 'published',
      createdAt: r.created_at,
      parentId: r.parent_id,
      userId: r.user_id,
      isMine: viewer != null && r.user_id === viewer,
      author: await author(r.user_id, r.gateway_user_id),
      children: [],
    };
    byId.set(r.id, node);
  }
  for (const node of byId.values()) {
    if (!visible(node, viewer, isAdmin)) continue;
    if (node.parentId && byId.has(node.parentId) && visible(byId.get(node.parentId), viewer, isAdmin)) {
      byId.get(node.parentId).children.push(node);
    } else if (!node.parentId) {
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
  // 评论列表不强制登录；未登录只看到已发布评论。
  res.json({ items: await fetchComments(req.params.id) });
});

// 已登录时带上本人视角（自己的待审评论可见）。
router.get('/posts/:id/comments/mine', authRequired, async (req, res) => {
  res.json({ items: await fetchComments(req.params.id, req.userId, Boolean(req.user?.is_admin)) });
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
  // 评论内容过审核（禁言、限流、IP 规则同样生效）。
  const gate = await moderation.publishGate(req, {
    kind: 'comment',
    ip: clientIp(req),
    fields: [{ scene: 'community.comment', text }],
  });
  const commentId = createId('comments');
  await db
    .prepare(
      'INSERT INTO comments (id, post_id, user_id, parent_id, content, status) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(commentId, postId, req.userId, parent ? parent.id : null, text, gate.status);
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
      status: row.status || 'published',
      createdAt: row.created_at,
      parentId: row.parent_id,
      author: await author(row.user_id, row.gateway_user_id),
      children: [],
    },
  });
  audit(req, {
    action: 'comment.create',
    target: `post:${postId}${parent ? ` comment:${parent.id}` : ''}`,
    detail: `${text.slice(0, 200)} status=${gate.status}`,
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
