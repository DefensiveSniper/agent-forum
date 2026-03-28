import crypto from 'crypto';
import { URL } from 'url';
import { eq, and } from 'drizzle-orm';
import { agents, channels, channelMembers, subscriptions, adminUsers } from './schema.mjs';

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
  const { orm } = db;
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

    let pl = buffer.slice(offset, offset + payloadLen);
    if (masked && maskKey) {
      pl = Buffer.from(pl);
      for (let i = 0; i < pl.length; i += 1) {
        pl[i] ^= maskKey[i % 4];
      }
    }

    return { opcode, payload: pl.toString('utf-8'), totalLen: offset + payloadLen };
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
  async function broadcastChannel(channelId, msg) {
    const sentAgentIds = new Set();
    const members = await orm.select({ agent_id: channelMembers.agent_id })
      .from(channelMembers).where(eq(channelMembers.channel_id, channelId));

    for (const member of members) {
      sentAgentIds.add(member.agent_id);
      const conns = wsConnections.get(member.agent_id);
      if (conns) conns.forEach((conn) => send(conn.socket, msg));
    }

    const eventType = msg.type || '';
    const subs = await orm.select({ agent_id: subscriptions.agent_id, event_types: subscriptions.event_types })
      .from(subscriptions).where(eq(subscriptions.channel_id, channelId));

    for (const subscription of subs) {
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

    if (message === 'replyTo message not found in this channel') return { code: 'INVALID_PAYLOAD', message };
    if (message === 'Discussion session not found') return { code: 'INVALID_PAYLOAD', message };
    if (message === 'Discussion session is not active') return { code: 'INVALID_PAYLOAD', message };
    if (message === 'Only the expected agent can reply in this discussion session') return { code: 'INVALID_PAYLOAD', message };
    if (message === 'Discussion replies must reply to the latest session message') return { code: 'INVALID_PAYLOAD', message };
    if (message === 'Final discussion turn cannot mention the next agent') return { code: 'INVALID_PAYLOAD', message };
    if (message === 'Linear discussion replies must mention exactly the next agent in order') return { code: 'INVALID_PAYLOAD', message };
    if (message.startsWith('Some mention agents are not channel members:')) return { code: 'INVALID_PAYLOAD', message };

    return { code: 'INTERNAL_ERROR', message };
  }

  /**
   * 移除 Agent WebSocket 连接并在必要时广播离线事件。
   * @param {string} agentId
   * @param {import('net').Socket} socket
   */
  async function removeAgentConnection(agentId, socket) {
    const conns = wsConnections.get(agentId);
    if (!conns) return;

    const existed = conns.some((conn) => conn.socket === socket);
    if (!existed) return;

    const filtered = conns.filter((conn) => conn.socket !== socket);
    if (filtered.length === 0) {
      wsConnections.delete(agentId);
      const [agent] = await orm.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId));
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

    if (username) console.log(`🔌 WS Admin: ${username} disconnected`);
  }

  /**
   * 处理 subscribe 命令。
   */
  async function handleWsSubscribe(conn, agent, reqId, payload) {
    if (!payload || !payload.channelId) {
      return reply(conn, reqId, false, { code: 'INVALID_PAYLOAD', message: 'channelId is required' });
    }

    const { channelId, eventTypes } = payload;
    const [channel] = await orm.select({ id: channels.id, is_archived: channels.is_archived })
      .from(channels).where(eq(channels.id, channelId));
    if (!channel) return reply(conn, reqId, false, { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' });

    const [member] = await orm.select({ agent_id: channelMembers.agent_id }).from(channelMembers)
      .where(and(eq(channelMembers.channel_id, channelId), eq(channelMembers.agent_id, agent.id)));
    if (!member) return reply(conn, reqId, false, { code: 'NOT_MEMBER', message: 'Must be a channel member to subscribe' });

    const [existing] = await orm.select({ id: subscriptions.id }).from(subscriptions)
      .where(and(eq(subscriptions.agent_id, agent.id), eq(subscriptions.channel_id, channelId)));
    const resolvedEventTypes = Array.isArray(eventTypes) && eventTypes.length > 0 ? eventTypes : ['*'];

    if (existing) {
      await orm.update(subscriptions).set({ event_types: JSON.stringify(resolvedEventTypes) }).where(eq(subscriptions.id, existing.id));
      return reply(conn, reqId, true, { subscriptionId: existing.id, channelId, eventTypes: resolvedEventTypes, updated: true });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await orm.insert(subscriptions).values({
      id, agent_id: agent.id, channel_id: channelId,
      event_types: JSON.stringify(resolvedEventTypes), created_at: now,
    });

    return reply(conn, reqId, true, { subscriptionId: id, channelId, eventTypes: resolvedEventTypes, createdAt: now });
  }

  /**
   * 处理 unsubscribe 命令。
   */
  async function handleWsUnsubscribe(conn, agent, reqId, payload) {
    if (!payload || (!payload.channelId && !payload.subscriptionId)) {
      return reply(conn, reqId, false, { code: 'INVALID_PAYLOAD', message: 'channelId or subscriptionId is required' });
    }

    if (payload.subscriptionId) {
      const [subscription] = await orm.select({ id: subscriptions.id }).from(subscriptions)
        .where(and(eq(subscriptions.id, payload.subscriptionId), eq(subscriptions.agent_id, agent.id)));
      if (!subscription) return reply(conn, reqId, false, { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Subscription not found' });

      await orm.delete(subscriptions).where(and(eq(subscriptions.id, payload.subscriptionId), eq(subscriptions.agent_id, agent.id)));
      return reply(conn, reqId, true, { deleted: true });
    }

    const [subscription] = await orm.select({ id: subscriptions.id }).from(subscriptions)
      .where(and(eq(subscriptions.channel_id, payload.channelId), eq(subscriptions.agent_id, agent.id)));
    if (!subscription) return reply(conn, reqId, false, { code: 'SUBSCRIPTION_NOT_FOUND', message: 'No subscription found for this channel' });

    await orm.delete(subscriptions).where(and(eq(subscriptions.channel_id, payload.channelId), eq(subscriptions.agent_id, agent.id)));
    return reply(conn, reqId, true, { deleted: true });
  }

  /**
   * 处理 message.send 命令。
   */
  async function handleWsMessageSend(conn, agent, reqId, payload) {
    if (!payload || !payload.channelId || !payload.content) {
      return reply(conn, reqId, false, { code: 'INVALID_PAYLOAD', message: 'channelId and content are required' });
    }

    const { channelId, content, contentType, replyTo, mentionAgentIds, discussionSessionId } = payload;
    const [channel] = await orm.select({ id: channels.id, is_archived: channels.is_archived })
      .from(channels).where(eq(channels.id, channelId));

    if (!channel) return reply(conn, reqId, false, { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' });
    if (channel.is_archived) return reply(conn, reqId, false, { code: 'CHANNEL_ARCHIVED', message: 'Channel is archived, no new messages allowed' });

    const [member] = await orm.select({ agent_id: channelMembers.agent_id }).from(channelMembers)
      .where(and(eq(channelMembers.channel_id, channelId), eq(channelMembers.agent_id, agent.id)));
    if (!member) return reply(conn, reqId, false, { code: 'NOT_MEMBER', message: 'Must be a channel member to send messages' });

    if (isRateLimited(`ws:msg:${agent.id}`, 30, 60000)) {
      return reply(conn, reqId, false, { code: 'RATE_LIMITED', message: 'Message sending rate limit exceeded' });
    }

    try {
      const { message } = await messaging.createChannelMessage({
        channelId, senderId: agent.id, senderName: agent.name,
        content, contentType, replyTo, mentionAgentIds, discussionSessionId,
      });

      await broadcastChannel(channelId, {
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
   * 处理 Agent 通过 WebSocket 发送的命令。
   */
  async function handleAgentWsCommand(conn, agent, msg) {
    const { id: reqId, action, payload } = msg;

    if (!reqId || !action) {
      return reply(conn, reqId || 'unknown', false, { code: 'INVALID_FORMAT', message: 'id and action are required' });
    }

    if (isRateLimited(`ws:${agent.id}`, 60, 60000)) {
      return reply(conn, reqId, false, { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' });
    }

    switch (action) {
      case 'subscribe': return handleWsSubscribe(conn, agent, reqId, payload);
      case 'unsubscribe': return handleWsUnsubscribe(conn, agent, reqId, payload);
      case 'message.send': return handleWsMessageSend(conn, agent, reqId, payload);
      default: return reply(conn, reqId, false, { code: 'UNKNOWN_ACTION', message: `Unknown action: ${action}` });
    }
  }

  /**
   * 完成 WebSocket 握手。
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
   */
  async function handleAdminUpgrade(req, socket, url) {
    const token = url.searchParams.get('token');
    if (!token) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }

    const jwtPayload = verifyJwt(token);
    if (!jwtPayload) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }

    const [admin] = await orm.select().from(adminUsers).where(eq(adminUsers.id, jwtPayload.id));
    if (!admin) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }

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

        if (frame.opcode === 0x08) { socket.end(); return; }
        if (frame.opcode === 0x0a) { conn.alive = true; continue; }
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
   */
  async function handleUpgrade(req, socket) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname === '/ws/admin') { await handleAdminUpgrade(req, socket, url); return; }

    const apiKey = url.searchParams.get('apiKey');
    if (!apiKey) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }

    const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const [agent] = await orm.select({ id: agents.id, name: agents.name, status: agents.status })
      .from(agents).where(eq(agents.api_key_hash, apiKeyHash));

    if (!agent) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    if (agent.status === 'suspended') { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }

    const existingConnections = wsConnections.get(agent.id) || [];
    if (existingConnections.length >= 5) { socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); socket.destroy(); return; }

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

        if (frame.opcode === 0x08) { socket.end(); return; }
        if (frame.opcode === 0x0a) { conn.alive = true; continue; }
        if (frame.opcode === 0x01) {
          try {
            const msg = JSON.parse(frame.payload);
            if (msg.type === 'pong') { conn.alive = true; continue; }
            if (msg.action) {
              handleAgentWsCommand(conn, agent, msg).catch((err) => {
                console.error('WS command error:', err);
              });
            }
          } catch {}
        }
      }
    });

    socket.on('close', () => removeAgentConnection(agent.id, socket).catch(() => {}));
    socket.on('error', () => removeAgentConnection(agent.id, socket).catch(() => {}));
  }

  /**
   * 断开指定 Agent 的全部连接。
   */
  function disconnectAgent(agentId, reason) {
    const conns = wsConnections.get(agentId);
    if (!conns) return;

    conns.forEach((conn) => {
      send(conn.socket, { type: 'agent.suspended', payload: { reason }, timestamp: new Date().toISOString() });
      try { conn.socket.end(); } catch {}
    });

    wsConnections.delete(agentId);
  }

  function isAgentOnline(agentId) { return wsConnections.has(agentId); }

  function getConnectionStats() {
    let totalConnections = 0;
    let adminConnections = 0;
    for (const conns of wsConnections.values()) totalConnections += conns.length;
    for (const conns of wsAdminConnections.values()) adminConnections += conns.length;
    return { onlineAgents: wsConnections.size, totalConnections, adminConnections };
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;

    heartbeatTimer = setInterval(() => {
      const pingMsg = { type: 'ping', payload: {}, timestamp: new Date().toISOString() };

      for (const [agentId, conns] of wsConnections) {
        for (const conn of [...conns]) {
          if (!conn.alive) {
            try { conn.socket.end(); } catch {}
            removeAgentConnection(agentId, conn.socket).catch(() => {});
            continue;
          }
          conn.alive = false;
          send(conn.socket, pingMsg);
        }
      }

      for (const [adminId, conns] of wsAdminConnections) {
        for (const conn of [...conns]) {
          if (!conn.alive) {
            try { conn.socket.end(); } catch {}
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

  function stopHeartbeat() {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  return {
    handleUpgrade, broadcastChannel, broadcastAll, broadcastAdmins,
    disconnectAgent, isAgentOnline, getConnectionStats, startHeartbeat, stopHeartbeat,
  };
}
