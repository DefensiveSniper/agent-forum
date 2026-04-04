import crypto from 'crypto';
import { VALID_PROFICIENCIES } from '../../shared/capabilities/constants.mjs';

/**
 * 注册 Agent 相关路由。
 * @param {object} context
 */
export function registerAgentRoutes(context) {
  const { router, auth, db, sendJson, formatAgent, rateLimiter, ws } = context;
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

  /** POST /api/v1/agents/me/capabilities - 注册/更新自身能力 */
  addRoute('POST', '/api/v1/agents/me/capabilities', authAgent, (req, res) => {
    const { capability, proficiency, description } = req.body;
    if (!capability || typeof capability !== 'string') {
      return sendJson(res, 400, { error: 'capability is required' });
    }
    const prof = proficiency || 'standard';
    if (!VALID_PROFICIENCIES.has(prof)) {
      return sendJson(res, 400, { error: `proficiency must be one of: ${[...VALID_PROFICIENCIES].join(', ')}` });
    }

    const existing = db.get(`SELECT id FROM agent_capabilities
      WHERE agent_id = ${db.esc(req.agent.id)} AND capability = ${db.esc(capability)}`);

    const now = new Date().toISOString();
    if (existing) {
      db.exec(`UPDATE agent_capabilities
        SET proficiency = ${db.esc(prof)}, description = ${db.esc(description || null)}, registered_at = ${db.esc(now)}
        WHERE id = ${db.esc(existing.id)}`);
      const updated = db.get(`SELECT * FROM agent_capabilities WHERE id = ${db.esc(existing.id)}`);
      return sendJson(res, 200, updated);
    }

    const id = crypto.randomUUID();
    db.exec(`INSERT INTO agent_capabilities (id, agent_id, capability, proficiency, description, registered_at)
      VALUES (${db.esc(id)}, ${db.esc(req.agent.id)}, ${db.esc(capability)}, ${db.esc(prof)}, ${db.esc(description || null)}, ${db.esc(now)})`);
    const created = db.get(`SELECT * FROM agent_capabilities WHERE id = ${db.esc(id)}`);
    sendJson(res, 201, created);
  });

  /** GET /api/v1/agents/me/capabilities - 查看自身已注册能力 */
  addRoute('GET', '/api/v1/agents/me/capabilities', authAgent, (req, res) => {
    sendJson(res, 200, db.all(`SELECT * FROM agent_capabilities
      WHERE agent_id = ${db.esc(req.agent.id)} ORDER BY registered_at DESC`));
  });

  /** DELETE /api/v1/agents/me/capabilities/:capId - 移除自身某项能力 */
  addRoute('DELETE', '/api/v1/agents/me/capabilities/:capId', authAgent, (req, res) => {
    const cap = db.get(`SELECT id FROM agent_capabilities
      WHERE id = ${db.esc(req.params.capId)} AND agent_id = ${db.esc(req.agent.id)}`);
    if (!cap) return sendJson(res, 404, { error: 'Capability not found' });

    db.exec(`DELETE FROM agent_capabilities WHERE id = ${db.esc(req.params.capId)}`);
    res.writeHead(204).end();
  });

  /** GET /api/v1/agents/:id/capabilities - 查看某 Agent 的能力列表 */
  addRoute('GET', '/api/v1/agents/:id/capabilities', authAgent, (req, res) => {
    const agent = db.get(`SELECT id FROM agents WHERE id = ${db.esc(req.params.id)}`);
    if (!agent) return sendJson(res, 404, { error: 'Agent not found' });

    sendJson(res, 200, db.all(`SELECT * FROM agent_capabilities
      WHERE agent_id = ${db.esc(req.params.id)} ORDER BY registered_at DESC`));
  });

  /** GET /api/v1/capabilities - 列出平台能力目录 */
  addRoute('GET', '/api/v1/capabilities', authAgent, (req, res) => {
    const catalog = db.all('SELECT * FROM capability_catalog ORDER BY category, name');
    sendJson(res, 200, catalog);
  });

  /** GET /api/v1/capabilities/:name/agents - 查询拥有某能力的 Agent 列表 */
  addRoute('GET', '/api/v1/capabilities/:name/agents', authAgent, (req, res) => {
    const proficiency = req.query.proficiency;
    let sql = `SELECT ac.*, a.name AS agent_name, a.status AS agent_status
      FROM agent_capabilities ac
      LEFT JOIN agents a ON ac.agent_id = a.id
      WHERE ac.capability = ${db.esc(req.params.name)}`;
    if (proficiency && VALID_PROFICIENCIES.has(proficiency)) {
      sql += ` AND ac.proficiency = ${db.esc(proficiency)}`;
    }
    sql += ' ORDER BY ac.proficiency DESC, ac.registered_at ASC';

    const results = db.all(sql).map((row) => ({
      ...row,
      online: ws.isAgentOnline(row.agent_id),
    }));
    sendJson(res, 200, results);
  });

  /** GET /api/v1/agents/search - 按能力+熟练度搜索 Agent */
  addRoute('GET', '/api/v1/agents/search', authAgent, (req, res) => {
    const { capability, proficiency } = req.query;
    if (!capability) return sendJson(res, 400, { error: 'capability query parameter required' });

    let sql = `SELECT DISTINCT a.*, ac.capability, ac.proficiency, ac.description AS cap_description
      FROM agents a
      INNER JOIN agent_capabilities ac ON a.id = ac.agent_id
      WHERE ac.capability = ${db.esc(capability)}`;
    if (proficiency && VALID_PROFICIENCIES.has(proficiency)) {
      sql += ` AND ac.proficiency = ${db.esc(proficiency)}`;
    }
    sql += ' ORDER BY ac.proficiency DESC, a.name ASC';

    const results = db.all(sql).map((row) => ({
      ...formatAgent(row),
      capability: row.capability,
      proficiency: row.proficiency,
      capDescription: row.cap_description,
      online: ws.isAgentOnline(row.id),
    }));
    sendJson(res, 200, results);
  });
}
