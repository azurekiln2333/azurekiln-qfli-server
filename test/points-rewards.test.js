const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.DB_DRIVER = 'sqlite';
process.env.QFLI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qfli-points-'));
const userId = 'user_11111111111111111111111111111111';

const utilPath = require.resolve('../src/util');
require.cache[utilPath] = {
  id: utilPath, filename: utilPath, loaded: true, exports: {
    authRequired(req, _res, next) {
      req.userId = userId;
      req.user = { id: userId, username: 'test', is_admin: req.get('x-test-admin') === 'yes' };
      next();
    },
    publicUser: async () => ({}),
  },
};

const db = require('../src/db');
const router = require('../src/routes/users');
const { ApiError } = require('../src/gateway');

test('daily activity, check-in and redemption keep balances and history consistent', async t => {
  await db.ready;
  await db.prepare('INSERT INTO users (id, gateway_user_id) VALUES (?, ?)').run(userId, 'test-sub');
  await db.prepare('INSERT INTO user_state (user_id) VALUES (?)').run(userId);

  for (const layer of router.stack) {
    for (const handler of layer.route ? layer.route.stack : [layer]) {
      const original = handler.handle;
      if (original.length === 4) continue;
      handler.handle = (req, res, next) => {
        try { Promise.resolve(original(req, res, next)).catch(next); } catch (error) { next(error); }
      };
    }
  }
  const app = express();
  app.use(express.json());
  app.use('/api/users', router);
  app.use((error, _req, res, _next) => res.status(error instanceof ApiError ? error.status : 500)
    .json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(process.env.QFLI_DATA_DIR, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api/users`;
  async function request(method, endpoint, body, admin = false) {
    const response = await fetch(base + endpoint, {
      method, headers: { 'content-type': 'application/json', ...(admin ? { 'x-test-admin': 'yes' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  }

  const initial = await request('GET', '/me/tasks');
  assert.equal(initial.data.tasks.length, 10);
  assert.equal(initial.data.streak, 0);
  const event = (key, number) => request('POST', '/me/task-events', {
    key, eventId: `event_${number.toString(16).padStart(32, '0')}`,
  });
  const createdOnce = await event('create_project', 1);
  assert.equal(createdOnce.data.points, 10);
  assert.equal(createdOnce.data.tasks.find(task => task.key === 'create_project_5').progress, 1);
  assert.equal((await event('create_project', 1)).data.duplicate, true);
  for (let n = 2; n <= 5; n++) await event('create_project', n);
  assert.equal((await request('GET', '/me/tasks')).data.tasks.find(task => task.key === 'create_project_5').done, true);
  for (let n = 6; n <= 10; n++) await event('create_project', n);
  assert.equal((await request('GET', '/me/tasks')).data.tasks.find(task => task.key === 'create_project_10').progress, 10);
  assert.equal((await request('GET', '/me/points')).data.points, 70);
  assert.equal((await request('POST', '/me/task-events', {
    key: 'create_project', eventId: 'event_ffffffffffffffffffffffffffffffff', day: '2026-02-30',
  })).status, 400);
  assert.equal((await request('POST', '/me/checkin')).data.points, 75);
  assert.equal((await request('POST', '/me/checkin')).data.alreadyChecked, true);
  assert.equal((await request('GET', '/me/tasks')).data.growth.experience, 75);

  const date = new Date();
  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  assert.equal((await request('GET', `/me/checkins?month=${month}`)).data.days.length, 1);
  assert.equal((await request('GET', '/admin/tasks')).status, 403);

  assert.equal((await request('PATCH', '/admin/tasks/open_project', {
    reward: 7, enabled: true, targetCount: 2,
  }, true)).status, 200);
  assert.equal((await event('open_project', 11)).data.awarded, false);
  assert.equal((await event('open_project', 12)).data.points, 82);
  assert.equal((await request('PATCH', '/admin/tasks/save_file', {
    reward: 5, enabled: false, targetCount: 1,
  }, true)).status, 200);
  assert.equal((await event('save_file', 13)).data.awarded, false);

  const created = await request('POST', '/admin/rewards', {
    title: '测试兑换', description: '人工交付', cost: 12, stock: 1,
  }, true);
  assert.equal(created.status, 200);
  const rewardId = created.data.id;
  const concurrent = await Promise.all([
    request('POST', `/me/rewards/${rewardId}/redeem`),
    request('POST', `/me/rewards/${rewardId}/redeem`),
  ]);
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 404]);
  assert.equal(concurrent.find(result => result.status === 200).data.points, 70);
  const ledger = (await request('GET', '/me/points')).data;
  assert.equal(ledger.points, 70);
  assert.equal((await request('GET', '/me/tasks')).data.growth.experience, 82);
  assert.deepEqual(ledger.entries.map(entry => entry.amount).sort((a, b) => a - b), [-12, 5, 7, 10, 20, 40]);
  assert.equal((await request('GET', '/me/redemptions')).data.items[0].status, 'pending');
  const orderId = (await request('GET', '/admin/redemptions', null, true)).data.items[0].id;
  assert.equal((await request('PATCH', `/admin/redemptions/${orderId}`, { status: 'fulfilled' }, true)).status, 200);
  assert.equal((await request('GET', '/me/redemptions')).data.items[0].status, 'fulfilled');

  const costly = await request('POST', '/admin/rewards', {
    title: '高价项', description: '', cost: 100, stock: -1,
  }, true);
  assert.equal((await request('POST', `/me/rewards/${costly.data.id}/redeem`)).status, 409);
  assert.equal((await request('GET', '/me/points')).data.points, 70);
});
