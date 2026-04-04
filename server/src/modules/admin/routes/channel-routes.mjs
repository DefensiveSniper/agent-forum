import crypto from 'crypto';
import {
  addAgentsToChannel,
  deleteChannelCascade,
  resolveInviteAgentIds,
  resolveMaxMembers,
  resolveRegisteredAgents,
} from '../support/channel-admin-helpers.mjs';
import { buildAdminMessagePage, sendAdminMessagingError } from '../support/messaging-http.mjs';

/**
 * 注册管理员频道与消息相关路由。
 * @param {object} context
 */
export function registerAdminChannelRoutes(context) {
  const { router, auth, db, sendJson, ws, messaging } = context;
  const { addRoute } = router;
  const { authAdmin } = auth;
  const VALID_CHANNEL_TYPES = new Set(['public', 'private', 'broadcast']);

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

    const { agents, missingIds } = resolveRegisteredAgents(db, inviteAgentIds);
    if (missingIds.length > 0) {
      return sendJson(res, 404, { error: 'Some target agents were not found', missingAgentIds: missingIds });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.exec(`INSERT INTO channels (id, name, description, type, created_by, max_members, created_at, updated_at)
      VALUES (${db.esc(id)}, ${db.esc(trimmedName)}, ${db.esc(description || null)}, ${db.esc(resolvedType)}, ${db.esc(`admin:${req.admin.id}`)}, ${db.esc(maxMembers)}, ${db.esc(now)}, ${db.esc(now)})`);

    const invitedAgents = addAgentsToChannel({
      db,
      ws,
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

    const { agents, missingIds } = resolveRegisteredAgents(db, inviteAgentIds);
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
      db,
      ws,
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
      cm_sender.team_role AS sender_team_role,
      rm.sender_id AS reply_sender_id,
      ra.name AS reply_sender_name,
      rm.content AS reply_content
      FROM messages m
      LEFT JOIN messages rm ON rm.id = m.reply_to
      LEFT JOIN agents ra ON ra.id = rm.sender_id
      LEFT JOIN agents a ON m.sender_id = a.id
      LEFT JOIN channel_members cm_sender ON cm_sender.channel_id = m.channel_id AND cm_sender.agent_id = m.sender_id
      WHERE m.channel_id = ${db.esc(req.params.id)}`;
    if (cursor) sql += ` AND m.created_at < ${db.esc(cursor)}`;
    sql += ` ORDER BY m.created_at DESC LIMIT ${limit + 1}`;

    sendJson(res, 200, buildAdminMessagePage(messaging, db.all(sql), limit));
  });

  /** POST /api/v1/admin/channels/:id/messages - 管理员发送评论到频道 */
  addRoute('POST', '/api/v1/admin/channels/:id/messages', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id, is_archived FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });

    const { content, contentType, replyTo, mentionAgentIds, discussionSessionId, intent } = req.body;
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
        intent,
      });

      ws.broadcastChannel(req.params.id, {
        type: 'message.new',
        payload: { message, sender: { id: senderId, name: senderName } },
        timestamp: message.created_at,
        channelId: req.params.id,
      });

      sendJson(res, 201, message);
    } catch (err) {
      sendAdminMessagingError(sendJson, res, err);
    }
  });

  /** POST /api/v1/admin/channels/:id/discussions - 管理员发起线性多 Agent 讨论 */
  addRoute('POST', '/api/v1/admin/channels/:id/discussions', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id, is_archived FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });

    const { content, participantAgentIds, maxRounds, requiresApproval, approvalAgentId, intent } = req.body || {};
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
        requiresApproval: !!requiresApproval,
        approvalAgentId: approvalAgentId || null,
        intent,
      });

      ws.broadcastChannel(req.params.id, {
        type: 'message.new',
        payload: { message, sender: { id: senderId, name: senderName } },
        timestamp: message.created_at,
        channelId: req.params.id,
      });

      sendJson(res, 201, { message, discussion });
    } catch (err) {
      sendAdminMessagingError(sendJson, res, err);
    }
  });

  /** POST /api/v1/admin/channels/:id/discussions/:sessionId/interrupt - 管理员中断讨论 */
  addRoute('POST', '/api/v1/admin/channels/:id/discussions/:sessionId/interrupt', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id, is_archived FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const senderId = `admin:${req.admin.username}`;
    const senderName = `[Admin] ${req.admin.username}`;
    const { reason } = req.body || {};

    try {
      const { message, discussion } = messaging.interruptLinearDiscussion({
        sessionId: req.params.sessionId,
        channelId: req.params.id,
        senderId,
        senderName,
        reason: reason || null,
      });

      ws.broadcastChannel(req.params.id, {
        type: 'message.new',
        payload: { message, sender: { id: senderId, name: senderName } },
        timestamp: message.created_at,
        channelId: req.params.id,
      });

      ws.broadcastChannel(req.params.id, {
        type: 'discussion.status_changed',
        payload: {
          sessionId: req.params.sessionId,
          channelId: req.params.id,
          fromStatus: discussion.status === 'cancelled' ? 'in_progress' : discussion.status,
          toStatus: 'cancelled',
          triggeredBy: senderId,
          triggeredByName: senderName,
          reason: reason || null,
        },
        timestamp: new Date().toISOString(),
        channelId: req.params.id,
      });

      sendJson(res, 200, { message, discussion });
    } catch (err) {
      sendAdminMessagingError(sendJson, res, err);
    }
  });

  /** POST /api/v1/admin/channels/:id/discussions/:sessionId/approve - 管理员审批通过讨论 */
  addRoute('POST', '/api/v1/admin/channels/:id/discussions/:sessionId/approve', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const triggeredBy = `admin:${req.admin.username}`;
    const triggeredByName = `[Admin] ${req.admin.username}`;
    const { resolution } = req.body || {};

    try {
      const result = messaging.approveDiscussion({
        sessionId: req.params.sessionId,
        channelId: req.params.id,
        triggeredBy,
        triggeredByName,
        resolution: resolution || null,
      });

      ws.broadcastChannel(req.params.id, {
        type: 'discussion.status_changed',
        payload: {
          sessionId: req.params.sessionId,
          channelId: req.params.id,
          fromStatus: result.transition.from,
          toStatus: result.transition.to,
          triggeredBy,
          triggeredByName,
          resolution: resolution || null,
        },
        timestamp: new Date().toISOString(),
        channelId: req.params.id,
      });

      sendJson(res, 200, { discussion: result.discussion });
    } catch (err) {
      sendAdminMessagingError(sendJson, res, err);
    }
  });

  /** POST /api/v1/admin/channels/:id/discussions/:sessionId/reject - 管理员拒绝讨论 */
  addRoute('POST', '/api/v1/admin/channels/:id/discussions/:sessionId/reject', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const triggeredBy = `admin:${req.admin.username}`;
    const triggeredByName = `[Admin] ${req.admin.username}`;
    const { reason } = req.body || {};

    try {
      const result = messaging.rejectDiscussion({
        sessionId: req.params.sessionId,
        channelId: req.params.id,
        triggeredBy,
        triggeredByName,
        reason: reason || null,
      });

      ws.broadcastChannel(req.params.id, {
        type: 'discussion.status_changed',
        payload: {
          sessionId: req.params.sessionId,
          channelId: req.params.id,
          fromStatus: result.transition.from,
          toStatus: result.transition.to,
          triggeredBy,
          triggeredByName,
          reason: reason || null,
        },
        timestamp: new Date().toISOString(),
        channelId: req.params.id,
      });

      sendJson(res, 200, { discussion: result.discussion });
    } catch (err) {
      sendAdminMessagingError(sendJson, res, err);
    }
  });

  /** POST /api/v1/admin/channels/:id/discussions/:sessionId/reopen - 管理员重新开启被拒绝的讨论 */
  addRoute('POST', '/api/v1/admin/channels/:id/discussions/:sessionId/reopen', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const triggeredBy = `admin:${req.admin.username}`;
    const triggeredByName = `[Admin] ${req.admin.username}`;
    const { additionalRounds } = req.body || {};

    try {
      const result = messaging.reopenDiscussion({
        sessionId: req.params.sessionId,
        channelId: req.params.id,
        triggeredBy,
        triggeredByName,
        additionalRounds: additionalRounds || 1,
      });

      ws.broadcastChannel(req.params.id, {
        type: 'discussion.status_changed',
        payload: {
          sessionId: req.params.sessionId,
          channelId: req.params.id,
          fromStatus: result.transition.from,
          toStatus: result.transition.to,
          triggeredBy,
          triggeredByName,
          additionalRounds: additionalRounds || 1,
        },
        timestamp: new Date().toISOString(),
        channelId: req.params.id,
      });

      sendJson(res, 200, { discussion: result.discussion });
    } catch (err) {
      sendAdminMessagingError(sendJson, res, err);
    }
  });

  /** GET /api/v1/admin/channels/:id/discussions/:sessionId/transitions - 获取讨论状态转换历史 */
  addRoute('GET', '/api/v1/admin/channels/:id/discussions/:sessionId/transitions', authAdmin, (req, res) => {
    const session = messaging.getDiscussionSession(req.params.sessionId);
    if (!session) return sendJson(res, 404, { error: 'Discussion session not found' });
    if (session.channel_id !== req.params.id) return sendJson(res, 404, { error: 'Discussion session not found in this channel' });

    const transitions = messaging.getDiscussionTransitions(req.params.sessionId);
    sendJson(res, 200, transitions);
  });

  /** DELETE /api/v1/admin/channels/:id - 管理员彻底删除频道 */
  addRoute('DELETE', '/api/v1/admin/channels/:id', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id, name FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    deleteChannelCascade(db, req.params.id);
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
}
