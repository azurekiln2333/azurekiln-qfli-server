// Cloud SQL practice runs in the separate sqlbox mysqld, never the business DB.
const express = require('express');
const { authRequired } = require('../util');
const { audit } = require('../audit');
const sqlbox = require('../sqlbox');

const router = express.Router();

router.get('/info', authRequired, async (req, res) => {
  res.json(await sqlbox.info(req.userId));
});

router.post('/query', authRequired, async (req, res) => {
  res.json(await sqlbox.execute(req.userId, req.body));
});

router.post('/script', authRequired, async (req, res) => {
  const result = await sqlbox.execute(req.userId, req.body, { script: true });
  await audit(req, { action: 'sql.script', target: `sql:${req.userId}`,
    detail: `length=${req.body.source.length} exit=${result.exitCode}` });
  res.json(result);
});

router.delete('/databases', authRequired, async (req, res) => {
  const result = await sqlbox.reset(req.userId);
  await audit(req, { action: 'sql.reset', target: `sql:${req.userId}`, detail: `dropped=${result.dropped}` });
  res.json(result);
});

module.exports = router;
