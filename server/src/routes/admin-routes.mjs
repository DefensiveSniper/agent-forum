import crypto from 'crypto';
import { buildCursorPage } from '../pagination.mjs';

/**
 * 注册管理员相关路由。
 * @param {object} context
 */
export function registerAdminRoutes(context) {
  const { router, auth, db, sendJson, formatAgent, ws, security, messaging } = context;
  const { addRoute } = router;
  const { authAdmin } = auth;
  const VALID_CHANNEL_TYPES = new Set(['public', 'private', 'broadcast']);

  /**
   * 归一化管理员提交的邀请 Agent 列表。
   * 同时兼容单个 `agentId` 和批量 `agentIds` 两种写法。
   * @param {object} body
   * @returns {string[]}
   */
  function resolveInviteAgentIds(body = {}) {
    const rawIds = [];

    if (typeof body.agentId === 'string') rawIds.push(body.agentId);
    if (Array.isArray(body.agentIds)) rawIds.push(...body.agentIds);

    return [...new Set(
      rawIds
        .map((agentId) => typeof agentId === 'string' ? agentId.trim() : '')
        .filter(Boolean)
    )];
  }

  /**
   * 校验并解析频道人数上限。
   * @param {unknown} maxMembers
   * @returns {number|null}
   */
  function resolveMaxMembers(maxMembers) {
    if (maxMembers === undefined || maxMembers === null || maxMembers === '') return 100;

    const parsed = Number.parseInt(String(maxMembers), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    return parsed;
  }

  /**
   * 按输入顺序读取已注册 Agent，并返回缺失 ID 列表。
   * @param {string[]} agentIds
   * @returns {{ agents: Array<{ id: string, name: string, status: string }>, missingIds: string[] }}
   */
  function resolveRegisteredAgents(agentIds) {
    if (agentIds.length === 0) {
      return { agents: [], missingIds: [] };
    }

    const sql = `SELECT id, name, status FROM agents WHERE id IN (${agentIds.map((agentId) => db.esc(agentId)).join(', ')})`;
    const rows = db.all(sql);
    const rowMap = new Map(rows.map((row) => [row.id, row]));
    const agents = agentIds.map((agentId) => rowMap.get(agentId)).filter(Boolean);
    const missingIds = agentIds.filter((agentId) => !rowMap.has(agentId));

    return { agents, missingIds };
  }

  /**
   * 将 Agent 加入频道，并广播成员加入事件。
   * @param {object} options
   * @param {string} options.channelId
   * @param {Array<{ id: string, name: string }>} options.agents
   * @param {string} options.invitedBy
   * @returns {Array<{ id: string, name: string }>}
   */
  function addAgentsToChannel({ channelId, agents, invitedBy }) {
    if (agents.length === 0) return [];

    const now = new Date().toISOString();
    for (const agent of agents) {
      db.exec(`INSERT INTO channel_members (channel_id, agent_id, role, joined_at)
        VALUES (${db.esc(channelId)}, ${db.esc(agent.id)}, 'member', ${db.esc(now)})`);

      ws.broadcastChannel(channelId, {
        type: 'member.joined',
        payload: { channelId, agentId: agent.id, agentName: agent.name, invitedBy },
        timestamp: now,
        channelId,
      });
    }

    return agents.map((agent) => ({ id: agent.id, name: agent.name }));
  }

  /**
   * 彻底删除频道及其关联数据。
   * @param {string} channelId
   */
  function deleteChannelCascade(channelId) {
    db.exec(`
      DELETE FROM messages WHERE channel_id = ${db.esc(channelId)};
      DELETE FROM channel_members WHERE channel_id = ${db.esc(channelId)};
      DELETE FROM subscriptions WHERE channel_id = ${db.esc(channelId)};
      DELETE FROM discussion_sessions WHERE channel_id = ${db.esc(channelId)};
      DELETE FROM channels WHERE id = ${db.esc(channelId)};
    `);
  }

  /**
   * 将消息服务错误映射为 HTTP 响应。
   * @param {import('http').ServerResponse} res
   * @param {Error} err
   * @returns {void}
   */
  function sendMessagingError(res, err) {
    const message = err?.message || 'Failed to process message';

    if (
      message === 'replyTo message not found in this channel'
      || message.startsWith('Some mention agents are not channel members:')
      || message.startsWith('Some participant agents are not channel members:')
      || message === 'Linear discussion requires at least 2 participant agents'
      || message === 'maxRounds must be a positive integer'
    ) {
      sendJson(res, 400, { error: message });
      return;
    }
    if (message.startsWith('Some participant agents are offline:')) {
      sendJson(res, 409, { error: message });
      return;
    }
    if (
      message === 'Discussion session not found'
      || message === 'Discussion session is not active'
      || message === 'Only the expected agent can reply in this discussion session'
      || message === 'Discussion replies must reply to the latest session message'
      || message === 'Final discussion turn cannot mention the next agent'
      || message === 'Linear discussion replies must mention exactly the next agent in order'
    ) {
      sendJson(res, 409, { error: message });
      return;
    }

    sendJson(res, 400, { error: message });
  }

  /**
   * 构建格式化后的消息分页结果。
   * @param {Array<object>} rows
   * @param {number} limit
   * @returns {object}
   */
  function buildMessagePage(rows, limit) {
    const page = buildCursorPage(rows, limit);
    return {
      ...page,
      data: messaging.formatMessages(page.data),
    };
  }

  /** POST /api/v1/admin/login - 管理员登录 */
  addRoute('POST', '/api/v1/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return sendJson(res, 400, { error: 'username and password required' });
    }

    const admin = db.get(`SELECT * FROM admin_users WHERE username = ${db.esc(username)}`);
    if (!admin || !security.verifyPassword(password, admin.password_hash)) {
      return sendJson(res, 401, { error: 'Invalid credentials' });
    }

    const token = security.signJwt({ id: admin.id, username: admin.username, role: admin.role });
    console.log(`🔑 Admin login: ${username}`);
    sendJson(res, 200, {
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        role: admin.role,
        createdAt: admin.created_at,
      },
    });
  });

  /** POST /api/v1/admin/invites - 生成邀请码 */
  addRoute('POST', '/api/v1/admin/invites', authAdmin, (req, res) => {
    const { label, maxUses, expiresAt } = req.body;
    const id = crypto.randomUUID();
    const code = crypto.randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    const resolvedMaxUses = (maxUses !== undefined && maxUses !== null) ? Number.parseInt(maxUses, 10) : 1;

    db.exec(`INSERT INTO invite_codes (id, code, label, created_by, max_uses, expires_at, created_at)
      VALUES (${db.esc(id)}, ${db.esc(code)}, ${db.esc(label || null)}, ${db.esc(req.admin.id)}, ${db.esc(resolvedMaxUses)}, ${db.esc(expiresAt || null)}, ${db.esc(now)})`);

    console.log(`🎟️  Invite code created: ${label || 'no label'} (maxUses: ${resolvedMaxUses === 0 ? 'unlimited' : resolvedMaxUses})`);
    sendJson(res, 201, {
      id,
      code,
      label: label || null,
      maxUses: resolvedMaxUses,
      expiresAt: expiresAt || null,
      createdAt: now,
    });
  });

  /** GET /api/v1/admin/invites - 列出所有邀请码 */
  addRoute('GET', '/api/v1/admin/invites', authAdmin, (req, res) => {
    sendJson(res, 200, db.all('SELECT * FROM invite_codes ORDER BY created_at DESC'));
  });

  /** DELETE /api/v1/admin/invites/:id - 作废邀请码 */
  addRoute('DELETE', '/api/v1/admin/invites/:id', authAdmin, (req, res) => {
    db.exec(`UPDATE invite_codes SET revoked = 1 WHERE id = ${db.esc(req.params.id)}`);
    res.writeHead(204).end();
  });

  /** GET /api/v1/admin/agents - 查看所有 Agent（含邀请码详情） */
  addRoute('GET', '/api/v1/admin/agents', authAdmin, (req, res) => {
    const agents = db.all(`SELECT a.*, ic.code AS invite_code, ic.label AS invite_label
      FROM agents a LEFT JOIN invite_codes ic ON a.invite_code_id = ic.id
      ORDER BY a.created_at DESC`);

    sendJson(res, 200, agents.map(formatAgent));
  });

  /** PATCH /api/v1/admin/agents/:id - 修改 Agent 状态 */
  addRoute('PATCH', '/api/v1/admin/agents/:id', authAdmin, (req, res) => {
    const { status } = req.body;
    if (!['active', 'suspended'].includes(status)) {
      return sendJson(res, 400, { error: 'Invalid status' });
    }

    db.exec(`UPDATE agents SET status = ${db.esc(status)} WHERE id = ${db.esc(req.params.id)}`);
    if (status === 'suspended') ws.disconnectAgent(req.params.id, 'Suspended by admin');

    const agent = db.get(`SELECT * FROM agents WHERE id = ${db.esc(req.params.id)}`);
    if (!agent) return sendJson(res, 404, { error: 'Agent not found' });

    sendJson(res, 200, formatAgent(agent));
  });

  /** DELETE /api/v1/admin/agents/:id - 注销 Agent（级联删除关联数据） */
  addRoute('DELETE', '/api/v1/admin/agents/:id', authAdmin, (req, res) => {
    const agent = db.get(`SELECT * FROM agents WHERE id = ${db.esc(req.params.id)}`);
    if (!agent) return sendJson(res, 404, { error: 'Agent not found' });

    ws.disconnectAgent(req.params.id, 'Deleted by admin');
    db.exec(`DELETE FROM messages WHERE sender_id = ${db.esc(req.params.id)}`);
    db.exec(`DELETE FROM channel_members WHERE agent_id = ${db.esc(req.params.id)}`);
    db.exec(`DELETE FROM subscriptions WHERE agent_id = ${db.esc(req.params.id)}`);
    db.exec(`UPDATE channels SET created_by = NULL WHERE created_by = ${db.esc(req.params.id)}`);
    db.exec(`DELETE FROM agents WHERE id = ${db.esc(req.params.id)}`);

    res.writeHead(204).end();
  });

  /** GET /api/v1/admin/channels - 管理员查看所有频道（含归档） */
  addRoute('GET', '/api/v1/admin/channels', authAdmin, (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit || '50', 10) || 50, 100);
    const offset = Number.parseInt(req.query.offset || '0', 10) || 0;
    const includeArchived = req.query.includeArchived === 'true';

    let sql = 'SELECT c.*, (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) AS member_count FROM channels c';
    if (!includeArchived) sql += ' WHERE c.is_archived = 0';
    sql += ` ORDER BY c.created_at DESC LIMIT ${limit} OFFSET ${offset}`;

    sendJson(res, 200, db.all(sql));
  });

  /** POST /api/v1/admin/channels - 管理员创建频道并可直接邀请已注册 Agent */
  addRoute('POST', '/api/v1/admin/channels', authAdmin, (req, res) => {
    const { name, description, type } = req.body || {};
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    const resolvedType = type || 'public';
    const maxMembers = resolveMaxMembers(req.body?.maxMembers);
    const inviteAgentIds = resolveInviteAgentIds(req.body);

    if (!trimmedName) {
      return sendJson(res, 400, { error: 'name is required' });
    }
    if (!VALID_CHANNEL_TYPES.has(resolvedType)) {
      return sendJson(res, 400, { error: 'Invalid channel type' });
    }
    if (maxMembers === null) {
      return sendJson(res, 400, { error: 'maxMembers must be a positive integer' });
    }
    if (inviteAgentIds.length > maxMembers) {
      return sendJson(res, 409, { error: 'Invited agents exceed maxMembers' });
    }

    const { agents, missingIds } = resolveRegisteredAgents(inviteAgentIds);
    if (missingIds.length > 0) {
      return sendJson(res, 404, { error: 'Some target agents were not found', missingAgentIds: missingIds });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.exec(`INSERT INTO channels (id, name, description, type, created_by, max_members, created_at, updated_at)
      VALUES (${db.esc(id)}, ${db.esc(trimmedName)}, ${db.esc(description || null)}, ${db.esc(resolvedType)}, ${db.esc(`admin:${req.admin.id}`)}, ${db.esc(maxMembers)}, ${db.esc(now)}, ${db.esc(now)})`);

    const invitedAgents = addAgentsToChannel({
      channelId: id,
      agents,
      invitedBy: `admin:${req.admin.username}`,
    });

    const createdChannel = db.get(`SELECT c.*, (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) AS member_count
      FROM channels c WHERE c.id = ${db.esc(id)}`);

    ws.broadcastAll({
      type: 'channel.created',
      payload: { channel: createdChannel, creator: { id: `admin:${req.admin.id}`, name: `[Admin] ${req.admin.username}` } },
      timestamp: now,
    });

    sendJson(res, 201, { channel: createdChannel, invitedAgents });
  });

  /** GET /api/v1/admin/channels/:id - 管理员查看频道详情（成员含在线状态） */
  addRoute('GET', '/api/v1/admin/channels/:id', authAdmin, (req, res) => {
    const channel = db.get(`SELECT c.*, (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) AS member_count
      FROM channels c WHERE c.id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const members = db.all(`SELECT cm.*, a.name AS agent_name, a.status AS agent_status
      FROM channel_members cm
      LEFT JOIN agents a ON cm.agent_id = a.id
      WHERE cm.channel_id = ${db.esc(req.params.id)}`);

    const membersWithOnline = members.map((member) => ({
      ...member,
      online: ws.isAgentOnline(member.agent_id),
    }));

    sendJson(res, 200, { ...channel, members: membersWithOnline });
  });

  /** POST /api/v1/admin/channels/:id/invite - 管理员邀请已注册 Agent 进入频道 */
  addRoute('POST', '/api/v1/admin/channels/:id/invite', authAdmin, (req, res) => {
    const channel = db.get(`SELECT * FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });

    const inviteAgentIds = resolveInviteAgentIds(req.body);
    if (inviteAgentIds.length === 0) {
      return sendJson(res, 400, { error: 'agentId or agentIds is required' });
    }

    const { agents, missingIds } = resolveRegisteredAgents(inviteAgentIds);
    if (missingIds.length > 0) {
      return sendJson(res, 404, { error: 'Some target agents were not found', missingAgentIds: missingIds });
    }

    const existingMembers = db.all(`SELECT agent_id FROM channel_members
      WHERE channel_id = ${db.esc(req.params.id)}
        AND agent_id IN (${inviteAgentIds.map((agentId) => db.esc(agentId)).join(', ')})`);
    const existingMemberIds = new Set(existingMembers.map((member) => member.agent_id));
    const newAgents = agents.filter((agent) => !existingMemberIds.has(agent.id));

    if (newAgents.length === 0) {
      return sendJson(res, 409, { error: 'All target agents are already members' });
    }

    const count = db.get(`SELECT COUNT(*) AS cnt FROM channel_members WHERE channel_id = ${db.esc(req.params.id)}`);
    if (count && (count.cnt + newAgents.length) > channel.max_members) {
      return sendJson(res, 409, { error: 'Inviting these agents would exceed maxMembers' });
    }

    const invitedAgents = addAgentsToChannel({
      channelId: req.params.id,
      agents: newAgents,
      invitedBy: `admin:${req.admin.username}`,
    });

    sendJson(res, 200, {
      invitedAgents,
      invitedCount: invitedAgents.length,
      skippedAgentIds: inviteAgentIds.filter((agentId) => existingMemberIds.has(agentId)),
    });
  });

  /** GET /api/v1/admin/channels/:id/messages - 管理员查看频道消息（无需是成员） */
  addRoute('GET', '/api/v1/admin/channels/:id/messages', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const limit = Math.min(Number.parseInt(req.query.limit || '50', 10) || 50, 100);
    const cursor = req.query.cursor;
    let sql = `SELECT m.*, a.name AS sender_name,
      rm.sender_id AS reply_sender_id,
      ra.name AS reply_sender_name,
      rm.content AS reply_content
      FROM messages m
      LEFT JOIN messages rm ON rm.id = m.reply_to
      LEFT JOIN agents ra ON ra.id = rm.sender_id
      LEFT JOIN agents a ON m.sender_id = a.id
      WHERE m.channel_id = ${db.esc(req.params.id)}`;
    if (cursor) sql += ` AND m.created_at < ${db.esc(cursor)}`;
    sql += ` ORDER BY m.created_at DESC LIMIT ${limit + 1}`;

    sendJson(res, 200, buildMessagePage(db.all(sql), limit));
  });

  /** POST /api/v1/admin/channels/:id/messages - 管理员发送评论到频道 */
  addRoute('POST', '/api/v1/admin/channels/:id/messages', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id, is_archived FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });

    const { content, contentType, replyTo, mentionAgentIds, discussionSessionId } = req.body;
    if (!content) return sendJson(res, 400, { error: 'content is required' });

    const senderId = `admin:${req.admin.username}`;
    const senderName = `[Admin] ${req.admin.username}`;

    try {
      const { message } = messaging.createChannelMessage({
        channelId: req.params.id,
        senderId,
        senderName,
        content,
        contentType,
        replyTo,
        mentionAgentIds,
        discussionSessionId,
      });

      ws.broadcastChannel(req.params.id, {
        type: 'message.new',
        payload: { message, sender: { id: senderId, name: senderName } },
        timestamp: message.created_at,
        channelId: req.params.id,
      });

      sendJson(res, 201, message);
    } catch (err) {
      sendMessagingError(res, err);
    }
  });

  /** POST /api/v1/admin/channels/:id/discussions - 管理员发起线性多 Agent 讨论 */
  addRoute('POST', '/api/v1/admin/channels/:id/discussions', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id, is_archived FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });

    const { content, participantAgentIds, maxRounds } = req.body || {};
    if (!content) return sendJson(res, 400, { error: 'content is required' });

    const senderId = `admin:${req.admin.username}`;
    const senderName = `[Admin] ${req.admin.username}`;

    try {
      const { message, discussion } = messaging.createLinearDiscussionSession({
        channelId: req.params.id,
        senderId,
        senderName,
        content,
        participantAgentIds,
        maxRounds,
        isAgentOnline: ws.isAgentOnline,
      });

      ws.broadcastChannel(req.params.id, {
        type: 'message.new',
        payload: { message, sender: { id: senderId, name: senderName } },
        timestamp: message.created_at,
        channelId: req.params.id,
      });

      sendJson(res, 201, { message, discussion });
    } catch (err) {
      sendMessagingError(res, err);
    }
  });

  /** DELETE /api/v1/admin/channels/:id - 管理员彻底删除频道 */
  addRoute('DELETE', '/api/v1/admin/channels/:id', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id, name FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    deleteChannelCascade(req.params.id);
    ws.broadcastAll({
      type: 'channel.deleted',
      payload: {
        channelId: req.params.id,
        channelName: channel.name,
        deletedBy: `admin:${req.admin.username}`,
      },
      timestamp: new Date().toISOString(),
      channelId: req.params.id,
    });

    res.writeHead(204).end();
  });

  /** POST /api/v1/admin/agents/:id/rotate-key - 强制轮换 API Key */
  addRoute('POST', '/api/v1/admin/agents/:id/rotate-key', authAdmin, (req, res) => {
    const agent = db.get(`SELECT * FROM agents WHERE id = ${db.esc(req.params.id)}`);
    if (!agent) return sendJson(res, 404, { error: 'Agent not found' });

    const newKey = `af_${crypto.randomBytes(32).toString('hex')}`;
    const newHash = crypto.createHash('sha256').update(newKey).digest('hex');

    db.exec(`UPDATE agents SET api_key_hash = ${db.esc(newHash)} WHERE id = ${db.esc(req.params.id)}`);
    ws.disconnectAgent(req.params.id, 'API Key rotated');

    sendJson(res, 200, { apiKey: newKey });
  });
}
