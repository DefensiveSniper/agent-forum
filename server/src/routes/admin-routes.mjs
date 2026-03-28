import crypto from 'crypto';
import { eq, and, desc, lt, count, inArray, sql, getTableColumns } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { agents, channels, channelMembers, messages, subscriptions, discussionSessions, inviteCodes, adminUsers } from '../schema.mjs';
import { buildCursorPage } from '../pagination.mjs';

/**
 * 注册管理员相关路由。
 * @param {object} context
 */
export function registerAdminRoutes(context) {
  const { router, auth, db, sendJson, formatAgent, ws, security, messaging } = context;
  const { addRoute } = router;
  const { authAdmin } = auth;
  const { orm } = db;
  const VALID_CHANNEL_TYPES = new Set(['public', 'private', 'broadcast']);

  const rm = alias(messages, 'rm');
  const ra = alias(agents, 'ra');

  /**
   * 归一化管理员提交的邀请 Agent 列表。
   * @param {object} body
   * @returns {string[]}
   */
  function resolveInviteAgentIds(body = {}) {
    const rawIds = [];
    if (typeof body.agentId === 'string') rawIds.push(body.agentId);
    if (Array.isArray(body.agentIds)) rawIds.push(...body.agentIds);
    return [...new Set(rawIds.map((id) => typeof id === 'string' ? id.trim() : '').filter(Boolean))];
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
   * 按输入顺序读取已注册 Agent。
   * @param {string[]} agentIds
   * @returns {Promise<{ agents: Array<object>, missingIds: string[] }>}
   */
  async function resolveRegisteredAgents(agentIds) {
    if (agentIds.length === 0) return { agents: [], missingIds: [] };

    const rows = await orm.select({ id: agents.id, name: agents.name, status: agents.status })
      .from(agents).where(inArray(agents.id, agentIds));
    const rowMap = new Map(rows.map((row) => [row.id, row]));
    return {
      agents: agentIds.map((id) => rowMap.get(id)).filter(Boolean),
      missingIds: agentIds.filter((id) => !rowMap.has(id)),
    };
  }

  /**
   * 将 Agent 加入频道，并广播成员加入事件。
   * @param {object} options
   * @returns {Promise<Array<{ id: string, name: string }>>}
   */
  async function addAgentsToChannel({ channelId, agents: agentList, invitedBy }) {
    if (agentList.length === 0) return [];

    const now = new Date().toISOString();
    for (const agent of agentList) {
      await orm.insert(channelMembers).values({
        channel_id: channelId, agent_id: agent.id, role: 'member', joined_at: now,
      });

      await ws.broadcastChannel(channelId, {
        type: 'member.joined',
        payload: { channelId, agentId: agent.id, agentName: agent.name, invitedBy },
        timestamp: now,
        channelId,
      });
    }

    return agentList.map((agent) => ({ id: agent.id, name: agent.name }));
  }

  /**
   * 彻底删除频道及其关联数据。
   * @param {string} channelId
   */
  async function deleteChannelCascade(channelId) {
    await orm.transaction(async (tx) => {
      await tx.delete(messages).where(eq(messages.channel_id, channelId));
      await tx.delete(channelMembers).where(eq(channelMembers.channel_id, channelId));
      await tx.delete(subscriptions).where(eq(subscriptions.channel_id, channelId));
      await tx.delete(discussionSessions).where(eq(discussionSessions.channel_id, channelId));
      await tx.delete(channels).where(eq(channels.id, channelId));
    });
  }

  /**
   * 将消息服务错误映射为 HTTP 响应。
   * @param {import('http').ServerResponse} res
   * @param {Error} err
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
   * 查询消息并构建分页结果。
   * @param {string} channelId
   * @param {string|undefined} cursor
   * @param {number} limit
   * @returns {Promise<object>}
   */
  async function queryMessages(channelId, cursor, limit) {
    const conditions = [eq(messages.channel_id, channelId)];
    if (cursor) conditions.push(lt(messages.created_at, cursor));

    const rows = await orm.select({
      ...getTableColumns(messages),
      sender_name: agents.name,
      reply_sender_id: rm.sender_id,
      reply_sender_name: ra.name,
      reply_content: rm.content,
    }).from(messages)
      .leftJoin(agents, eq(agents.id, messages.sender_id))
      .leftJoin(rm, eq(rm.id, messages.reply_to))
      .leftJoin(ra, eq(ra.id, rm.sender_id))
      .where(and(...conditions))
      .orderBy(desc(messages.created_at))
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit);
    return { ...page, data: messaging.formatMessages(page.data) };
  }

  /** POST /api/v1/admin/login - 管理员登录 */
  addRoute('POST', '/api/v1/admin/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return sendJson(res, 400, { error: 'username and password required' });
    }

    const [admin] = await orm.select().from(adminUsers).where(eq(adminUsers.username, username));
    if (!admin || !security.verifyPassword(password, admin.password_hash)) {
      return sendJson(res, 401, { error: 'Invalid credentials' });
    }

    const token = security.signJwt({ id: admin.id, username: admin.username, role: admin.role });
    console.log(`🔑 Admin login: ${username}`);
    sendJson(res, 200, {
      token,
      admin: { id: admin.id, username: admin.username, role: admin.role, createdAt: admin.created_at },
    });
  });

  /** POST /api/v1/admin/invites - 生成邀请码 */
  addRoute('POST', '/api/v1/admin/invites', authAdmin, async (req, res) => {
    const { label, maxUses, expiresAt } = req.body;
    const id = crypto.randomUUID();
    const code = crypto.randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    const resolvedMaxUses = (maxUses !== undefined && maxUses !== null) ? Number.parseInt(maxUses, 10) : 1;

    await orm.insert(inviteCodes).values({
      id, code, label: label || null, created_by: req.admin.id,
      max_uses: resolvedMaxUses, expires_at: expiresAt || null, created_at: now,
    });

    console.log(`🎟️  Invite code created: ${label || 'no label'} (maxUses: ${resolvedMaxUses === 0 ? 'unlimited' : resolvedMaxUses})`);
    sendJson(res, 201, { id, code, label: label || null, maxUses: resolvedMaxUses, expiresAt: expiresAt || null, createdAt: now });
  });

  /** GET /api/v1/admin/invites - 列出所有邀请码 */
  addRoute('GET', '/api/v1/admin/invites', authAdmin, async (req, res) => {
    const rows = await orm.select().from(inviteCodes).orderBy(desc(inviteCodes.created_at));
    sendJson(res, 200, rows);
  });

  /** DELETE /api/v1/admin/invites/:id - 作废邀请码 */
  addRoute('DELETE', '/api/v1/admin/invites/:id', authAdmin, async (req, res) => {
    await orm.update(inviteCodes).set({ revoked: 1 }).where(eq(inviteCodes.id, req.params.id));
    res.writeHead(204).end();
  });

  /** GET /api/v1/admin/agents - 查看所有 Agent（含邀请码详情） */
  addRoute('GET', '/api/v1/admin/agents', authAdmin, async (req, res) => {
    const rows = await orm.select({
      ...getTableColumns(agents),
      invite_code: inviteCodes.code,
      invite_label: inviteCodes.label,
    }).from(agents)
      .leftJoin(inviteCodes, eq(agents.invite_code_id, inviteCodes.id))
      .orderBy(desc(agents.created_at));

    sendJson(res, 200, rows.map(formatAgent));
  });

  /** PATCH /api/v1/admin/agents/:id - 修改 Agent 状态 */
  addRoute('PATCH', '/api/v1/admin/agents/:id', authAdmin, async (req, res) => {
    const { status } = req.body;
    if (!['active', 'suspended'].includes(status)) {
      return sendJson(res, 400, { error: 'Invalid status' });
    }

    await orm.update(agents).set({ status }).where(eq(agents.id, req.params.id));
    if (status === 'suspended') ws.disconnectAgent(req.params.id, 'Suspended by admin');

    const [agent] = await orm.select().from(agents).where(eq(agents.id, req.params.id));
    if (!agent) return sendJson(res, 404, { error: 'Agent not found' });

    sendJson(res, 200, formatAgent(agent));
  });

  /** DELETE /api/v1/admin/agents/:id - 注销 Agent（级联删除关联数据） */
  addRoute('DELETE', '/api/v1/admin/agents/:id', authAdmin, async (req, res) => {
    const [agent] = await orm.select().from(agents).where(eq(agents.id, req.params.id));
    if (!agent) return sendJson(res, 404, { error: 'Agent not found' });

    ws.disconnectAgent(req.params.id, 'Deleted by admin');

    await orm.transaction(async (tx) => {
      await tx.delete(messages).where(eq(messages.sender_id, req.params.id));
      await tx.delete(channelMembers).where(eq(channelMembers.agent_id, req.params.id));
      await tx.delete(subscriptions).where(eq(subscriptions.agent_id, req.params.id));
      await tx.update(channels).set({ created_by: null }).where(eq(channels.created_by, req.params.id));
      await tx.delete(agents).where(eq(agents.id, req.params.id));
    });

    res.writeHead(204).end();
  });

  /** GET /api/v1/admin/channels - 管理员查看所有频道（含归档） */
  addRoute('GET', '/api/v1/admin/channels', authAdmin, async (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit || '50', 10) || 50, 100);
    const offset = Number.parseInt(req.query.offset || '0', 10) || 0;
    const includeArchived = req.query.includeArchived === 'true';

    const conditions = includeArchived ? [] : [eq(channels.is_archived, 0)];

    const rows = await orm.select({
      ...getTableColumns(channels),
      member_count: sql`(SELECT COUNT(*) FROM channel_members WHERE channel_id = ${channels.id})`.as('member_count'),
    }).from(channels)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(channels.created_at))
      .limit(limit)
      .offset(offset);

    sendJson(res, 200, rows);
  });

  /** POST /api/v1/admin/channels - 管理员创建频道并可直接邀请 Agent */
  addRoute('POST', '/api/v1/admin/channels', authAdmin, async (req, res) => {
    const { name, description, type } = req.body || {};
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    const resolvedType = type || 'public';
    const maxMembers = resolveMaxMembers(req.body?.maxMembers);
    const inviteAgentIds = resolveInviteAgentIds(req.body);

    if (!trimmedName) return sendJson(res, 400, { error: 'name is required' });
    if (!VALID_CHANNEL_TYPES.has(resolvedType)) return sendJson(res, 400, { error: 'Invalid channel type' });
    if (maxMembers === null) return sendJson(res, 400, { error: 'maxMembers must be a positive integer' });
    if (inviteAgentIds.length > maxMembers) return sendJson(res, 409, { error: 'Invited agents exceed maxMembers' });

    const { agents: resolvedAgents, missingIds } = await resolveRegisteredAgents(inviteAgentIds);
    if (missingIds.length > 0) {
      return sendJson(res, 404, { error: 'Some target agents were not found', missingAgentIds: missingIds });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await orm.insert(channels).values({
      id, name: trimmedName, description: description || null, type: resolvedType,
      created_by: `admin:${req.admin.id}`, max_members: maxMembers, created_at: now, updated_at: now,
    });

    const invitedAgents = await addAgentsToChannel({
      channelId: id, agents: resolvedAgents, invitedBy: `admin:${req.admin.username}`,
    });

    const [createdChannel] = await orm.select({
      ...getTableColumns(channels),
      member_count: sql`(SELECT COUNT(*) FROM channel_members WHERE channel_id = ${channels.id})`.as('member_count'),
    }).from(channels).where(eq(channels.id, id));

    ws.broadcastAll({
      type: 'channel.created',
      payload: { channel: createdChannel, creator: { id: `admin:${req.admin.id}`, name: `[Admin] ${req.admin.username}` } },
      timestamp: now,
    });

    sendJson(res, 201, { channel: createdChannel, invitedAgents });
  });

  /** GET /api/v1/admin/channels/:id - 管理员查看频道详情 */
  addRoute('GET', '/api/v1/admin/channels/:id', authAdmin, async (req, res) => {
    const [channel] = await orm.select({
      ...getTableColumns(channels),
      member_count: sql`(SELECT COUNT(*) FROM channel_members WHERE channel_id = ${channels.id})`.as('member_count'),
    }).from(channels).where(eq(channels.id, req.params.id));
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const members = await orm.select({
      ...getTableColumns(channelMembers),
      agent_name: agents.name,
      agent_status: agents.status,
    }).from(channelMembers)
      .leftJoin(agents, eq(channelMembers.agent_id, agents.id))
      .where(eq(channelMembers.channel_id, req.params.id));

    const membersWithOnline = members.map((member) => ({
      ...member,
      online: ws.isAgentOnline(member.agent_id),
    }));

    sendJson(res, 200, { ...channel, members: membersWithOnline });
  });

  /** POST /api/v1/admin/channels/:id/invite - 管理员邀请 Agent 进入频道 */
  addRoute('POST', '/api/v1/admin/channels/:id/invite', authAdmin, async (req, res) => {
    const [channel] = await orm.select().from(channels).where(eq(channels.id, req.params.id));
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });

    const inviteAgentIds = resolveInviteAgentIds(req.body);
    if (inviteAgentIds.length === 0) return sendJson(res, 400, { error: 'agentId or agentIds is required' });

    const { agents: resolvedAgents, missingIds } = await resolveRegisteredAgents(inviteAgentIds);
    if (missingIds.length > 0) {
      return sendJson(res, 404, { error: 'Some target agents were not found', missingAgentIds: missingIds });
    }

    const existingMembers = await orm.select({ agent_id: channelMembers.agent_id })
      .from(channelMembers)
      .where(and(eq(channelMembers.channel_id, req.params.id), inArray(channelMembers.agent_id, inviteAgentIds)));
    const existingMemberIds = new Set(existingMembers.map((m) => m.agent_id));
    const newAgents = resolvedAgents.filter((a) => !existingMemberIds.has(a.id));

    if (newAgents.length === 0) return sendJson(res, 409, { error: 'All target agents are already members' });

    const [cnt] = await orm.select({ cnt: count() }).from(channelMembers).where(eq(channelMembers.channel_id, req.params.id));
    if (cnt && (cnt.cnt + newAgents.length) > channel.max_members) {
      return sendJson(res, 409, { error: 'Inviting these agents would exceed maxMembers' });
    }

    const invitedAgents = await addAgentsToChannel({
      channelId: req.params.id, agents: newAgents, invitedBy: `admin:${req.admin.username}`,
    });

    sendJson(res, 200, {
      invitedAgents,
      invitedCount: invitedAgents.length,
      skippedAgentIds: inviteAgentIds.filter((id) => existingMemberIds.has(id)),
    });
  });

  /** GET /api/v1/admin/channels/:id/messages - 管理员查看频道消息 */
  addRoute('GET', '/api/v1/admin/channels/:id/messages', authAdmin, async (req, res) => {
    const [channel] = await orm.select({ id: channels.id }).from(channels).where(eq(channels.id, req.params.id));
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const limit = Math.min(Number.parseInt(req.query.limit || '50', 10) || 50, 100);
    sendJson(res, 200, await queryMessages(req.params.id, req.query.cursor, limit));
  });

  /** POST /api/v1/admin/channels/:id/messages - 管理员发送评论 */
  addRoute('POST', '/api/v1/admin/channels/:id/messages', authAdmin, async (req, res) => {
    const [channel] = await orm.select({ id: channels.id, is_archived: channels.is_archived }).from(channels).where(eq(channels.id, req.params.id));
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });

    const { content, contentType, replyTo, mentionAgentIds, discussionSessionId } = req.body;
    if (!content) return sendJson(res, 400, { error: 'content is required' });

    const senderId = `admin:${req.admin.username}`;
    const senderName = `[Admin] ${req.admin.username}`;

    try {
      const { message } = await messaging.createChannelMessage({
        channelId: req.params.id, senderId, senderName,
        content, contentType, replyTo, mentionAgentIds, discussionSessionId,
      });

      await ws.broadcastChannel(req.params.id, {
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

  /** POST /api/v1/admin/channels/:id/discussions - 管理员发起线性讨论 */
  addRoute('POST', '/api/v1/admin/channels/:id/discussions', authAdmin, async (req, res) => {
    const [channel] = await orm.select({ id: channels.id, is_archived: channels.is_archived }).from(channels).where(eq(channels.id, req.params.id));
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });

    const { content, participantAgentIds, maxRounds } = req.body || {};
    if (!content) return sendJson(res, 400, { error: 'content is required' });

    const senderId = `admin:${req.admin.username}`;
    const senderName = `[Admin] ${req.admin.username}`;

    try {
      const { message, discussion } = await messaging.createLinearDiscussionSession({
        channelId: req.params.id, senderId, senderName,
        content, participantAgentIds, maxRounds, isAgentOnline: ws.isAgentOnline,
      });

      await ws.broadcastChannel(req.params.id, {
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
  addRoute('DELETE', '/api/v1/admin/channels/:id', authAdmin, async (req, res) => {
    const [channel] = await orm.select({ id: channels.id, name: channels.name }).from(channels).where(eq(channels.id, req.params.id));
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    await deleteChannelCascade(req.params.id);
    ws.broadcastAll({
      type: 'channel.deleted',
      payload: { channelId: req.params.id, channelName: channel.name, deletedBy: `admin:${req.admin.username}` },
      timestamp: new Date().toISOString(),
      channelId: req.params.id,
    });

    res.writeHead(204).end();
  });

  /** POST /api/v1/admin/agents/:id/rotate-key - 强制轮换 API Key */
  addRoute('POST', '/api/v1/admin/agents/:id/rotate-key', authAdmin, async (req, res) => {
    const [agent] = await orm.select().from(agents).where(eq(agents.id, req.params.id));
    if (!agent) return sendJson(res, 404, { error: 'Agent not found' });

    const newKey = `af_${crypto.randomBytes(32).toString('hex')}`;
    const newHash = crypto.createHash('sha256').update(newKey).digest('hex');

    await orm.update(agents).set({ api_key_hash: newHash }).where(eq(agents.id, req.params.id));
    ws.disconnectAgent(req.params.id, 'API Key rotated');

    sendJson(res, 200, { apiKey: newKey });
  });
}
