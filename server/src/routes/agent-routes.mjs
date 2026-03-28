import crypto from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { agents, inviteCodes } from '../schema.mjs';

/**
 * 注册 Agent 相关路由。
 * @param {object} context
 */
export function registerAgentRoutes(context) {
  const { router, auth, db, sendJson, formatAgent, rateLimiter } = context;
  const { addRoute } = router;
  const { authAgent } = auth;
  const { orm } = db;

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

    const [invite] = await orm.select().from(inviteCodes).where(eq(inviteCodes.code, inviteCode));
    if (!invite) return sendJson(res, 403, { error: 'Invalid invite code' });
    if (invite.revoked) return sendJson(res, 403, { error: 'Invite code has been revoked' });
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      return sendJson(res, 403, { error: 'Invite code has expired' });
    }
    if (invite.max_uses > 0 && invite.uses_count >= invite.max_uses) {
      return sendJson(res, 403, { error: 'Invite code has been fully used' });
    }

    const [existingAgent] = await orm.select({ id: agents.id }).from(agents).where(eq(agents.name, name));
    if (existingAgent) {
      return sendJson(res, 409, { error: 'Agent name already taken' });
    }

    const id = crypto.randomUUID();
    const apiKey = `af_${crypto.randomBytes(32).toString('hex')}`;
    const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const now = new Date().toISOString();

    await orm.insert(agents).values({
      id,
      name,
      description: description || null,
      api_key_hash: apiKeyHash,
      invite_code_id: invite.id,
      status: 'active',
      metadata: metadata ? JSON.stringify(metadata) : null,
      created_at: now,
      last_seen_at: now,
    });

    await orm.update(inviteCodes)
      .set({ uses_count: sql`${inviteCodes.uses_count} + 1`, used_by: id })
      .where(eq(inviteCodes.id, invite.id));

    const [agent] = await orm.select().from(agents).where(eq(agents.id, id));
    console.log(`✅ Agent registered: ${name}`);
    return sendJson(res, 201, { agent: formatAgent(agent), apiKey });
  });

  /** GET /api/v1/agents/me - 获取当前 Agent 信息 */
  addRoute('GET', '/api/v1/agents/me', authAgent, (req, res) => {
    sendJson(res, 200, formatAgent(req.agent));
  });

  /** PATCH /api/v1/agents/me - 更新当前 Agent */
  addRoute('PATCH', '/api/v1/agents/me', authAgent, async (req, res) => {
    const { name, description, metadata } = req.body;
    const updates = {};

    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (metadata !== undefined) updates.metadata = JSON.stringify(metadata);

    if (Object.keys(updates).length > 0) {
      await orm.update(agents).set(updates).where(eq(agents.id, req.agent.id));
    }

    const [updated] = await orm.select().from(agents).where(eq(agents.id, req.agent.id));
    sendJson(res, 200, formatAgent(updated));
  });

  /** GET /api/v1/agents - 列出所有 Agent */
  addRoute('GET', '/api/v1/agents', authAgent, async (req, res) => {
    const rows = await orm.select().from(agents);
    sendJson(res, 200, rows.map(formatAgent));
  });

  /** GET /api/v1/agents/:id - 获取指定 Agent */
  addRoute('GET', '/api/v1/agents/:id', authAgent, async (req, res) => {
    const [agent] = await orm.select().from(agents).where(eq(agents.id, req.params.id));
    if (!agent) return sendJson(res, 404, { error: 'Agent not found' });
    sendJson(res, 200, formatAgent(agent));
  });
}
