import { buildChannelMessagePage, sendChannelMessagingError } from '../support/http.mjs';

/**
 * 注册频道消息相关路由。
 * @param {object} context
 */
export function registerChannelMessageRoutes(context) {
  const { router, auth, db, sendJson, ws, messaging, policy } = context;
  const { addRoute } = router;
  const { authAgent } = auth;

  /** POST /api/v1/channels/:id/messages - 发送消息（归档频道禁止写入） */
  addRoute('POST', '/api/v1/channels/:id/messages', authAgent, (req, res) => {
    const channel = db.get(`SELECT is_archived FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.is_archived) return sendJson(res, 403, { error: 'Channel is archived, no new messages allowed' });

    const member = db.get(`SELECT agent_id FROM channel_members WHERE channel_id = ${db.esc(req.params.id)} AND agent_id = ${db.esc(req.agent.id)}`);
    if (!member) return sendJson(res, 403, { error: 'Must be a channel member' });

    const { content, contentType, replyTo, mentionAgentIds, discussionSessionId, intent } = req.body;
    if (!content) return sendJson(res, 400, { error: 'content is required' });

    if (policy) {
      const check = policy.validateMessage(req.params.id, req.agent.id, { intent });
      if (!check.ok) return sendJson(res, 403, { error: { code: check.code, message: check.message, policy: check.policy } });
    }

    try {
      const { message } = messaging.createChannelMessage({
        channelId: req.params.id,
        senderId: req.agent.id,
        senderName: req.agent.name,
        content,
        contentType,
        replyTo,
        mentionAgentIds,
        discussionSessionId,
        intent,
      });

      ws.broadcastChannel(req.params.id, {
        type: 'message.new',
        payload: { message, sender: { id: req.agent.id, name: req.agent.name } },
        timestamp: message.created_at,
        channelId: req.params.id,
      });

      sendJson(res, 201, message);
    } catch (err) {
      sendChannelMessagingError(sendJson, res, err);
    }
  });

  /** GET /api/v1/channels/:id/messages - 获取消息历史（游标分页） */
  addRoute('GET', '/api/v1/channels/:id/messages', authAgent, (req, res) => {
    const member = db.get(`SELECT agent_id FROM channel_members WHERE channel_id = ${db.esc(req.params.id)} AND agent_id = ${db.esc(req.agent.id)}`);
    if (!member) return sendJson(res, 403, { error: 'Must be a channel member' });

    const limit = Math.min(Number.parseInt(req.query.limit || '50', 10) || 50, 100);
    const cursor = req.query.cursor;
    const intentTaskType = req.query.intent_task_type || null;
    const intentPriority = req.query.intent_priority || null;
    const intentRequiresApproval = req.query.intent_requires_approval || null;

    let sql = `SELECT m.*, a.name AS sender_name,
      cm_sender.team_role AS sender_team_role,
      rm.sender_id AS reply_sender_id,
      ra.name AS reply_sender_name,
      rm.content AS reply_content
      FROM messages m
      LEFT JOIN messages rm ON rm.id = m.reply_to
      LEFT JOIN agents ra ON ra.id = rm.sender_id
      LEFT JOIN agents a ON a.id = m.sender_id
      LEFT JOIN channel_members cm_sender ON cm_sender.channel_id = m.channel_id AND cm_sender.agent_id = m.sender_id
      WHERE m.channel_id = ${db.esc(req.params.id)}`;
    if (cursor) sql += ` AND m.created_at < ${db.esc(cursor)}`;
    if (intentTaskType) {
      sql += ` AND json_extract(m.intent, '$.task_type') = ${db.esc(intentTaskType)}`;
    }
    if (intentPriority) {
      sql += ` AND json_extract(m.intent, '$.priority') = ${db.esc(intentPriority)}`;
    }
    if (intentRequiresApproval === 'true') {
      sql += ` AND json_extract(m.intent, '$.requires_approval') = 1`;
    }
    sql += ` ORDER BY m.created_at DESC LIMIT ${limit + 1}`;

    sendJson(res, 200, buildChannelMessagePage(messaging, db.all(sql), limit));
  });

  /** GET /api/v1/channels/:id/messages/:msgId - 获取单条消息 */
  addRoute('GET', '/api/v1/channels/:id/messages/:msgId', authAgent, (req, res) => {
    const channel = db.get(`SELECT id FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const member = db.get(`SELECT agent_id FROM channel_members
      WHERE channel_id = ${db.esc(req.params.id)}
        AND agent_id = ${db.esc(req.agent.id)}`);
    if (!member) return sendJson(res, 403, { error: 'Must be a channel member' });

    const message = db.get(`SELECT m.*, a.name AS sender_name,
      cm_sender.team_role AS sender_team_role,
      rm.sender_id AS reply_sender_id,
      ra.name AS reply_sender_name,
      rm.content AS reply_content
      FROM messages m
      LEFT JOIN messages rm ON rm.id = m.reply_to
      LEFT JOIN agents ra ON ra.id = rm.sender_id
      LEFT JOIN agents a ON a.id = m.sender_id
      LEFT JOIN channel_members cm_sender ON cm_sender.channel_id = m.channel_id AND cm_sender.agent_id = m.sender_id
      WHERE m.id = ${db.esc(req.params.msgId)}
        AND m.channel_id = ${db.esc(req.params.id)}`);
    if (!message) return sendJson(res, 404, { error: 'Message not found' });
    sendJson(res, 200, messaging.formatMessage(message));
  });

  /** PATCH /api/v1/channels/:id/messages/:msgId/intent - 更新消息 intent（如审批状态） */
  addRoute('PATCH', '/api/v1/channels/:id/messages/:msgId/intent', authAgent, (req, res) => {
    const member = db.get(`SELECT agent_id FROM channel_members
      WHERE channel_id = ${db.esc(req.params.id)}
        AND agent_id = ${db.esc(req.agent.id)}`);
    if (!member) return sendJson(res, 403, { error: 'Must be a channel member' });

    const existing = db.get(`SELECT id, sender_id, intent FROM messages
      WHERE id = ${db.esc(req.params.msgId)}
        AND channel_id = ${db.esc(req.params.id)}`);
    if (!existing) return sendJson(res, 404, { error: 'Message not found' });

    const patch = req.body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return sendJson(res, 400, { error: 'Request body must be a JSON object' });
    }

    try {
      messaging.validateIntent(patch);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const updated = messaging.updateMessageIntent(req.params.msgId, patch);
    if (!updated) return sendJson(res, 500, { error: 'Failed to update intent' });

    ws.broadcastChannel(req.params.id, {
      type: 'message.intent_updated',
      payload: {
        messageId: req.params.msgId,
        channelId: req.params.id,
        intent: updated.intent,
        updatedBy: { id: req.agent.id, name: req.agent.name },
      },
      timestamp: new Date().toISOString(),
      channelId: req.params.id,
    });

    sendJson(res, 200, updated);
  });
}
