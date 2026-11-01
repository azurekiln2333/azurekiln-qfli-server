const { test } = require('node:test');
const assert = require('node:assert/strict');
const gateway = require('../src/gateway');

const saved = Object.fromEntries([
  'AZK_OAUTH2_BASE_URL', 'AZK_OAUTH2_CLIENT_ID', 'AZK_OAUTH2_CLIENT_SECRET',
  'AZK_OAUTH2_REDIRECT_URI', 'PUBLIC_BASE_URL'
].map(key => [key, process.env[key]]));

function configure() {
  process.env.AZK_OAUTH2_BASE_URL = 'https://gateway.example.test';
  process.env.AZK_OAUTH2_CLIENT_ID = 'qfli-client';
  process.env.AZK_OAUTH2_CLIENT_SECRET = 'test-client-secret';
  process.env.AZK_OAUTH2_REDIRECT_URI = 'https://app.example.test/api/auth/oauth2/callback';
  process.env.PUBLIC_BASE_URL = 'https://app.example.test';
}

function restore() {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('unmatched Huawei login waits for a decision; skip resumes the same OAuth exchange', async () => {
  configure();
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path.endsWith('/quick-login')) {
      return Response.json({ binding_required: true, binding_token: 'pending-secret', phone_available: false });
    }
    if (path.endsWith('/skip')) {
      const body = JSON.parse(options.body);
      assert.equal(body.binding_token, 'pending-secret');
      assert.equal(body.client_id, 'qfli-client');
      return Response.json({ redirect: `${body.redirect_uri}?code=gateway-code&state=${body.state}` });
    }
    if (path.endsWith('/token')) return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh' });
    if (path.endsWith('/userinfo')) return Response.json({ sub: 'new-gateway-user' });
    throw new Error(`Unexpected path ${path}`);
  };
  try {
    const pending = await gateway.authorize('huawei', { code: 'one-use-code' }, {});
    assert.equal(pending.binding, 'pending-secret');
    assert.equal(pending.phoneAvailable, false);
    assert.deepEqual(calls, ['/api/v1/auth/oauth/huawei/quick-login']);
    const result = await gateway.skipHuawei(pending);
    assert.equal(result.claims.sub, 'new-gateway-user');
    assert.deepEqual(calls.slice(1), ['/api/v1/auth/oauth/huawei/skip', '/oauth2/token', '/oauth2/userinfo']);
  } finally {
    global.fetch = originalFetch;
    restore();
  }
});

test('binding sends only a verified existing account token to the gateway', async () => {
  configure();
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path.endsWith('/quick-login')) return Response.json({ binding_required: true, binding_token: 'pending-secret' });
    if (path.endsWith('/authorize')) {
      const body = JSON.parse(options.body);
      assert.equal(body.username, 'existing');
      assert.equal(body.password, 'correct-password');
      return Response.json({ redirect: `${body.redirect_uri}?code=existing-code&state=${body.state}` });
    }
    if (path.endsWith('/token')) return Response.json({ access_token: 'existing-access', refresh_token: 'existing-refresh' });
    if (path.endsWith('/userinfo')) return Response.json({ sub: 'existing-gateway-user' });
    if (path.endsWith('/bind')) {
      assert.equal(options.headers.authorization, 'Bearer existing-access');
      assert.deepEqual(JSON.parse(options.body), { binding_token: 'pending-secret' });
      return Response.json({ linked: true });
    }
    throw new Error(`Unexpected path ${path}`);
  };
  try {
    const pending = await gateway.authorize('huawei', { code: 'one-use-code' }, {});
    const result = await gateway.bindHuawei(pending, { username: 'existing', password: 'correct-password' }, {});
    assert.equal(result.claims.sub, 'existing-gateway-user');
    assert.deepEqual(calls, [
      '/api/v1/auth/oauth/huawei/quick-login', '/oauth2/authorize', '/oauth2/token',
      '/oauth2/userinfo', '/api/v1/auth/oauth/huawei/bind'
    ]);
  } finally {
    global.fetch = originalFetch;
    restore();
  }
});

test('Huawei MFA exchanges the authorization response directly without a browser session', async () => {
  configure();
  const originalFetch = global.fetch;
  const calls = [];
  let authorization;
  global.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path.endsWith('/quick-login')) {
      authorization = JSON.parse(options.body);
      return Response.json({ mfa_required: true, pending_token: 'pending-mfa', factor: 'totp' });
    }
    if (path.endsWith('/oidc/complete')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['X-Oidc-Pending'], 'pending-mfa');
      assert.deepEqual(JSON.parse(options.body), { code: '123456' });
      return Response.json({
        authorization_code: 'mfa-code', state: authorization.state,
        redirect_uri: authorization.redirect_uri,
        redirect: `${authorization.redirect_uri}?code=mfa-code&state=${authorization.state}`,
      });
    }
    if (path.endsWith('/token')) {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('code'), 'mfa-code');
      assert.equal(form.get('redirect_uri'), authorization.redirect_uri);
      assert.equal(form.get('client_id'), authorization.client_id);
      const challenge = require('node:crypto').createHash('sha256')
        .update(form.get('code_verifier')).digest('base64url');
      assert.equal(challenge, authorization.code_challenge);
      return Response.json({ access_token: 'mfa-access', refresh_token: 'mfa-refresh' });
    }
    if (path.endsWith('/userinfo')) {
      assert.equal(options.headers.authorization, 'Bearer mfa-access');
      return Response.json({ sub: 'mfa-user' });
    }
    throw new Error(`Unexpected path ${path}`);
  };
  try {
    const pending = await gateway.authorize('huawei', { code: 'one-use-code' }, {});
    const result = await gateway.completeHuawei(pending, '123456');
    assert.equal(result.claims.sub, 'mfa-user');
    assert.equal(result.tokens.access_token, 'mfa-access');
    assert.deepEqual(calls, [
      '/api/v1/auth/oauth/huawei/quick-login', '/api/v1/auth/oauth/oidc/complete',
      '/oauth2/token', '/oauth2/userinfo',
    ]);
  } finally {
    global.fetch = originalFetch;
    restore();
  }
});

for (const invalid of ['missing_redirect', 'wrong_origin', 'wrong_path', 'wrong_state', 'missing_code']) {
  test(`Huawei MFA rejects ${invalid} before exchanging a token`, async () => {
    configure();
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url) => {
      calls.push(new URL(url).pathname);
      const redirect = new URL('https://app.example.test/api/auth/oauth2/callback?code=mfa-code&state=expected-state');
      if (invalid === 'wrong_origin') redirect.hostname = 'other.example.test';
      if (invalid === 'wrong_path') redirect.pathname = '/other-callback';
      if (invalid === 'wrong_state') redirect.searchParams.set('state', 'wrong-state');
      if (invalid === 'missing_code') redirect.searchParams.delete('code');
      return Response.json(invalid === 'missing_redirect' ? {} : { redirect: redirect.toString() });
    };
    try {
      await assert.rejects(gateway.completeHuawei({
        pending: { pending_token: 'pending-mfa' },
        params: { client_id: 'qfli-client' },
        cfg: gateway.config(), state: 'expected-state', verifier: 'original-verifier',
      }, '123456'), error => error.status === 502 && error.details.errorKey ===
        (invalid === 'missing_redirect' ? 'gateway.redirect_missing' : 'gateway.redirect_invalid'));
      assert.deepEqual(calls, ['/api/v1/auth/oauth/oidc/complete']);
    } finally {
      global.fetch = originalFetch;
      restore();
    }
  });
}

test('Huawei MFA preserves a rejected verification without requesting a token', async () => {
  configure();
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(new URL(url).pathname);
    return Response.json({ error: 'invalid_grant', error_key: 'auth.mfa.invalid',
      error_description: 'Verification code is invalid' }, { status: 400 });
  };
  try {
    await assert.rejects(gateway.completeHuawei({ pending: { pending_token: 'pending-mfa' } }, '123456'),
      error => error.status === 400 && error.details.errorKey === 'auth.mfa.invalid');
    assert.deepEqual(calls, ['/api/v1/auth/oauth/oidc/complete']);
  } finally {
    global.fetch = originalFetch;
    restore();
  }
});
