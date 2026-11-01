module.exports = function installQfliIntegration({
  app, asyncHandler, authenticateClient, validateToken, getModels,
  isClientActive, isUserBanned, scopedUserClaims,
}) {
  async function accessUser(req, res) {
    const { Token, Client, User } = getModels();
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const decoded = validateToken(token, 'access');
    const row = decoded && await Token.findAccessTokenById(decoded.jti);
    const client = row && await Client.findById(row.client_id);
    if (!decoded || !Token.matchesToken(row, token) || !isClientActive(client) ||
        row.client_id !== decoded.aud || row.user_id !== decoded.sub ||
        new Date(row.expires_at).getTime() <= Date.now()) {
      res.status(401).json({ error: 'invalid_token', error_description: '登录令牌已失效' });
      return null;
    }
    if (!row.scopes.includes('openid') || !row.scopes.includes('profile')) {
      res.status(403).json({ error: 'insufficient_scope', error_description: '需要 openid 和 profile 权限' });
      return null;
    }
    const user = await User.findById(decoded.sub);
    if (!user || isUserBanned(user)) {
      res.status(403).json({ error: 'access_denied', error_description: '账号不存在或已停用' });
      return null;
    }
    return { user, scopes: row.scopes };
  }

  app.put('/oauth2/profile', asyncHandler(async (req, res) => {
    const { User } = getModels();
    const authenticated = await accessUser(req, res);
    if (!authenticated) return;
    const input = req.body || {};
    if (Object.keys(input).some((key) => !['name', 'description'].includes(key))) {
      return res.status(400).json({ error: 'invalid_request', error_description: '此接口仅支持昵称和简介' });
    }
    const updates = {};
    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 64) {
        return res.status(400).json({ error: 'invalid_request', error_description: '昵称需为 1-64 字' });
      }
      updates.name = input.name.trim();
    }
    if (input.description !== undefined) {
      if (typeof input.description !== 'string' || input.description.length > 200) {
        return res.status(400).json({ error: 'invalid_request', error_description: '简介不能超过 200 字' });
      }
      updates.description = input.description;
    }
    await User.update(authenticated.user.id, updates);
    const user = await User.findById(authenticated.user.id);
    res.json({ ...scopedUserClaims(user, authenticated.scopes), description: user.description || '' });
  }));

  app.get('/oauth2/public-profile/:id', asyncHandler(async (req, res) => {
    const { User } = getModels();
    req.body ||= {};
    const client = await authenticateClient(req, res);
    if (!client) return;
    if (!client.scopes.includes('qfli_public_profile')) {
      return res.status(403).json({ error: 'insufficient_scope', error_description: '此客户端未获准读取社区作者资料' });
    }
    const user = await User.findById(req.params.id);
    if (!user || isUserBanned(user)) return res.status(404).json({ error: 'user_not_found' });
    res.set('Cache-Control', 'no-store');
    res.json({ ...scopedUserClaims(user, ['profile']), description: user.description || '' });
  }));
};
