import crypto from 'crypto';
import { getAccessibleChannel } from '../support/access.mjs';

/**
 * 注册频道与成员管理相关路由。
 * @param {object} context
 */
export function registerChannelMemberRoutes(context) {
  const { router, auth, db, sendJson, ws, policy } = context;
  const { addRoute } = router;
  const { authAgent } = auth;

  /** POST /api/v1/channels - 创建频道 */
  addRoute('POST', '/api/v1/channels', authAgent, (req, res) => {
    const { name, description, type, maxMembers } = req.body;
    if (!name) return sendJson(res, 400, { error: 'name is required' });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.exec(`INSERT INTO channels (id, name, description, type, created_by, max_members, created_at, updated_at)
      VALUES (${db.esc(id)}, ${db.esc(name)}, ${db.esc(description || null)}, ${db.esc(type || 'public')}, ${db.esc(req.agent.id)}, ${db.esc(maxMembers || 100)}, ${db.esc(now)}, ${db.esc(now)})`);

    db.exec(`INSERT INTO channel_members (channel_id, agent_id, role, joined_at)
      VALUES (${db.esc(id)}, ${db.esc(req.agent.id)}, 'owner', ${db.esc(now)})`);

    const channel = db.get(`SELECT * FROM channels WHERE id = ${db.esc(id)}`);
    ws.broadcastAll({
      type: 'channel.created',
      payload: { channel, creator: { id: req.agent.id, name: req.agent.name } },
      timestamp: now,
    });

    sendJson(res, 201, channel);
  });

  /** GET /api/v1/channels - 列出频道（公开频道 + 自己已加入的私有频道） */
  addRoute('GET', '/api/v1/channels', authAgent, (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit || '50', 10) || 50, 100);
    const offset = Number.parseInt(req.query.offset || '0', 10) || 0;
    const agentId = req.agent.id;

    sendJson(res, 200, db.all(`SELECT DISTINCT c.* FROM channels c
      LEFT JOIN channel_members cm ON c.id = cm.channel_id AND cm.agent_id = ${db.esc(agentId)}
      WHERE c.is_archived = 0
        AND (c.type != 'private' OR cm.agent_id IS NOT NULL)
      ORDER BY c.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`));
  });

  /** GET /api/v1/channels/:id - 获取频道详情（私有频道仅成员可见） */
  addRoute('GET', '/api/v1/channels/:id', authAgent, (req, res) => {
    const channel = db.get(`SELECT * FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    if (channel.type === 'private') {
      const isMember = db.get(`SELECT agent_id FROM channel_members WHERE channel_id = ${db.esc(req.params.id)} AND agent_id = ${db.esc(req.agent.id)}`);
      if (!isMember) return sendJson(res, 403, { error: 'Private channel: members only' });
    }

    sendJson(res, 200, channel);
  });

  /** PATCH /api/v1/channels/:id - 更新频道 */
  addRoute('PATCH', '/api/v1/channels/:id', authAgent, (req, res) => {
    const role = db.get(`SELECT role FROM channel_members WHERE channel_id = ${db.esc(req.params.id)} AND agent_id = ${db.esc(req.agent.id)}`);
    if (!role || (role.role !== 'owner' && role.role !== 'admin')) {
      return sendJson(res, 403, { error: 'Only owner/admin can update' });
    }

    const { name, description, maxMembers } = req.body;
    const sets = [`updated_at = ${db.esc(new Date().toISOString())}`];

    if (name !== undefined) sets.push(`name = ${db.esc(name)}`);
    if (description !== undefined) sets.push(`description = ${db.esc(description)}`);
    if (maxMembers !== undefined) sets.push(`max_members = ${db.esc(maxMembers)}`);

    db.exec(`UPDATE channels SET ${sets.join(', ')} WHERE id = ${db.esc(req.params.id)}`);

    const updated = db.get(`SELECT * FROM channels WHERE id = ${db.esc(req.params.id)}`);
    ws.broadcastChannel(req.params.id, {
      type: 'channel.updated',
      payload: { channel: updated },
      timestamp: new Date().toISOString(),
    });

    sendJson(res, 200, updated);
  });

  /** DELETE /api/v1/channels/:id - 归档频道 */
  addRoute('DELETE', '/api/v1/channels/:id', authAgent, (req, res) => {
    const role = db.get(`SELECT role FROM channel_members WHERE channel_id = ${db.esc(req.params.id)} AND agent_id = ${db.esc(req.agent.id)}`);
    if (!role || role.role !== 'owner') return sendJson(res, 403, { error: 'Only owner can archive' });

    db.exec(`UPDATE channels SET is_archived = 1, updated_at = ${db.esc(new Date().toISOString())} WHERE id = ${db.esc(req.params.id)}`);
    res.writeHead(204).end();
  });

  /** POST /api/v1/channels/:id/join - 加入频道（私有频道需要被邀请/Owner添加） */
  addRoute('POST', '/api/v1/channels/:id/join', authAgent, (req, res) => {
    const channel = db.get(`SELECT * FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });
    if (channel.type === 'private') return sendJson(res, 403, { error: 'Private channel: must be invited by owner/admin' });

    const existing = db.get(`SELECT agent_id FROM channel_members WHERE channel_id = ${db.esc(req.params.id)} AND agent_id = ${db.esc(req.agent.id)}`);
    if (existing) return sendJson(res, 409, { error: 'Already a member' });

    if (policy) {
      const capCheck = policy.validateMemberCapabilities(req.params.id, req.agent.id);
      if (!capCheck.ok) {
        return sendJson(res, 403, { error: `Agent 缺少频道所需能力: ${capCheck.missing.join(', ')}`, missingCapabilities: capCheck.missing });
      }
    }

    const count = db.get(`SELECT COUNT(*) as cnt FROM channel_members WHERE channel_id = ${db.esc(req.params.id)}`);
    if (count && count.cnt >= channel.max_members) return sendJson(res, 409, { error: 'Channel is full' });

    const now = new Date().toISOString();
    db.exec(`INSERT INTO channel_members (channel_id, agent_id, role, joined_at)
      VALUES (${db.esc(req.params.id)}, ${db.esc(req.agent.id)}, 'member', ${db.esc(now)})`);

    ws.broadcastChannel(req.params.id, {
      type: 'member.joined',
      payload: { channelId: req.params.id, agentId: req.agent.id, agentName: req.agent.name },
      timestamp: now,
    });

    sendJson(res, 200, { message: 'Joined channel' });
  });

  /** POST /api/v1/channels/:id/invite - 频道 Owner/Admin 邀请 Agent 加入私有频道 */
  addRoute('POST', '/api/v1/channels/:id/invite', authAgent, (req, res) => {
    const channel = db.get(`SELECT * FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });

    const role = db.get(`SELECT role FROM channel_members WHERE channel_id = ${db.esc(req.params.id)} AND agent_id = ${db.esc(req.agent.id)}`);
    if (!role || (role.role !== 'owner' && role.role !== 'admin')) {
      return sendJson(res, 403, { error: 'Only owner/admin can invite' });
    }

    const { agentId } = req.body;
    if (!agentId) return sendJson(res, 400, { error: 'agentId is required' });

    const target = db.get(`SELECT id, name FROM agents WHERE id = ${db.esc(agentId)}`);
    if (!target) return sendJson(res, 404, { error: 'Target agent not found' });

    const existing = db.get(`SELECT agent_id FROM channel_members WHERE channel_id = ${db.esc(req.params.id)} AND agent_id = ${db.esc(agentId)}`);
    if (existing) return sendJson(res, 409, { error: 'Agent is already a member' });

    const count = db.get(`SELECT COUNT(*) as cnt FROM channel_members WHERE channel_id = ${db.esc(req.params.id)}`);
    if (count && count.cnt >= channel.max_members) return sendJson(res, 409, { error: 'Channel is full' });

    const now = new Date().toISOString();
    db.exec(`INSERT INTO channel_members (channel_id, agent_id, role, joined_at)
      VALUES (${db.esc(req.params.id)}, ${db.esc(agentId)}, 'member', ${db.esc(now)})`);

    ws.broadcastChannel(req.params.id, {
      type: 'member.joined',
      payload: { channelId: req.params.id, agentId, agentName: target.name, invitedBy: req.agent.id },
      timestamp: now,
    });

    sendJson(res, 200, { message: `Agent ${target.name} invited to channel` });
  });

  /** POST /api/v1/channels/:id/leave - 离开频道 */
  addRoute('POST', '/api/v1/channels/:id/leave', authAgent, (req, res) => {
    db.exec(`DELETE FROM channel_members WHERE channel_id = ${db.esc(req.params.id)} AND agent_id = ${db.esc(req.agent.id)}`);

    ws.broadcastChannel(req.params.id, {
      type: 'member.left',
      payload: { channelId: req.params.id, agentId: req.agent.id, agentName: req.agent.name },
      timestamp: new Date().toISOString(),
    });

    sendJson(res, 200, { message: 'Left channel' });
  });

  /** GET /api/v1/channels/:id/members - 获取频道成员 */
  addRoute('GET', '/api/v1/channels/:id/members', authAgent, (req, res) => {
    const access = getAccessibleChannel(db, req.params.id, req.agent.id);
    if (!access) return sendJson(res, 404, { error: 'Channel not found' });
    if (access.channel.type === 'private' && !access.member) {
      return sendJson(res, 403, { error: 'Private channel: members only' });
    }

    sendJson(res, 200, db.all(`SELECT cm.*, a.name as agent_name
      FROM channel_members cm
      LEFT JOIN agents a ON cm.agent_id = a.id
      WHERE cm.channel_id = ${db.esc(req.params.id)}`));
  });

  /** GET /api/v1/channels/:id/policy - 获取当前频道的有效策略快照 */
  addRoute('GET', '/api/v1/channels/:id/policy', authAgent, (req, res) => {
    const channel = db.get(`SELECT id FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const member = db.get(`SELECT agent_id FROM channel_members
      WHERE channel_id = ${db.esc(req.params.id)}
        AND agent_id = ${db.esc(req.agent.id)}`);
    if (!member) return sendJson(res, 403, { error: 'Must be a channel member' });

    const effectivePolicy = policy
      ? policy.getEffectivePolicy(req.params.id)
      : {
          isolation_level: 'standard',
          require_intent: false,
          allowed_task_types: null,
          default_requires_approval: false,
          required_capabilities: null,
          max_concurrent_discussions: 5,
          message_rate_limit: 60,
        };

    sendJson(res, 200, effectivePolicy);
  });
}
