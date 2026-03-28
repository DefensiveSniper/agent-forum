import crypto from 'crypto';
import { eq, and, or, ne, desc, lt, count, isNotNull, sql, getTableColumns } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { channels, agents, channelMembers, messages } from '../schema.mjs';
import { buildCursorPage } from '../pagination.mjs';

/**
 * 注册频道和消息相关路由。
 * @param {object} context
 */
export function registerChannelRoutes(context) {
  const { router, auth, db, sendJson, ws, messaging } = context;
  const { addRoute } = router;
  const { authAgent } = auth;
  const { orm } = db;

  const rm = alias(messages, 'rm');
  const ra = alias(agents, 'ra');

  /**
   * 校验当前 Agent 是否可访问频道。
   * @param {string} channelId
   * @param {string} agentId
   * @returns {Promise<{ channel: object, member: object|undefined }|null>}
   */
  async function getAccessibleChannel(channelId, agentId) {
    const [channel] = await orm.select().from(channels).where(eq(channels.id, channelId));
    if (!channel) return null;

    const [member] = await orm.select().from(channelMembers)
      .where(and(eq(channelMembers.channel_id, channelId), eq(channelMembers.agent_id, agentId)));

    if (channel.type === 'private' && !member) return { channel, member: undefined };
    return { channel, member };
  }

  /**
   * 将消息服务错误映射为 HTTP 响应。
   * @param {import('http').ServerResponse} res
   * @param {Error} err
   */
  function sendMessagingError(res, err) {
    const message = err?.message || 'Failed to process message';

    if (message === 'replyTo message not found in this channel') {
      sendJson(res, 400, { error: message });
      return;
    }
    if (message === 'Discussion session not found') {
      sendJson(res, 404, { error: message });
      return;
    }
    if (
      message === 'Discussion session is not active'
      || message === 'Only the expected agent can reply in this discussion session'
      || message === 'Discussion replies must reply to the latest session message'
      || message === 'Final discussion turn cannot mention the next agent'
      || message === 'Linear discussion replies must mention exactly the next agent in order'
      || message.startsWith('Some mention agents are not channel members:')
    ) {
      sendJson(res, 409, { error: message });
      return;
    }

    sendJson(res, 400, { error: message });
  }

  /**
   * 构建消息分页查询条件和结果。
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

  /** POST /api/v1/channels - 创建频道 */
  addRoute('POST', '/api/v1/channels', authAgent, async (req, res) => {
    const { name, description, type, maxMembers } = req.body;
    if (!name) return sendJson(res, 400, { error: 'name is required' });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await orm.insert(channels).values({
      id, name, description: description || null, type: type || 'public',
      created_by: req.agent.id, max_members: maxMembers || 100, created_at: now, updated_at: now,
    });

    await orm.insert(channelMembers).values({
      channel_id: id, agent_id: req.agent.id, role: 'owner', joined_at: now,
    });

    const [channel] = await orm.select().from(channels).where(eq(channels.id, id));
    ws.broadcastAll({
      type: 'channel.created',
      payload: { channel, creator: { id: req.agent.id, name: req.agent.name } },
      timestamp: now,
    });

    sendJson(res, 201, channel);
  });

  /** GET /api/v1/channels - 列出频道（公开频道 + 自己已加入的私有频道） */
  addRoute('GET', '/api/v1/channels', authAgent, async (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit || '50', 10) || 50, 100);
    const offset = Number.parseInt(req.query.offset || '0', 10) || 0;
    const agentId = req.agent.id;

    const rows = await orm.selectDistinct(getTableColumns(channels))
      .from(channels)
      .leftJoin(channelMembers, and(eq(channels.id, channelMembers.channel_id), eq(channelMembers.agent_id, agentId)))
      .where(and(
        eq(channels.is_archived, 0),
        or(ne(channels.type, 'private'), isNotNull(channelMembers.agent_id)),
      ))
      .orderBy(desc(channels.created_at))
      .limit(limit)
      .offset(offset);

    sendJson(res, 200, rows);
  });

  /** GET /api/v1/channels/:id - 获取频道详情 */
  addRoute('GET', '/api/v1/channels/:id', authAgent, async (req, res) => {
    const [channel] = await orm.select().from(channels).where(eq(channels.id, req.params.id));
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    if (channel.type === 'private') {
      const [isMember] = await orm.select({ agent_id: channelMembers.agent_id }).from(channelMembers)
        .where(and(eq(channelMembers.channel_id, req.params.id), eq(channelMembers.agent_id, req.agent.id)));
      if (!isMember) return sendJson(res, 403, { error: 'Private channel: members only' });
    }

    sendJson(res, 200, channel);
  });

  /** PATCH /api/v1/channels/:id - 更新频道 */
  addRoute('PATCH', '/api/v1/channels/:id', authAgent, async (req, res) => {
    const [role] = await orm.select({ role: channelMembers.role }).from(channelMembers)
      .where(and(eq(channelMembers.channel_id, req.params.id), eq(channelMembers.agent_id, req.agent.id)));
    if (!role || (role.role !== 'owner' && role.role !== 'admin')) {
      return sendJson(res, 403, { error: 'Only owner/admin can update' });
    }

    const { name, description, maxMembers } = req.body;
    const updates = { updated_at: new Date().toISOString() };

    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (maxMembers !== undefined) updates.max_members = maxMembers;

    await orm.update(channels).set(updates).where(eq(channels.id, req.params.id));

    const [updated] = await orm.select().from(channels).where(eq(channels.id, req.params.id));
    await ws.broadcastChannel(req.params.id, {
      type: 'channel.updated',
      payload: { channel: updated },
      timestamp: new Date().toISOString(),
    });

    sendJson(res, 200, updated);
  });

  /** DELETE /api/v1/channels/:id - 归档频道 */
  addRoute('DELETE', '/api/v1/channels/:id', authAgent, async (req, res) => {
    const [role] = await orm.select({ role: channelMembers.role }).from(channelMembers)
      .where(and(eq(channelMembers.channel_id, req.params.id), eq(channelMembers.agent_id, req.agent.id)));
    if (!role || role.role !== 'owner') return sendJson(res, 403, { error: 'Only owner can archive' });

    await orm.update(channels).set({ is_archived: 1, updated_at: new Date().toISOString() }).where(eq(channels.id, req.params.id));
    res.writeHead(204).end();
  });

  /** POST /api/v1/channels/:id/join - 加入频道 */
  addRoute('POST', '/api/v1/channels/:id/join', authAgent, async (req, res) => {
    const [channel] = await orm.select().from(channels).where(eq(channels.id, req.params.id));
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });
    if (channel.type === 'private') return sendJson(res, 403, { error: 'Private channel: must be invited by owner/admin' });

    const [existing] = await orm.select({ agent_id: channelMembers.agent_id }).from(channelMembers)
      .where(and(eq(channelMembers.channel_id, req.params.id), eq(channelMembers.agent_id, req.agent.id)));
    if (existing) return sendJson(res, 409, { error: 'Already a member' });

    const [cnt] = await orm.select({ cnt: count() }).from(channelMembers).where(eq(channelMembers.channel_id, req.params.id));
    if (cnt && cnt.cnt >= channel.max_members) return sendJson(res, 409, { error: 'Channel is full' });

    const now = new Date().toISOString();
    await orm.insert(channelMembers).values({
      channel_id: req.params.id, agent_id: req.agent.id, role: 'member', joined_at: now,
    });

    await ws.broadcastChannel(req.params.id, {
      type: 'member.joined',
      payload: { channelId: req.params.id, agentId: req.agent.id, agentName: req.agent.name },
      timestamp: now,
    });

    sendJson(res, 200, { message: 'Joined channel' });
  });

  /** POST /api/v1/channels/:id/invite - 频道 Owner/Admin 邀请 Agent 加入私有频道 */
  addRoute('POST', '/api/v1/channels/:id/invite', authAgent, async (req, res) => {
    const [channel] = await orm.select().from(channels).where(eq(channels.id, req.params.id));
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });

    const [role] = await orm.select({ role: channelMembers.role }).from(channelMembers)
      .where(and(eq(channelMembers.channel_id, req.params.id), eq(channelMembers.agent_id, req.agent.id)));
    if (!role || (role.role !== 'owner' && role.role !== 'admin')) {
      return sendJson(res, 403, { error: 'Only owner/admin can invite' });
    }

    const { agentId } = req.body;
    if (!agentId) return sendJson(res, 400, { error: 'agentId is required' });

    const [target] = await orm.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.id, agentId));
    if (!target) return sendJson(res, 404, { error: 'Target agent not found' });

    const [existingMember] = await orm.select({ agent_id: channelMembers.agent_id }).from(channelMembers)
      .where(and(eq(channelMembers.channel_id, req.params.id), eq(channelMembers.agent_id, agentId)));
    if (existingMember) return sendJson(res, 409, { error: 'Agent is already a member' });

    const [cnt] = await orm.select({ cnt: count() }).from(channelMembers).where(eq(channelMembers.channel_id, req.params.id));
    if (cnt && cnt.cnt >= channel.max_members) return sendJson(res, 409, { error: 'Channel is full' });

    const now = new Date().toISOString();
    await orm.insert(channelMembers).values({
      channel_id: req.params.id, agent_id: agentId, role: 'member', joined_at: now,
    });

    await ws.broadcastChannel(req.params.id, {
      type: 'member.joined',
      payload: { channelId: req.params.id, agentId, agentName: target.name, invitedBy: req.agent.id },
      timestamp: now,
    });

    sendJson(res, 200, { message: `Agent ${target.name} invited to channel` });
  });

  /** POST /api/v1/channels/:id/leave - 离开频道 */
  addRoute('POST', '/api/v1/channels/:id/leave', authAgent, async (req, res) => {
    await orm.delete(channelMembers)
      .where(and(eq(channelMembers.channel_id, req.params.id), eq(channelMembers.agent_id, req.agent.id)));

    await ws.broadcastChannel(req.params.id, {
      type: 'member.left',
      payload: { channelId: req.params.id, agentId: req.agent.id, agentName: req.agent.name },
      timestamp: new Date().toISOString(),
    });

    sendJson(res, 200, { message: 'Left channel' });
  });

  /** GET /api/v1/channels/:id/members - 获取频道成员 */
  addRoute('GET', '/api/v1/channels/:id/members', authAgent, async (req, res) => {
    const access = await getAccessibleChannel(req.params.id, req.agent.id);
    if (!access) return sendJson(res, 404, { error: 'Channel not found' });
    if (access.channel.type === 'private' && !access.member) {
      return sendJson(res, 403, { error: 'Private channel: members only' });
    }

    const rows = await orm.select({
      ...getTableColumns(channelMembers),
      agent_name: agents.name,
    }).from(channelMembers)
      .leftJoin(agents, eq(channelMembers.agent_id, agents.id))
      .where(eq(channelMembers.channel_id, req.params.id));

    sendJson(res, 200, rows);
  });

  /** POST /api/v1/channels/:id/messages - 发送消息 */
  addRoute('POST', '/api/v1/channels/:id/messages', authAgent, async (req, res) => {
    const [channel] = await orm.select({ is_archived: channels.is_archived }).from(channels).where(eq(channels.id, req.params.id));
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.is_archived) return sendJson(res, 403, { error: 'Channel is archived, no new messages allowed' });

    const [member] = await orm.select({ agent_id: channelMembers.agent_id }).from(channelMembers)
      .where(and(eq(channelMembers.channel_id, req.params.id), eq(channelMembers.agent_id, req.agent.id)));
    if (!member) return sendJson(res, 403, { error: 'Must be a channel member' });

    const { content, contentType, replyTo, mentionAgentIds, discussionSessionId } = req.body;
    if (!content) return sendJson(res, 400, { error: 'content is required' });

    try {
      const { message } = await messaging.createChannelMessage({
        channelId: req.params.id,
        senderId: req.agent.id,
        senderName: req.agent.name,
        content, contentType, replyTo, mentionAgentIds, discussionSessionId,
      });

      await ws.broadcastChannel(req.params.id, {
        type: 'message.new',
        payload: { message, sender: { id: req.agent.id, name: req.agent.name } },
        timestamp: message.created_at,
        channelId: req.params.id,
      });

      sendJson(res, 201, message);
    } catch (err) {
      sendMessagingError(res, err);
    }
  });

  /** GET /api/v1/channels/:id/messages - 获取消息历史（游标分页） */
  addRoute('GET', '/api/v1/channels/:id/messages', authAgent, async (req, res) => {
    const [member] = await orm.select({ agent_id: channelMembers.agent_id }).from(channelMembers)
      .where(and(eq(channelMembers.channel_id, req.params.id), eq(channelMembers.agent_id, req.agent.id)));
    if (!member) return sendJson(res, 403, { error: 'Must be a channel member' });

    const limit = Math.min(Number.parseInt(req.query.limit || '50', 10) || 50, 100);
    sendJson(res, 200, await queryMessages(req.params.id, req.query.cursor, limit));
  });

  /** GET /api/v1/channels/:id/messages/:msgId - 获取单条消息 */
  addRoute('GET', '/api/v1/channels/:id/messages/:msgId', authAgent, async (req, res) => {
    const [channel] = await orm.select({ id: channels.id }).from(channels).where(eq(channels.id, req.params.id));
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const [member] = await orm.select({ agent_id: channelMembers.agent_id }).from(channelMembers)
      .where(and(eq(channelMembers.channel_id, req.params.id), eq(channelMembers.agent_id, req.agent.id)));
    if (!member) return sendJson(res, 403, { error: 'Must be a channel member' });

    const [message] = await orm.select({
      ...getTableColumns(messages),
      sender_name: agents.name,
      reply_sender_id: rm.sender_id,
      reply_sender_name: ra.name,
      reply_content: rm.content,
    }).from(messages)
      .leftJoin(agents, eq(agents.id, messages.sender_id))
      .leftJoin(rm, eq(rm.id, messages.reply_to))
      .leftJoin(ra, eq(ra.id, rm.sender_id))
      .where(and(eq(messages.id, req.params.msgId), eq(messages.channel_id, req.params.id)));
    if (!message) return sendJson(res, 404, { error: 'Message not found' });
    sendJson(res, 200, messaging.formatMessage(message));
  });
}
