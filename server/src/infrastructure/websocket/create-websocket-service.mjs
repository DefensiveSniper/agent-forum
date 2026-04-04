import crypto from 'crypto';
import { URL } from 'url';
import { createAgentWsCommandHandler } from './commands.mjs';
import { wsAcceptKey, wsDecode, wsEncode } from './protocol.mjs';

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
    for (const connections of wsAdminConnections.values()) {
      connections.forEach((conn) => send(conn.socket, msg));
    }
  }

  /**
   * 向所有在线 Agent 连接广播消息。
   * @param {object} msg
   */
  function broadcastAll(msg) {
    for (const connections of wsConnections.values()) {
      connections.forEach((conn) => send(conn.socket, msg));
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
      const connections = wsConnections.get(member.agent_id);
      if (connections) connections.forEach((conn) => send(conn.socket, msg));
    }

    const eventType = msg.type || '';
    const subscriptions = db.all(`SELECT agent_id, event_types FROM subscriptions WHERE channel_id = ${db.esc(channelId)}`);

    for (const subscription of subscriptions) {
      if (sentAgentIds.has(subscription.agent_id)) continue;

      const eventTypes = tryParseJson(subscription.event_types);
      if (Array.isArray(eventTypes) && !eventTypes.includes(eventType) && !eventTypes.includes('*')) continue;

      sentAgentIds.add(subscription.agent_id);
      const connections = wsConnections.get(subscription.agent_id);
      if (connections) connections.forEach((conn) => send(conn.socket, msg));
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

  const handleAgentWsCommand = createAgentWsCommandHandler({
    db,
    messaging,
    isRateLimited,
    tryParseJson,
    reply,
    broadcastChannel,
  });

  /**
   * 移除 Agent WebSocket 连接并在必要时广播离线事件。
   * @param {string} agentId
   * @param {import('net').Socket} socket
   */
  function removeAgentConnection(agentId, socket) {
    const connections = wsConnections.get(agentId);
    if (!connections) return;

    const existed = connections.some((conn) => conn.socket === socket);
    if (!existed) return;

    const filtered = connections.filter((conn) => conn.socket !== socket);
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
   * @param {string} [username]
   */
  function removeAdminConnection(adminId, socket, username) {
    const connections = wsAdminConnections.get(adminId);
    if (!connections) return;

    const existed = connections.some((conn) => conn.socket === socket);
    if (!existed) return;

    const filtered = connections.filter((conn) => conn.socket !== socket);
    if (filtered.length === 0) wsAdminConnections.delete(adminId);
    else wsAdminConnections.set(adminId, filtered);

    if (username) {
      console.log(`🔌 WS Admin: ${username} disconnected`);
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
    const connections = wsConnections.get(agentId);
    if (!connections) return;

    connections.forEach((conn) => {
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

    for (const connections of wsConnections.values()) totalConnections += connections.length;
    for (const connections of wsAdminConnections.values()) adminConnections += connections.length;

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

      for (const [agentId, connections] of wsConnections) {
        for (const conn of [...connections]) {
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

      for (const [adminId, connections] of wsAdminConnections) {
        for (const conn of [...connections]) {
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
