import crypto from 'crypto';
import { URL } from 'url';

/**
 * 创建 WebSocket 服务。
 * @param {object} options
 * @param {object} options.db
 * @param {object} options.messaging
 * @param {Function} options.verifyJwt
 * @param {Function} options.isRateLimited
 * @param {Function} options.tryParseJson
 * @returns {object}
 */
export function createWebSocketService({ db, messaging, verifyJwt, isRateLimited, tryParseJson }) {
  const wsConnections = new Map();
  const wsAdminConnections = new Map();
  let heartbeatTimer = null;

  /**
   * 生成 WebSocket 握手接受密钥。
   * @param {string} key
   * @returns {string}
   */
  function wsAcceptKey(key) {
    return crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  }

  /**
   * 编码 WebSocket 帧。
   * @param {object|string} data
   * @returns {Buffer}
   */
  function wsEncode(data) {
    const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
    const len = payload.length;
    let header;

    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }

    return Buffer.concat([header, payload]);
  }

  /**
   * 解码 WebSocket 帧。
   * @param {Buffer} buffer
   * @returns {object|null}
   */
  function wsDecode(buffer) {
    if (buffer.length < 2) return null;

    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let payloadLen = buffer[1] & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buffer.length < 4) return null;
      payloadLen = buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (buffer.length < 10) return null;
      payloadLen = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }

    let maskKey;
    if (masked) {
      if (buffer.length < offset + 4) return null;
      maskKey = buffer.slice(offset, offset + 4);
      offset += 4;
    }

    if (buffer.length < offset + payloadLen) return null;

    let payload = buffer.slice(offset, offset + payloadLen);
    if (masked && maskKey) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= maskKey[i % 4];
      }
    }

    return { opcode, payload: payload.toString('utf-8'), totalLen: offset + payloadLen };
  }

  /**
   * 向指定 socket 发送消息。
   * @param {import('net').Socket} socket
   * @param {object} msg
   */
  function send(socket, msg) {
    try {
      if (!socket.destroyed) socket.write(wsEncode(msg));
    } catch {}
  }

  /**
   * 向所有管理员 WebSocket 连接广播消息。
   * @param {object} msg
   */
  function broadcastAdmins(msg) {
    for (const conns of wsAdminConnections.values()) {
      conns.forEach((conn) => send(conn.socket, msg));
    }
  }

  /**
   * 向所有在线 Agent 连接广播消息。
   * @param {object} msg
   */
  function broadcastAll(msg) {
    for (const conns of wsConnections.values()) {
      conns.forEach((conn) => send(conn.socket, msg));
    }

    broadcastAdmins(msg);
  }

  /**
   * 向频道相关成员和订阅者广播消息。
   * @param {string} channelId
   * @param {object} msg
   */
  function broadcastChannel(channelId, msg) {
    const sentAgentIds = new Set();
    const members = db.all(`SELECT agent_id FROM channel_members WHERE channel_id = ${db.esc(channelId)}`);

    for (const member of members) {
      sentAgentIds.add(member.agent_id);
      const conns = wsConnections.get(member.agent_id);
      if (conns) conns.forEach((conn) => send(conn.socket, msg));
    }

    const eventType = msg.type || '';
    const subscriptions = db.all(`SELECT agent_id, event_types FROM subscriptions WHERE channel_id = ${db.esc(channelId)}`);

    for (const subscription of subscriptions) {
      if (sentAgentIds.has(subscription.agent_id)) continue;

      const eventTypes = tryParseJson(subscription.event_types);
      if (Array.isArray(eventTypes) && !eventTypes.includes(eventType) && !eventTypes.includes('*')) continue;

      sentAgentIds.add(subscription.agent_id);
      const conns = wsConnections.get(subscription.agent_id);
      if (conns) conns.forEach((conn) => send(conn.socket, msg));
    }

    broadcastAdmins(msg);
  }

  /**
   * 向 Agent 返回 WebSocket 命令响应。
   * @param {object} conn
   * @param {string} reqId
   * @param {boolean} ok
   * @param {object} dataOrError
   */
  function reply(conn, reqId, ok, dataOrError) {
    const response = { type: 'response', id: reqId, ok };
    if (ok) response.data = dataOrError;
    else response.error = dataOrError;
    send(conn.socket, response);
  }

  /**
   * 将消息服务抛出的错误映射为 WebSocket 错误码。
   * @param {Error} err
   * @returns {{ code: string, message: string }}
   */
  function mapMessagingError(err) {
    const message = err?.message || 'Failed to send message';

    if (message === 'replyTo message not found in this channel') {
      return { code: 'INVALID_PAYLOAD', message };
    }
    if (message === 'Discussion session not found') {
      return { code: 'INVALID_PAYLOAD', message };
    }
    if (message === 'Discussion session is not active') {
      return { code: 'INVALID_PAYLOAD', message };
    }
    if (message === 'Only the expected agent can reply in this discussion session') {
      return { code: 'INVALID_PAYLOAD', message };
    }
    if (message === 'Discussion replies must reply to the latest session message') {
      return { code: 'INVALID_PAYLOAD', message };
    }
    if (message === 'Final discussion turn cannot mention the next agent') {
      return { code: 'INVALID_PAYLOAD', message };
    }
    if (message === 'Linear discussion replies must mention exactly the next agent in order') {
      return { code: 'INVALID_PAYLOAD', message };
    }
    if (message.startsWith('Some mention agents are not channel members:')) {
      return { code: 'INVALID_PAYLOAD', message };
    }

    return { code: 'INTERNAL_ERROR', message };
  }

  /**
   * 移除 Agent WebSocket 连接并在必要时广播离线事件。
   * @param {string} agentId
   * @param {import('net').Socket} socket
   */
  function removeAgentConnection(agentId, socket) {
    const conns = wsConnections.get(agentId);
    if (!conns) return;

    const existed = conns.some((conn) => conn.socket === socket);
    if (!existed) return;

    const filtered = conns.filter((conn) => conn.socket !== socket);
    if (filtered.length === 0) {
      wsConnections.delete(agentId);
      const agent = db.get(`SELECT name FROM agents WHERE id = ${db.esc(agentId)}`);
      broadcastAll({
        type: 'agent.offline',
        payload: { agentId, agentName: agent?.name || '' },
        timestamp: new Date().toISOString(),
      });
      console.log(`🔌 WS: ${agent?.name || agentId} disconnected`);
      return;
    }

    wsConnections.set(agentId, filtered);
  }

  /**
   * 移除管理员 WebSocket 连接。
   * @param {string} adminId
   * @param {import('net').Socket} socket
   * @param {string} username
   */
  function removeAdminConnection(adminId, socket, username) {
    const conns = wsAdminConnections.get(adminId);
    if (!conns) return;

    const existed = conns.some((conn) => conn.socket === socket);
    if (!existed) return;

    const filtered = conns.filter((conn) => conn.socket !== socket);
    if (filtered.length === 0) wsAdminConnections.delete(adminId);
    else wsAdminConnections.set(adminId, filtered);

    if (username) {
      console.log(`🔌 WS Admin: ${username} disconnected`);
    }
  }

  /**
   * 处理 subscribe 命令。
   * @param {object} conn
   * @param {object} agent
   * @param {string} reqId
   * @param {object} payload
   * @returns {void}
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
   * @returns {void}
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
   * @returns {void}
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
   * 处理 message.update_intent 命令，更新消息的 intent 字段。
   * @param {object} conn
   * @param {object} agent
   * @param {string} reqId
   * @param {object} payload
   * @returns {void}
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
   * @returns {void}
   */
  function handleAgentWsCommand(conn, agent, msg) {
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
  }

  /**
   * 完成 WebSocket 握手。
   * @param {import('http').IncomingMessage} req
   * @param {import('net').Socket} socket
   */
  function completeHandshake(req, socket) {
    const key = req.headers['sec-websocket-key'];
    const accept = wsAcceptKey(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
  }

  /**
   * 处理管理员 WebSocket 升级。
   * @param {import('http').IncomingMessage} req
   * @param {import('net').Socket} socket
   * @param {URL} url
   */
  function handleAdminUpgrade(req, socket, url) {
    const token = url.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const payload = verifyJwt(token);
    if (!payload) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const admin = db.get(`SELECT * FROM admin_users WHERE id = ${db.esc(payload.id)}`);
    if (!admin) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    completeHandshake(req, socket);

    const conn = { socket, adminId: admin.id, alive: true };
    if (!wsAdminConnections.has(admin.id)) wsAdminConnections.set(admin.id, []);
    wsAdminConnections.get(admin.id).push(conn);

    console.log(`🔌 WS Admin: ${admin.username} connected`);

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (true) {
        const frame = wsDecode(buffer);
        if (!frame) break;
        buffer = buffer.slice(frame.totalLen);

        if (frame.opcode === 0x08) {
          socket.end();
          return;
        }
        if (frame.opcode === 0x0a) {
          conn.alive = true;
          continue;
        }
        if (frame.opcode === 0x01) {
          try {
            const msg = JSON.parse(frame.payload);
            if (msg.type === 'pong') conn.alive = true;
          } catch {}
        }
      }
    });

    const cleanup = () => removeAdminConnection(admin.id, socket, admin.username);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  /**
   * 处理 WebSocket 升级请求。
   * @param {import('http').IncomingMessage} req
   * @param {import('net').Socket} socket
   */
  function handleUpgrade(req, socket) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname === '/ws/admin') {
      handleAdminUpgrade(req, socket, url);
      return;
    }

    const apiKey = url.searchParams.get('apiKey');
    if (!apiKey) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const agent = db.get(`SELECT id, name, status FROM agents WHERE api_key_hash = ${db.esc(apiKeyHash)}`);

    if (!agent) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (agent.status === 'suspended') {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const existingConnections = wsConnections.get(agent.id) || [];
    if (existingConnections.length >= 5) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }

    completeHandshake(req, socket);

    const conn = { socket, agentId: agent.id, agentName: agent.name, alive: true };
    if (!wsConnections.has(agent.id)) wsConnections.set(agent.id, []);
    wsConnections.get(agent.id).push(conn);

    broadcastAll({
      type: 'agent.online',
      payload: { agentId: agent.id, agentName: agent.name },
      timestamp: new Date().toISOString(),
    });

    console.log(`🔌 WS: ${agent.name} connected (${(wsConnections.get(agent.id) || []).length} connections)`);

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (true) {
        const frame = wsDecode(buffer);
        if (!frame) break;
        buffer = buffer.slice(frame.totalLen);

        if (frame.opcode === 0x08) {
          socket.end();
          return;
        }
        if (frame.opcode === 0x0a) {
          conn.alive = true;
          continue;
        }
        if (frame.opcode === 0x01) {
          try {
            const msg = JSON.parse(frame.payload);
            if (msg.type === 'pong') {
              conn.alive = true;
              continue;
            }
            if (msg.action) handleAgentWsCommand(conn, agent, msg);
          } catch {}
        }
      }
    });

    socket.on('close', () => removeAgentConnection(agent.id, socket));
    socket.on('error', () => removeAgentConnection(agent.id, socket));
  }

  /**
   * 断开指定 Agent 的全部连接。
   * @param {string} agentId
   * @param {string} reason
   */
  function disconnectAgent(agentId, reason) {
    const conns = wsConnections.get(agentId);
    if (!conns) return;

    conns.forEach((conn) => {
      send(conn.socket, {
        type: 'agent.suspended',
        payload: { reason },
        timestamp: new Date().toISOString(),
      });

      try {
        conn.socket.end();
      } catch {}
    });

    wsConnections.delete(agentId);
  }

  /**
   * 判断 Agent 是否在线。
   * @param {string} agentId
   * @returns {boolean}
   */
  function isAgentOnline(agentId) {
    return wsConnections.has(agentId);
  }

  /**
   * 获取当前连接统计信息。
   * @returns {object}
   */
  function getConnectionStats() {
    let totalConnections = 0;
    let adminConnections = 0;

    for (const conns of wsConnections.values()) totalConnections += conns.length;
    for (const conns of wsAdminConnections.values()) adminConnections += conns.length;

    return {
      onlineAgents: wsConnections.size,
      totalConnections,
      adminConnections,
    };
  }

  /**
   * 启动心跳检测定时器。
   */
  function startHeartbeat() {
    if (heartbeatTimer) return;

    heartbeatTimer = setInterval(() => {
      const pingMsg = { type: 'ping', payload: {}, timestamp: new Date().toISOString() };

      for (const [agentId, conns] of wsConnections) {
        for (const conn of [...conns]) {
          if (!conn.alive) {
            try {
              conn.socket.end();
            } catch {}
            removeAgentConnection(agentId, conn.socket);
            continue;
          }

          conn.alive = false;
          send(conn.socket, pingMsg);
        }
      }

      for (const [adminId, conns] of wsAdminConnections) {
        for (const conn of [...conns]) {
          if (!conn.alive) {
            try {
              conn.socket.end();
            } catch {}
            removeAdminConnection(adminId, conn.socket);
            continue;
          }

          conn.alive = false;
          send(conn.socket, pingMsg);
        }
      }
    }, 30000);

    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  }

  /**
   * 停止心跳检测定时器。
   */
  function stopHeartbeat() {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  return {
    handleUpgrade,
    broadcastChannel,
    broadcastAll,
    broadcastAdmins,
    disconnectAgent,
    isAgentOnline,
    getConnectionStats,
    startHeartbeat,
    stopHeartbeat,
  };
}
