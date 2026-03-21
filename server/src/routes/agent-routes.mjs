import crypto from 'crypto';

/**
 * 注册 Agent 相关路由。
 * @param {object} context
 */
export function registerAgentRoutes(context) {
  const { router, auth, db, sendJson, formatAgent, rateLimiter } = context;
  const { addRoute } = router;
  const { authAgent } = auth;

  /** POST /api/v1/agents/register - 注册 Agent（需邀请码，每 IP 每小时限 5 次） */
  addRoute('POST', '/api/v1/agents/register', async (req, res) => {
    const ip = req.socket?.remoteAddress || 'unknown';
    if (rateLimiter.isRegisterRateLimited(ip)) {
      return sendJson(res, 429, { error: 'Too many registration attempts. Try again later.' });
    }

    const { name, description, inviteCode, metadata } = req.body;
    if (!name || !inviteCode) {
      return sendJson(res, 400, { error: 'name and inviteCode required' });
    }

    const invite = db.get(`SELECT * FROM invite_codes WHERE code = ${db.esc(inviteCode)}`);
    if (!invite) return sendJson(res, 403, { error: 'Invalid invite code' });
    if (invite.revoked) return sendJson(res, 403, { error: 'Invite code has been revoked' });
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      return sendJson(res, 403, { error: 'Invite code has expired' });
    }
    if (invite.max_uses > 0 && invite.uses_count >= invite.max_uses) {
      return sendJson(res, 403, { error: 'Invite code has been fully used' });
    }

    if (db.get(`SELECT id FROM agents WHERE name = ${db.esc(name)}`)) {
      return sendJson(res, 409, { error: 'Agent name already taken' });
    }

    const id = crypto.randomUUID();
    const apiKey = `af_${crypto.randomBytes(32).toString('hex')}`;
    const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const now = new Date().toISOString();

    db.exec(`INSERT INTO agents (id, name, description, api_key_hash, invite_code_id, status, metadata, created_at, last_seen_at)
      VALUES (${db.esc(id)}, ${db.esc(name)}, ${db.esc(description || null)}, ${db.esc(apiKeyHash)}, ${db.esc(invite.id)}, 'active', ${db.esc(metadata ? JSON.stringify(metadata) : null)}, ${db.esc(now)}, ${db.esc(now)})`);

    db.exec(`UPDATE invite_codes SET uses_count = uses_count + 1, used_by = ${db.esc(id)} WHERE id = ${db.esc(invite.id)}`);

    const agent = db.get(`SELECT * FROM agents WHERE id = ${db.esc(id)}`);
    console.log(`✅ Agent registered: ${name}`);
    return sendJson(res, 201, { agent: formatAgent(agent), apiKey });
  });

  /** GET /api/v1/agents/me - 获取当前 Agent 信息 */
  addRoute('GET', '/api/v1/agents/me', authAgent, (req, res) => {
    sendJson(res, 200, formatAgent(req.agent));
  });

  /** PATCH /api/v1/agents/me - 更新当前 Agent */
  addRoute('PATCH', '/api/v1/agents/me', authAgent, (req, res) => {
    const { name, description, metadata } = req.body;
    const sets = [];

    if (name !== undefined) sets.push(`name = ${db.esc(name)}`);
    if (description !== undefined) sets.push(`description = ${db.esc(description)}`);
    if (metadata !== undefined) sets.push(`metadata = ${db.esc(JSON.stringify(metadata))}`);

    if (sets.length > 0) {
      db.exec(`UPDATE agents SET ${sets.join(', ')} WHERE id = ${db.esc(req.agent.id)}`);
    }

    const updated = db.get(`SELECT * FROM agents WHERE id = ${db.esc(req.agent.id)}`);
    sendJson(res, 200, formatAgent(updated));
  });

  /** GET /api/v1/agents - 列出所有 Agent */
  addRoute('GET', '/api/v1/agents', authAgent, (req, res) => {
    sendJson(res, 200, db.all('SELECT * FROM agents').map(formatAgent));
  });

  /** GET /api/v1/agents/:id - 获取指定 Agent */
  addRoute('GET', '/api/v1/agents/:id', authAgent, (req, res) => {
    const agent = db.get(`SELECT * FROM agents WHERE id = ${db.esc(req.params.id)}`);
    if (!agent) return sendJson(res, 404, { error: 'Agent not found' });
    sendJson(res, 200, formatAgent(agent));
  });
}
