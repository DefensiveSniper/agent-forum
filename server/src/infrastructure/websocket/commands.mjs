import crypto from 'crypto';

/**
 * 创建 Agent WebSocket 命令处理器。
 * @param {object} options
 * @param {object} options.db
 * @param {object} options.messaging
 * @param {Function} options.isRateLimited
 * @param {Function} options.tryParseJson
 * @param {Function} options.reply
 * @param {Function} options.broadcastChannel
 * @returns {Function}
 */
export function createAgentWsCommandHandler({ db, messaging, isRateLimited, tryParseJson, reply, broadcastChannel }) {
  /**
   * 将消息服务抛出的错误映射为 WebSocket 错误码。
   * @param {Error} err
   * @returns {{ code: string, message: string }}
   */
  function mapMessagingError(err) {
    const message = err?.message || 'Failed to send message';

    if (
      message === 'replyTo message not found in this channel'
      || message === 'Discussion session not found'
      || message === 'Discussion session is not active'
      || message === 'Only the expected agent can reply in this discussion session'
      || message === 'Discussion replies must reply to the latest session message'
      || message === 'Final discussion turn cannot mention the next agent'
      || message === 'Linear discussion replies must mention exactly the next agent in order'
      || message.startsWith('Some mention agents are not channel members:')
    ) {
      return { code: 'INVALID_PAYLOAD', message };
    }

    return { code: 'INTERNAL_ERROR', message };
  }

  /**
   * 处理 subscribe 命令。
   * @param {object} conn
   * @param {object} agent
   * @param {string} reqId
   * @param {object} payload
   */
  function handleWsSubscribe(conn, agent, reqId, payload) {
    if (!payload || !payload.channelId) {
      return reply(conn, reqId, false, { code: 'INVALID_PAYLOAD', message: 'channelId is required' });
    }

    const { channelId, eventTypes } = payload;
    const channel = db.get(`SELECT id, is_archived FROM channels WHERE id = ${db.esc(channelId)}`);
    if (!channel) {
      return reply(conn, reqId, false, { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' });
    }

    const member = db.get(`SELECT agent_id FROM channel_members WHERE channel_id = ${db.esc(channelId)} AND agent_id = ${db.esc(agent.id)}`);
    if (!member) {
      return reply(conn, reqId, false, { code: 'NOT_MEMBER', message: 'Must be a channel member to subscribe' });
    }

    const existing = db.get(`SELECT id FROM subscriptions WHERE agent_id = ${db.esc(agent.id)} AND channel_id = ${db.esc(channelId)}`);
    const resolvedEventTypes = Array.isArray(eventTypes) && eventTypes.length > 0 ? eventTypes : ['*'];
    const now = new Date().toISOString();

    if (existing) {
      db.exec(`UPDATE subscriptions SET event_types = ${db.esc(JSON.stringify(resolvedEventTypes))} WHERE id = ${db.esc(existing.id)}`);
      return reply(conn, reqId, true, {
        subscriptionId: existing.id,
        channelId,
        eventTypes: resolvedEventTypes,
        updated: true,
      });
    }

    const id = crypto.randomUUID();
    db.exec(`INSERT INTO subscriptions (id, agent_id, channel_id, event_types, created_at)
      VALUES (${db.esc(id)}, ${db.esc(agent.id)}, ${db.esc(channelId)}, ${db.esc(JSON.stringify(resolvedEventTypes))}, ${db.esc(now)})`);

    return reply(conn, reqId, true, {
      subscriptionId: id,
      channelId,
      eventTypes: resolvedEventTypes,
      createdAt: now,
    });
  }

  /**
   * 处理 unsubscribe 命令。
   * @param {object} conn
   * @param {object} agent
   * @param {string} reqId
   * @param {object} payload
   */
  function handleWsUnsubscribe(conn, agent, reqId, payload) {
    if (!payload || (!payload.channelId && !payload.subscriptionId)) {
      return reply(conn, reqId, false, { code: 'INVALID_PAYLOAD', message: 'channelId or subscriptionId is required' });
    }

    if (payload.subscriptionId) {
      const subscription = db.get(`SELECT id FROM subscriptions WHERE id = ${db.esc(payload.subscriptionId)} AND agent_id = ${db.esc(agent.id)}`);
      if (!subscription) {
        return reply(conn, reqId, false, { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Subscription not found' });
      }

      db.exec(`DELETE FROM subscriptions WHERE id = ${db.esc(payload.subscriptionId)} AND agent_id = ${db.esc(agent.id)}`);
      return reply(conn, reqId, true, { deleted: true });
    }

    const subscription = db.get(`SELECT id FROM subscriptions WHERE channel_id = ${db.esc(payload.channelId)} AND agent_id = ${db.esc(agent.id)}`);
    if (!subscription) {
      return reply(conn, reqId, false, { code: 'SUBSCRIPTION_NOT_FOUND', message: 'No subscription found for this channel' });
    }

    db.exec(`DELETE FROM subscriptions WHERE channel_id = ${db.esc(payload.channelId)} AND agent_id = ${db.esc(agent.id)}`);
    return reply(conn, reqId, true, { deleted: true });
  }

  /**
   * 处理 message.send 命令。
   * @param {object} conn
   * @param {object} agent
   * @param {string} reqId
   * @param {object} payload
   */
  function handleWsMessageSend(conn, agent, reqId, payload) {
    if (!payload || !payload.channelId || !payload.content) {
      return reply(conn, reqId, false, { code: 'INVALID_PAYLOAD', message: 'channelId and content are required' });
    }

    const { channelId, content, contentType, replyTo, mentionAgentIds, discussionSessionId, intent } = payload;
    const channel = db.get(`SELECT id, is_archived FROM channels WHERE id = ${db.esc(channelId)}`);

    if (!channel) {
      return reply(conn, reqId, false, { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' });
    }
    if (channel.is_archived) {
      return reply(conn, reqId, false, { code: 'CHANNEL_ARCHIVED', message: 'Channel is archived, no new messages allowed' });
    }

    const member = db.get(`SELECT agent_id FROM channel_members WHERE channel_id = ${db.esc(channelId)} AND agent_id = ${db.esc(agent.id)}`);
    if (!member) {
      return reply(conn, reqId, false, { code: 'NOT_MEMBER', message: 'Must be a channel member to send messages' });
    }

    if (isRateLimited(`ws:msg:${agent.id}`, 30, 60000)) {
      return reply(conn, reqId, false, { code: 'RATE_LIMITED', message: 'Message sending rate limit exceeded' });
    }

    try {
      const { message } = messaging.createChannelMessage({
        channelId,
        senderId: agent.id,
        senderName: agent.name,
        content,
        contentType,
        replyTo,
        mentionAgentIds,
        discussionSessionId,
        intent,
      });

      broadcastChannel(channelId, {
        type: 'message.new',
        payload: { message, sender: { id: agent.id, name: agent.name } },
        timestamp: message.created_at,
        channelId,
      });

      return reply(conn, reqId, true, { message });
    } catch (err) {
      return reply(conn, reqId, false, mapMessagingError(err));
    }
  }

  /**
   * 处理 message.update_intent 命令。
   * @param {object} conn
   * @param {object} agent
   * @param {string} reqId
   * @param {object} payload
   */
  function handleWsUpdateIntent(conn, agent, reqId, payload) {
    if (!payload || !payload.channelId || !payload.messageId || !payload.intent) {
      return reply(conn, reqId, false, { code: 'INVALID_PAYLOAD', message: 'channelId, messageId, and intent are required' });
    }

    const { channelId, messageId, intent } = payload;

    const member = db.get(`SELECT agent_id FROM channel_members WHERE channel_id = ${db.esc(channelId)} AND agent_id = ${db.esc(agent.id)}`);
    if (!member) {
      return reply(conn, reqId, false, { code: 'NOT_MEMBER', message: 'Must be a channel member' });
    }

    const existing = db.get(`SELECT id FROM messages WHERE id = ${db.esc(messageId)} AND channel_id = ${db.esc(channelId)}`);
    if (!existing) {
      return reply(conn, reqId, false, { code: 'MESSAGE_NOT_FOUND', message: 'Message not found in this channel' });
    }

    try {
      messaging.validateIntent(intent);
    } catch (err) {
      return reply(conn, reqId, false, { code: 'INVALID_PAYLOAD', message: err.message });
    }

    const updated = messaging.updateMessageIntent(messageId, intent);
    if (!updated) {
      return reply(conn, reqId, false, { code: 'INTERNAL_ERROR', message: 'Failed to update intent' });
    }

    broadcastChannel(channelId, {
      type: 'message.intent_updated',
      payload: {
        messageId,
        channelId,
        intent: updated.intent,
        updatedBy: { id: agent.id, name: agent.name },
      },
      timestamp: new Date().toISOString(),
      channelId,
    });

    return reply(conn, reqId, true, { message: updated });
  }

  /**
   * 处理 Agent 通过 WebSocket 发送的命令。
   * @param {object} conn
   * @param {object} agent
   * @param {object} msg
   */
  return function handleAgentWsCommand(conn, agent, msg) {
    const { id: reqId, action, payload } = msg;

    if (!reqId || !action) {
      return reply(conn, reqId || 'unknown', false, { code: 'INVALID_FORMAT', message: 'id and action are required' });
    }

    if (isRateLimited(`ws:${agent.id}`, 60, 60000)) {
      return reply(conn, reqId, false, { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' });
    }

    switch (action) {
      case 'subscribe':
        return handleWsSubscribe(conn, agent, reqId, payload);
      case 'unsubscribe':
        return handleWsUnsubscribe(conn, agent, reqId, payload);
      case 'message.send':
        return handleWsMessageSend(conn, agent, reqId, payload);
      case 'message.update_intent':
        return handleWsUpdateIntent(conn, agent, reqId, payload);
      default:
        return reply(conn, reqId, false, { code: 'UNKNOWN_ACTION', message: `Unknown action: ${action}` });
    }
  };
}
