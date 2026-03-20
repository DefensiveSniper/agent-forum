/**
 * AgentForum 后端服务器
 * 零外部依赖实现 - 仅使用 Node.js 内置模块
 * SQLite 通过 sqlite3 CLI 访问（自动检测路径）
 */
import http from 'http';
import { URL } from 'url';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 自动检测 sqlite3 可执行文件路径
 */
function findSqlite3() {
  const candidates = [
    'sqlite3',
    '/usr/bin/sqlite3',
    '/usr/local/bin/sqlite3',
    '/snap/lxd/38472/bin/sqlite3',
    '/snap/lxd/36562/bin/sqlite3',
  ];
  for (const bin of candidates) {
    try {
      execSync(`${bin} --version`, { stdio: 'pipe', timeout: 2000 });
      return bin;
    } catch {}
  }
  console.error('ERROR: sqlite3 not found! Install sqlite3 or set SQLITE3_BIN env var.');
  process.exit(1);
}

// =====================================
// 环境变量配置
// =====================================
const config = {
  PORT: parseInt(process.env.PORT || '3000'),
  JWT_SECRET: process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
  ADMIN_INIT_USERNAME: process.env.ADMIN_INIT_USERNAME || 'admin',
  ADMIN_INIT_PASSWORD: process.env.ADMIN_INIT_PASSWORD || 'admin123',
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  DB_PATH: process.env.DB_PATH || path.join(__dirname, '../data/agent-forum.db'),
  WEB_PATH: path.join(__dirname, '../packages/web/dist'),
  SQLITE3_BIN: process.env.SQLITE3_BIN || findSqlite3(),
};

// =====================================
// 数据库层
// =====================================

/** 确保数据目录存在 */
const dataDir = path.dirname(config.DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

/** 临时 SQL 文件路径 */
const TMP_SQL = path.join(dataDir, '.tmp_query.sql');

/**
 * SQL 参数转义，防止注入攻击
 */
function esc(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 执行 SQL 语句（写操作：INSERT/UPDATE/DELETE/CREATE）
 */
function dbExec(sql) {
  fs.writeFileSync(TMP_SQL, sql, 'utf-8');
  try {
    execSync(`${config.SQLITE3_BIN} "${config.DB_PATH}" < "${TMP_SQL}"`, {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    });
  } catch (err) {
    console.error('DB Exec Error:', err.stderr || err.message);
    throw new Error('Database error');
  }
}

/**
 * 查询所有行（返回 JSON 数组）
 */
function dbAll(sql) {
  fs.writeFileSync(TMP_SQL, `.mode json\n${sql}`, 'utf-8');
  try {
    const result = execSync(`${config.SQLITE3_BIN} "${config.DB_PATH}" < "${TMP_SQL}"`, {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    });
    if (!result.trim()) return [];
    return JSON.parse(result);
  } catch (err) {
    console.error('DB Query Error:', err.stderr || err.message);
    return [];
  }
}

/**
 * 查询单行
 */
function dbGet(sql) {
  const rows = dbAll(sql);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * 初始化所有数据库表和索引
 */
function initDatabase() {
  console.log('🔄 Initializing database...');
  dbExec(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'admin', created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS invite_codes (
      id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, label TEXT, created_by TEXT,
      used_by TEXT, max_uses INT DEFAULT 1, uses_count INT DEFAULT 0,
      expires_at TEXT, revoked INT DEFAULT 0, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT,
      api_key_hash TEXT NOT NULL, invite_code_id TEXT, status TEXT DEFAULT 'active',
      metadata TEXT, created_at TEXT, last_seen_at TEXT
    );
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      type TEXT DEFAULT 'public', created_by TEXT, max_members INT DEFAULT 100,
      is_archived INT DEFAULT 0, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      content TEXT, content_type TEXT DEFAULT 'text', reply_to TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS channel_members (
      channel_id TEXT NOT NULL, agent_id TEXT NOT NULL, role TEXT DEFAULT 'member',
      joined_at TEXT, PRIMARY KEY (channel_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      event_types TEXT, created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key_hash);
    CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);
  `);
  console.log('✅ Database initialized');
}

// =====================================
// 密码哈希（使用 scrypt）
// =====================================

/**
 * 使用 scrypt 对密码进行哈希
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * 验证密码是否匹配
 */
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return derived === hash;
}

// =====================================
// JWT 实现
// =====================================

/** Base64URL 编码 */
function b64url(data) {
  return Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))
    .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Base64URL 解码 */
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return JSON.parse(Buffer.from(str, 'base64').toString('utf-8'));
}

/**
 * 签发 JWT Token
 */
function signJwt(payload, expiresInSec = 86400) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSec };
  const content = `${b64url(header)}.${b64url(body)}`;
  const sig = crypto.createHmac('sha256', config.JWT_SECRET).update(content).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${content}.${sig}`;
}

/**
 * 验证并解析 JWT Token
 */
function verifyJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const content = `${parts[0]}.${parts[1]}`;
    const sig = crypto.createHmac('sha256', config.JWT_SECRET).update(content).digest('base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    if (sig !== parts[2]) return null;
    const payload = b64urlDecode(parts[1]);
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// =====================================
// 种子管理员账户
// =====================================

/**
 * 首次启动时创建初始管理员
 */
function seedAdmin() {
  const existing = dbGet(`SELECT id FROM admin_users WHERE username = ${esc(config.ADMIN_INIT_USERNAME)}`);
  if (!existing) {
    const id = crypto.randomUUID();
    const pw = hashPassword(config.ADMIN_INIT_PASSWORD);
    dbExec(`INSERT INTO admin_users (id, username, password_hash, role, created_at) VALUES (${esc(id)}, ${esc(config.ADMIN_INIT_USERNAME)}, ${esc(pw)}, 'super_admin', ${esc(new Date().toISOString())})`);
    console.log(`✅ Admin account created: ${config.ADMIN_INIT_USERNAME}`);
  }
}

// =====================================
// HTTP 路由器
// =====================================

const routes = [];

/**
 * 注册路由
 */
function addRoute(method, pattern, ...handlers) {
  const paramNames = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, name) => { paramNames.push(name); return '([^/]+)'; }) + '$');
  routes.push({ method: method.toUpperCase(), re, paramNames, handlers });
}

/**
 * 解析请求体 JSON
 */
function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// =====================================
// 限流器（内存实现）
// =====================================

const rateLimits = new Map();

/**
 * 通用限流检查
 * @param {string} key - 限流键（通常是 IP 或 IP+路径组合）
 * @param {number} maxReqs - 窗口内最大请求数
 * @param {number} windowMs - 时间窗口（毫秒）
 */
function isRateLimited(key, maxReqs = 60, windowMs = 60000) {
  const now = Date.now();
  if (!rateLimits.has(key)) rateLimits.set(key, []);
  const hits = rateLimits.get(key).filter(t => t > now - windowMs);
  hits.push(now);
  rateLimits.set(key, hits);
  return hits.length > maxReqs;
}

/**
 * 针对注册接口的严格限流：每 IP 每小时最多 5 次
 */
function isRegisterRateLimited(ip) {
  return isRateLimited(`register:${ip}`, 5, 3600000);
}

// =====================================
// WebSocket 实现 (RFC 6455)
// =====================================

/** 活跃 WebSocket 连接: agentId -> [{ws, agentId, agentName, alive}] */
const wsConnections = new Map();

/** 管理员 WebSocket 连接: adminId -> [{socket, adminId, alive}] */
const wsAdminConnections = new Map();

/**
 * 生成 WebSocket 握手接受密钥
 */
function wsAcceptKey(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

/**
 * 编码 WebSocket 帧
 */
function wsEncode(data) {
  const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text
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
 * 解码 WebSocket 帧
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
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskKey[i % 4];
    }
  }

  return { opcode, payload: payload.toString('utf-8'), totalLen: offset + payloadLen };
}

/**
 * 处理 WebSocket 升级请求（支持 Agent apiKey 和 Admin token 两种认证）
 * Agent 路径: /ws?apiKey=xxx
 * Admin 路径: /ws/admin?token=xxx
 */
function handleUpgrade(req, socket) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // ---- Admin WebSocket (/ws/admin?token=xxx) ----
  if (pathname === '/ws/admin') {
    return handleAdminUpgrade(req, socket, url);
  }

  // ---- Agent WebSocket (/ws?apiKey=xxx) ----
  const apiKey = url.searchParams.get('apiKey');

  if (!apiKey) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // 验证 API Key
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const agent = dbGet(`SELECT id, name, status FROM agents WHERE api_key_hash = ${esc(apiKeyHash)}`);

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

  // 检查连接数限制
  const existing = wsConnections.get(agent.id) || [];
  if (existing.length >= 5) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }

  // 完成 WebSocket 握手
  const key = req.headers['sec-websocket-key'];
  const accept = wsAcceptKey(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const conn = { socket, agentId: agent.id, agentName: agent.name, alive: true };

  if (!wsConnections.has(agent.id)) wsConnections.set(agent.id, []);
  wsConnections.get(agent.id).push(conn);

  // 广播上线事件
  wsBroadcastAll({ type: 'agent.online', payload: { agentId: agent.id, agentName: agent.name }, timestamp: new Date().toISOString() });

  console.log(`🔌 WS: ${agent.name} connected (${(wsConnections.get(agent.id) || []).length} connections)`);

  // 处理数据
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const frame = wsDecode(buffer);
      if (!frame) break;
      buffer = buffer.slice(frame.totalLen);
      if (frame.opcode === 0x08) { // Close
        socket.end();
        return;
      }
      if (frame.opcode === 0x0a) { // Pong
        conn.alive = true;
        continue;
      }
      if (frame.opcode === 0x01) { // Text
        try {
          const msg = JSON.parse(frame.payload);
          if (msg.type === 'pong') conn.alive = true;
        } catch {}
      }
    }
  });

  socket.on('close', () => wsRemoveConn(agent.id, socket));
  socket.on('error', () => wsRemoveConn(agent.id, socket));
}

/**
 * 处理管理员 WebSocket 升级（JWT 认证）
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

  const admin = dbGet(`SELECT * FROM admin_users WHERE id = ${esc(payload.id)}`);
  if (!admin) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // 完成 WebSocket 握手
  const key = req.headers['sec-websocket-key'];
  const accept = wsAcceptKey(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

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
        try { const msg = JSON.parse(frame.payload); if (msg.type === 'pong') conn.alive = true; } catch {}
      }
    }
  });

  const cleanup = () => {
    const conns = wsAdminConnections.get(admin.id);
    if (conns) {
      const filtered = conns.filter(c => c.socket !== socket);
      if (filtered.length === 0) wsAdminConnections.delete(admin.id);
      else wsAdminConnections.set(admin.id, filtered);
    }
    console.log(`🔌 WS Admin: ${admin.username} disconnected`);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

/**
 * 移除 WebSocket 连接并在必要时广播离线事件
 */
function wsRemoveConn(agentId, socket) {
  const conns = wsConnections.get(agentId);
  if (!conns) return;
  const filtered = conns.filter(c => c.socket !== socket);
  if (filtered.length === 0) {
    wsConnections.delete(agentId);
    const agent = dbGet(`SELECT name FROM agents WHERE id = ${esc(agentId)}`);
    wsBroadcastAll({ type: 'agent.offline', payload: { agentId, agentName: agent?.name || '' }, timestamp: new Date().toISOString() });
    console.log(`🔌 WS: ${agent?.name || agentId} disconnected`);
  } else {
    wsConnections.set(agentId, filtered);
  }
}

/**
 * 向指定 socket 发送消息
 */
function wsSend(socket, msg) {
  try { if (!socket.destroyed) socket.write(wsEncode(JSON.stringify(msg))); } catch {}
}

/**
 * 向频道所有成员广播消息（含频道成员 + 订阅者 + 管理员）
 */
function wsBroadcastChannel(channelId, msg) {
  const sentAgentIds = new Set();

  // 1. 频道成员
  const members = dbAll(`SELECT agent_id FROM channel_members WHERE channel_id = ${esc(channelId)}`);
  for (const m of members) {
    sentAgentIds.add(m.agent_id);
    const conns = wsConnections.get(m.agent_id);
    if (conns) conns.forEach(c => wsSend(c.socket, msg));
  }

  // 2. 订阅者（按事件类型过滤，避免重复发送给已经是成员的 agent）
  const eventType = msg.type || '';
  const subs = dbAll(`SELECT agent_id, event_types FROM subscriptions WHERE channel_id = ${esc(channelId)}`);
  for (const sub of subs) {
    if (sentAgentIds.has(sub.agent_id)) continue;
    const types = tryParseJson(sub.event_types);
    if (Array.isArray(types) && !types.includes(eventType) && !types.includes('*')) continue;
    sentAgentIds.add(sub.agent_id);
    const conns = wsConnections.get(sub.agent_id);
    if (conns) conns.forEach(c => wsSend(c.socket, msg));
  }

  // 3. 所有管理员连接也收到频道事件
  wsBroadcastAdmins(msg);
}

/**
 * 向所有在线 Agent 连接广播消息（同时也发给管理员）
 */
function wsBroadcastAll(msg) {
  for (const conns of wsConnections.values()) {
    conns.forEach(c => wsSend(c.socket, msg));
  }
  wsBroadcastAdmins(msg);
}

/**
 * 向所有管理员 WebSocket 连接广播消息
 */
function wsBroadcastAdmins(msg) {
  for (const conns of wsAdminConnections.values()) {
    conns.forEach(c => wsSend(c.socket, msg));
  }
}

/**
 * 断开指定 Agent 的所有连接
 */
function wsDisconnectAgent(agentId, reason) {
  const conns = wsConnections.get(agentId);
  if (conns) {
    conns.forEach(c => {
      wsSend(c.socket, { type: 'agent.suspended', payload: { reason }, timestamp: new Date().toISOString() });
      try { c.socket.end(); } catch {}
    });
    wsConnections.delete(agentId);
  }
}

/** 心跳定时器：每30秒发 ping（Agent + Admin 连接） */
setInterval(() => {
  const pingMsg = { type: 'ping', payload: {}, timestamp: new Date().toISOString() };
  for (const [agentId, conns] of wsConnections) {
    for (const conn of conns) {
      if (!conn.alive) {
        try { conn.socket.end(); } catch {}
        wsRemoveConn(agentId, conn.socket);
        continue;
      }
      conn.alive = false;
      wsSend(conn.socket, pingMsg);
    }
  }
  for (const [adminId, conns] of wsAdminConnections) {
    for (const conn of conns) {
      if (!conn.alive) {
        try { conn.socket.end(); } catch {}
        const filtered = conns.filter(c => c.socket !== conn.socket);
        if (filtered.length === 0) wsAdminConnections.delete(adminId);
        else wsAdminConnections.set(adminId, filtered);
        continue;
      }
      conn.alive = false;
      wsSend(conn.socket, pingMsg);
    }
  }
}, 30000);

// =====================================
// API 路由定义
// =====================================

// --- Agent 管理 ---

/** POST /api/v1/agents/register - 注册 Agent（需邀请码，每 IP 每小时限 5 次） */
addRoute('POST', '/api/v1/agents/register', async (req, res) => {
  const ip = req.socket?.remoteAddress || 'unknown';
  if (isRegisterRateLimited(ip)) return sendJson(res, 429, { error: 'Too many registration attempts. Try again later.' });

  const { name, description, inviteCode, metadata } = req.body;
  if (!name || !inviteCode) return sendJson(res, 400, { error: 'name and inviteCode required' });

  // 验证邀请码
  const invite = dbGet(`SELECT * FROM invite_codes WHERE code = ${esc(inviteCode)}`);
  if (!invite) return sendJson(res, 403, { error: 'Invalid invite code' });
  if (invite.revoked) return sendJson(res, 403, { error: 'Invite code has been revoked' });
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) return sendJson(res, 403, { error: 'Invite code has expired' });
  // max_uses = 0 表示无限次；否则检查是否已用完
  if (invite.max_uses > 0 && invite.uses_count >= invite.max_uses) return sendJson(res, 403, { error: 'Invite code has been fully used' });

  // 检查名称唯一性
  if (dbGet(`SELECT id FROM agents WHERE name = ${esc(name)}`)) return sendJson(res, 409, { error: 'Agent name already taken' });

  const id = crypto.randomUUID();
  const apiKey = `af_${crypto.randomBytes(32).toString('hex')}`;
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const now = new Date().toISOString();

  dbExec(`INSERT INTO agents (id, name, description, api_key_hash, invite_code_id, status, metadata, created_at, last_seen_at)
    VALUES (${esc(id)}, ${esc(name)}, ${esc(description || null)}, ${esc(apiKeyHash)}, ${esc(invite.id)}, 'active', ${esc(metadata ? JSON.stringify(metadata) : null)}, ${esc(now)}, ${esc(now)})`);

  // 消耗邀请码
  dbExec(`UPDATE invite_codes SET uses_count = uses_count + 1, used_by = ${esc(id)} WHERE id = ${esc(invite.id)}`);

  const agent = dbGet(`SELECT * FROM agents WHERE id = ${esc(id)}`);
  console.log(`✅ Agent registered: ${name}`);
  sendJson(res, 201, { agent: formatAgent(agent), apiKey });
});

/** GET /api/v1/agents/me - 获取当前 Agent 信息 */
addRoute('GET', '/api/v1/agents/me', authAgent, (req, res) => {
  sendJson(res, 200, formatAgent(req.agent));
});

/** PATCH /api/v1/agents/me - 更新当前 Agent */
addRoute('PATCH', '/api/v1/agents/me', authAgent, (req, res) => {
  const { name, description, metadata } = req.body;
  const sets = [];
  if (name !== undefined) sets.push(`name = ${esc(name)}`);
  if (description !== undefined) sets.push(`description = ${esc(description)}`);
  if (metadata !== undefined) sets.push(`metadata = ${esc(JSON.stringify(metadata))}`);
  if (sets.length > 0) dbExec(`UPDATE agents SET ${sets.join(', ')} WHERE id = ${esc(req.agent.id)}`);
  const updated = dbGet(`SELECT * FROM agents WHERE id = ${esc(req.agent.id)}`);
  sendJson(res, 200, formatAgent(updated));
});

/** GET /api/v1/agents - 列出所有 Agent */
addRoute('GET', '/api/v1/agents', authAgent, (req, res) => {
  sendJson(res, 200, dbAll('SELECT * FROM agents').map(formatAgent));
});

/** GET /api/v1/agents/:id - 获取指定 Agent */
addRoute('GET', '/api/v1/agents/:id', authAgent, (req, res) => {
  const agent = dbGet(`SELECT * FROM agents WHERE id = ${esc(req.params.id)}`);
  if (!agent) return sendJson(res, 404, { error: 'Agent not found' });
  sendJson(res, 200, formatAgent(agent));
});

// --- 频道管理 ---

/** POST /api/v1/channels - 创建频道 */
addRoute('POST', '/api/v1/channels', authAgent, (req, res) => {
  const { name, description, type, maxMembers } = req.body;
  if (!name) return sendJson(res, 400, { error: 'name is required' });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  dbExec(`INSERT INTO channels (id, name, description, type, created_by, max_members, created_at, updated_at)
    VALUES (${esc(id)}, ${esc(name)}, ${esc(description || null)}, ${esc(type || 'public')}, ${esc(req.agent.id)}, ${esc(maxMembers || 100)}, ${esc(now)}, ${esc(now)})`);
  dbExec(`INSERT INTO channel_members (channel_id, agent_id, role, joined_at) VALUES (${esc(id)}, ${esc(req.agent.id)}, 'owner', ${esc(now)})`);
  const channel = dbGet(`SELECT * FROM channels WHERE id = ${esc(id)}`);
  wsBroadcastAll({ type: 'channel.created', payload: { channel, creator: { id: req.agent.id, name: req.agent.name } }, timestamp: now });
  sendJson(res, 201, channel);
});

/** GET /api/v1/channels - 列出频道（公开频道 + 自己已加入的私有频道） */
addRoute('GET', '/api/v1/channels', authAgent, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;
  const agentId = req.agent.id;
  // 返回：所有未归档公开/广播频道 + 当前 Agent 已加入的私有频道
  sendJson(res, 200, dbAll(`SELECT DISTINCT c.* FROM channels c
    LEFT JOIN channel_members cm ON c.id = cm.channel_id AND cm.agent_id = ${esc(agentId)}
    WHERE c.is_archived = 0
      AND (c.type != 'private' OR cm.agent_id IS NOT NULL)
    ORDER BY c.created_at DESC
    LIMIT ${limit} OFFSET ${offset}`));
});

/** GET /api/v1/channels/:id - 获取频道详情（私有频道仅成员可见） */
addRoute('GET', '/api/v1/channels/:id', authAgent, (req, res) => {
  const ch = dbGet(`SELECT * FROM channels WHERE id = ${esc(req.params.id)}`);
  if (!ch) return sendJson(res, 404, { error: 'Channel not found' });
  // 私有频道仅成员可查看详情
  if (ch.type === 'private') {
    const isMember = dbGet(`SELECT agent_id FROM channel_members WHERE channel_id = ${esc(req.params.id)} AND agent_id = ${esc(req.agent.id)}`);
    if (!isMember) return sendJson(res, 403, { error: 'Private channel: members only' });
  }
  sendJson(res, 200, ch);
});

/** PATCH /api/v1/channels/:id - 更新频道 */
addRoute('PATCH', '/api/v1/channels/:id', authAgent, (req, res) => {
  const role = dbGet(`SELECT role FROM channel_members WHERE channel_id = ${esc(req.params.id)} AND agent_id = ${esc(req.agent.id)}`);
  if (!role || (role.role !== 'owner' && role.role !== 'admin')) return sendJson(res, 403, { error: 'Only owner/admin can update' });
  const { name, description, maxMembers } = req.body;
  const sets = [`updated_at = ${esc(new Date().toISOString())}`];
  if (name !== undefined) sets.push(`name = ${esc(name)}`);
  if (description !== undefined) sets.push(`description = ${esc(description)}`);
  if (maxMembers !== undefined) sets.push(`max_members = ${esc(maxMembers)}`);
  dbExec(`UPDATE channels SET ${sets.join(', ')} WHERE id = ${esc(req.params.id)}`);
  const updated = dbGet(`SELECT * FROM channels WHERE id = ${esc(req.params.id)}`);
  // 广播 channel.updated 事件
  wsBroadcastChannel(req.params.id, { type: 'channel.updated', payload: { channel: updated }, timestamp: new Date().toISOString() });
  sendJson(res, 200, updated);
});

/** DELETE /api/v1/channels/:id - 归档频道 */
addRoute('DELETE', '/api/v1/channels/:id', authAgent, (req, res) => {
  const role = dbGet(`SELECT role FROM channel_members WHERE channel_id = ${esc(req.params.id)} AND agent_id = ${esc(req.agent.id)}`);
  if (!role || role.role !== 'owner') return sendJson(res, 403, { error: 'Only owner can archive' });
  dbExec(`UPDATE channels SET is_archived = 1, updated_at = ${esc(new Date().toISOString())} WHERE id = ${esc(req.params.id)}`);
  res.writeHead(204).end();
});

/** POST /api/v1/channels/:id/join - 加入频道（私有频道需要被邀请/Owner添加） */
addRoute('POST', '/api/v1/channels/:id/join', authAgent, (req, res) => {
  const ch = dbGet(`SELECT * FROM channels WHERE id = ${esc(req.params.id)}`);
  if (!ch) return sendJson(res, 404, { error: 'Channel not found' });
  if (ch.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });
  if (ch.type === 'private') return sendJson(res, 403, { error: 'Private channel: must be invited by owner/admin' });
  const exists = dbGet(`SELECT agent_id FROM channel_members WHERE channel_id = ${esc(req.params.id)} AND agent_id = ${esc(req.agent.id)}`);
  if (exists) return sendJson(res, 409, { error: 'Already a member' });
  const count = dbGet(`SELECT COUNT(*) as cnt FROM channel_members WHERE channel_id = ${esc(req.params.id)}`);
  if (count && count.cnt >= ch.max_members) return sendJson(res, 409, { error: 'Channel is full' });
  const now = new Date().toISOString();
  dbExec(`INSERT INTO channel_members (channel_id, agent_id, role, joined_at) VALUES (${esc(req.params.id)}, ${esc(req.agent.id)}, 'member', ${esc(now)})`);
  wsBroadcastChannel(req.params.id, { type: 'member.joined', payload: { channelId: req.params.id, agentId: req.agent.id, agentName: req.agent.name }, timestamp: now });
  sendJson(res, 200, { message: 'Joined channel' });
});

/** POST /api/v1/channels/:id/invite - 频道 Owner/Admin 邀请 Agent 加入私有频道 */
addRoute('POST', '/api/v1/channels/:id/invite', authAgent, (req, res) => {
  const ch = dbGet(`SELECT * FROM channels WHERE id = ${esc(req.params.id)}`);
  if (!ch) return sendJson(res, 404, { error: 'Channel not found' });
  if (ch.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });
  // 只有 owner/admin 可以邀请
  const role = dbGet(`SELECT role FROM channel_members WHERE channel_id = ${esc(req.params.id)} AND agent_id = ${esc(req.agent.id)}`);
  if (!role || (role.role !== 'owner' && role.role !== 'admin')) return sendJson(res, 403, { error: 'Only owner/admin can invite' });
  const { agentId } = req.body;
  if (!agentId) return sendJson(res, 400, { error: 'agentId is required' });
  const target = dbGet(`SELECT id, name FROM agents WHERE id = ${esc(agentId)}`);
  if (!target) return sendJson(res, 404, { error: 'Target agent not found' });
  const exists = dbGet(`SELECT agent_id FROM channel_members WHERE channel_id = ${esc(req.params.id)} AND agent_id = ${esc(agentId)}`);
  if (exists) return sendJson(res, 409, { error: 'Agent is already a member' });
  const count = dbGet(`SELECT COUNT(*) as cnt FROM channel_members WHERE channel_id = ${esc(req.params.id)}`);
  if (count && count.cnt >= ch.max_members) return sendJson(res, 409, { error: 'Channel is full' });
  const now = new Date().toISOString();
  dbExec(`INSERT INTO channel_members (channel_id, agent_id, role, joined_at) VALUES (${esc(req.params.id)}, ${esc(agentId)}, 'member', ${esc(now)})`);
  wsBroadcastChannel(req.params.id, { type: 'member.joined', payload: { channelId: req.params.id, agentId, agentName: target.name, invitedBy: req.agent.id }, timestamp: now });
  sendJson(res, 200, { message: `Agent ${target.name} invited to channel` });
});

/** POST /api/v1/channels/:id/leave - 离开频道 */
addRoute('POST', '/api/v1/channels/:id/leave', authAgent, (req, res) => {
  dbExec(`DELETE FROM channel_members WHERE channel_id = ${esc(req.params.id)} AND agent_id = ${esc(req.agent.id)}`);
  wsBroadcastChannel(req.params.id, { type: 'member.left', payload: { channelId: req.params.id, agentId: req.agent.id, agentName: req.agent.name }, timestamp: new Date().toISOString() });
  sendJson(res, 200, { message: 'Left channel' });
});

/** GET /api/v1/channels/:id/members - 获取频道成员 */
addRoute('GET', '/api/v1/channels/:id/members', authAgent, (req, res) => {
  sendJson(res, 200, dbAll(`SELECT cm.*, a.name as agent_name FROM channel_members cm LEFT JOIN agents a ON cm.agent_id = a.id WHERE cm.channel_id = ${esc(req.params.id)}`));
});

// --- 消息管理 ---

/** POST /api/v1/channels/:id/messages - 发送消息（归档频道禁止写入） */
addRoute('POST', '/api/v1/channels/:id/messages', authAgent, (req, res) => {
  const ch = dbGet(`SELECT is_archived FROM channels WHERE id = ${esc(req.params.id)}`);
  if (!ch) return sendJson(res, 404, { error: 'Channel not found' });
  if (ch.is_archived) return sendJson(res, 403, { error: 'Channel is archived, no new messages allowed' });
  const member = dbGet(`SELECT agent_id FROM channel_members WHERE channel_id = ${esc(req.params.id)} AND agent_id = ${esc(req.agent.id)}`);
  if (!member) return sendJson(res, 403, { error: 'Must be a channel member' });
  const { content, contentType, replyTo } = req.body;
  if (!content) return sendJson(res, 400, { error: 'content is required' });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  dbExec(`INSERT INTO messages (id, channel_id, sender_id, content, content_type, reply_to, created_at)
    VALUES (${esc(id)}, ${esc(req.params.id)}, ${esc(req.agent.id)}, ${esc(content)}, ${esc(contentType || 'text')}, ${esc(replyTo || null)}, ${esc(now)})`);
  const msg = dbGet(`SELECT * FROM messages WHERE id = ${esc(id)}`);
  wsBroadcastChannel(req.params.id, { type: 'message.new', payload: { message: msg, sender: { id: req.agent.id, name: req.agent.name } }, timestamp: now, channelId: req.params.id });
  sendJson(res, 201, msg);
});

/** GET /api/v1/channels/:id/messages - 获取消息历史（游标分页） */
addRoute('GET', '/api/v1/channels/:id/messages', authAgent, (req, res) => {
  const member = dbGet(`SELECT agent_id FROM channel_members WHERE channel_id = ${esc(req.params.id)} AND agent_id = ${esc(req.agent.id)}`);
  if (!member) return sendJson(res, 403, { error: 'Must be a channel member' });
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const cursor = req.query.cursor;
  let sql = `SELECT * FROM messages WHERE channel_id = ${esc(req.params.id)}`;
  if (cursor) sql += ` AND created_at < ${esc(cursor)}`;
  sql += ` ORDER BY created_at DESC LIMIT ${limit + 1}`;
  const rows = dbAll(sql);
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  sendJson(res, 200, { data, hasMore, cursor: data.length > 0 ? data[data.length - 1].created_at : undefined });
});

/** GET /api/v1/channels/:id/messages/:msgId - 获取单条消息 */
addRoute('GET', '/api/v1/channels/:id/messages/:msgId', authAgent, (req, res) => {
  const msg = dbGet(`SELECT * FROM messages WHERE id = ${esc(req.params.msgId)} AND channel_id = ${esc(req.params.id)}`);
  if (!msg) return sendJson(res, 404, { error: 'Message not found' });
  sendJson(res, 200, msg);
});

// --- 订阅管理 ---

/** POST /api/v1/subscriptions - 创建订阅 */
addRoute('POST', '/api/v1/subscriptions', authAgent, (req, res) => {
  const { channelId, eventTypes } = req.body;
  if (!channelId || !eventTypes) return sendJson(res, 400, { error: 'channelId and eventTypes required' });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  dbExec(`INSERT INTO subscriptions (id, agent_id, channel_id, event_types, created_at)
    VALUES (${esc(id)}, ${esc(req.agent.id)}, ${esc(channelId)}, ${esc(JSON.stringify(eventTypes))}, ${esc(now)})`);
  sendJson(res, 201, { id, agentId: req.agent.id, channelId, eventTypes, createdAt: now });
});

/** GET /api/v1/subscriptions - 获取当前 Agent 的订阅 */
addRoute('GET', '/api/v1/subscriptions', authAgent, (req, res) => {
  const subs = dbAll(`SELECT * FROM subscriptions WHERE agent_id = ${esc(req.agent.id)}`);
  sendJson(res, 200, subs.map(s => ({ ...s, event_types: tryParseJson(s.event_types) })));
});

/** DELETE /api/v1/subscriptions/:id - 取消订阅 */
addRoute('DELETE', '/api/v1/subscriptions/:id', authAgent, (req, res) => {
  dbExec(`DELETE FROM subscriptions WHERE id = ${esc(req.params.id)} AND agent_id = ${esc(req.agent.id)}`);
  res.writeHead(204).end();
});

// --- 管理员 API ---

/** POST /api/v1/admin/login - 管理员登录 */
addRoute('POST', '/api/v1/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return sendJson(res, 400, { error: 'username and password required' });
  const admin = dbGet(`SELECT * FROM admin_users WHERE username = ${esc(username)}`);
  if (!admin || !verifyPassword(password, admin.password_hash))
    return sendJson(res, 401, { error: 'Invalid credentials' });
  const token = signJwt({ id: admin.id, username: admin.username, role: admin.role });
  console.log(`🔑 Admin login: ${username}`);
  sendJson(res, 200, { token, admin: { id: admin.id, username: admin.username, role: admin.role, createdAt: admin.created_at } });
});

/** POST /api/v1/admin/invites - 生成邀请码 */
addRoute('POST', '/api/v1/admin/invites', authAdmin, (req, res) => {
  const { label, maxUses, expiresAt } = req.body;
  const id = crypto.randomUUID();
  const code = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  // maxUses: 0 = 无限次，undefined/null 默认为 1
  const resolvedMaxUses = (maxUses !== undefined && maxUses !== null) ? parseInt(maxUses) : 1;
  dbExec(`INSERT INTO invite_codes (id, code, label, created_by, max_uses, expires_at, created_at)
    VALUES (${esc(id)}, ${esc(code)}, ${esc(label || null)}, ${esc(req.admin.id)}, ${esc(resolvedMaxUses)}, ${esc(expiresAt || null)}, ${esc(now)})`);
  console.log(`🎟️  Invite code created: ${label || 'no label'} (maxUses: ${resolvedMaxUses === 0 ? 'unlimited' : resolvedMaxUses})`);
  sendJson(res, 201, { id, code, label: label || null, maxUses: resolvedMaxUses, expiresAt: expiresAt || null, createdAt: now });
});

/** GET /api/v1/admin/invites - 列出所有邀请码 */
addRoute('GET', '/api/v1/admin/invites', authAdmin, (req, res) => {
  sendJson(res, 200, dbAll('SELECT * FROM invite_codes ORDER BY created_at DESC'));
});

/** DELETE /api/v1/admin/invites/:id - 作废邀请码 */
addRoute('DELETE', '/api/v1/admin/invites/:id', authAdmin, (req, res) => {
  dbExec(`UPDATE invite_codes SET revoked = 1 WHERE id = ${esc(req.params.id)}`);
  res.writeHead(204).end();
});

/** GET /api/v1/admin/agents - 查看所有 Agent（含邀请码详情） */
addRoute('GET', '/api/v1/admin/agents', authAdmin, (req, res) => {
  const agents = dbAll(`SELECT a.*, ic.code AS invite_code, ic.label AS invite_label
    FROM agents a LEFT JOIN invite_codes ic ON a.invite_code_id = ic.id
    ORDER BY a.created_at DESC`);
  sendJson(res, 200, agents.map(formatAgent));
});

/** PATCH /api/v1/admin/agents/:id - 修改 Agent 状态 */
addRoute('PATCH', '/api/v1/admin/agents/:id', authAdmin, (req, res) => {
  const { status } = req.body;
  if (!['active', 'suspended'].includes(status)) return sendJson(res, 400, { error: 'Invalid status' });
  dbExec(`UPDATE agents SET status = ${esc(status)} WHERE id = ${esc(req.params.id)}`);
  if (status === 'suspended') wsDisconnectAgent(req.params.id, 'Suspended by admin');
  const agent = dbGet(`SELECT * FROM agents WHERE id = ${esc(req.params.id)}`);
  if (!agent) return sendJson(res, 404, { error: 'Agent not found' });
  sendJson(res, 200, formatAgent(agent));
});

/** DELETE /api/v1/admin/agents/:id - 注销 Agent（级联删除关联数据） */
addRoute('DELETE', '/api/v1/admin/agents/:id', authAdmin, (req, res) => {
  const agent = dbGet(`SELECT * FROM agents WHERE id = ${esc(req.params.id)}`);
  if (!agent) return sendJson(res, 404, { error: 'Agent not found' });
  wsDisconnectAgent(req.params.id, 'Deleted by admin');
  // 级联删除：消息、频道成员、订阅
  dbExec(`DELETE FROM messages WHERE sender_id = ${esc(req.params.id)}`);
  dbExec(`DELETE FROM channel_members WHERE agent_id = ${esc(req.params.id)}`);
  dbExec(`DELETE FROM subscriptions WHERE agent_id = ${esc(req.params.id)}`);
  // 将该 Agent 创建的频道 created_by 置为 NULL（而非删除频道）
  dbExec(`UPDATE channels SET created_by = NULL WHERE created_by = ${esc(req.params.id)}`);
  dbExec(`DELETE FROM agents WHERE id = ${esc(req.params.id)}`);
  res.writeHead(204).end();
});

// --- 管理员频道/消息查看 ---

/** GET /api/v1/admin/channels - 管理员查看所有频道（含归档） */
addRoute('GET', '/api/v1/admin/channels', authAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;
  const includeArchived = req.query.includeArchived === 'true';
  let sql = 'SELECT c.*, (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) AS member_count FROM channels c';
  if (!includeArchived) sql += ' WHERE c.is_archived = 0';
  sql += ` ORDER BY c.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  sendJson(res, 200, dbAll(sql));
});

/** GET /api/v1/admin/channels/:id - 管理员查看频道详情 */
addRoute('GET', '/api/v1/admin/channels/:id', authAdmin, (req, res) => {
  const ch = dbGet(`SELECT c.*, (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) AS member_count FROM channels c WHERE c.id = ${esc(req.params.id)}`);
  if (!ch) return sendJson(res, 404, { error: 'Channel not found' });
  const members = dbAll(`SELECT cm.*, a.name AS agent_name, a.status AS agent_status FROM channel_members cm LEFT JOIN agents a ON cm.agent_id = a.id WHERE cm.channel_id = ${esc(req.params.id)}`);
  sendJson(res, 200, { ...ch, members });
});

/** GET /api/v1/admin/channels/:id/messages - 管理员查看频道消息（无需是成员） */
addRoute('GET', '/api/v1/admin/channels/:id/messages', authAdmin, (req, res) => {
  const ch = dbGet(`SELECT id FROM channels WHERE id = ${esc(req.params.id)}`);
  if (!ch) return sendJson(res, 404, { error: 'Channel not found' });
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const cursor = req.query.cursor;
  let sql = `SELECT m.*, a.name AS sender_name FROM messages m LEFT JOIN agents a ON m.sender_id = a.id WHERE m.channel_id = ${esc(req.params.id)}`;
  if (cursor) sql += ` AND m.created_at < ${esc(cursor)}`;
  sql += ` ORDER BY m.created_at DESC LIMIT ${limit + 1}`;
  const rows = dbAll(sql);
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  sendJson(res, 200, { data, hasMore, cursor: data.length > 0 ? data[data.length - 1].created_at : undefined });
});

/** POST /api/v1/admin/channels/:id/messages - 管理员发送评论到频道 */
addRoute('POST', '/api/v1/admin/channels/:id/messages', authAdmin, (req, res) => {
  const ch = dbGet(`SELECT id, is_archived FROM channels WHERE id = ${esc(req.params.id)}`);
  if (!ch) return sendJson(res, 404, { error: 'Channel not found' });
  if (ch.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });
  const { content, contentType } = req.body;
  if (!content) return sendJson(res, 400, { error: 'content is required' });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const senderId = `admin:${req.admin.username}`;
  const senderName = `[Admin] ${req.admin.username}`;
  dbExec(`INSERT INTO messages (id, channel_id, sender_id, content, content_type, reply_to, created_at)
    VALUES (${esc(id)}, ${esc(req.params.id)}, ${esc(senderId)}, ${esc(content)}, ${esc(contentType || 'text')}, ${esc(null)}, ${esc(now)})`);
  const msg = dbGet(`SELECT * FROM messages WHERE id = ${esc(id)}`);
  wsBroadcastChannel(req.params.id, { type: 'message.new', payload: { message: msg, sender: { id: senderId, name: senderName } }, timestamp: now, channelId: req.params.id });
  sendJson(res, 201, { ...msg, sender_name: senderName });
});

/** DELETE /api/v1/admin/channels/:id - 管理员归档/删除频道 */
addRoute('DELETE', '/api/v1/admin/channels/:id', authAdmin, (req, res) => {
  const ch = dbGet(`SELECT id FROM channels WHERE id = ${esc(req.params.id)}`);
  if (!ch) return sendJson(res, 404, { error: 'Channel not found' });
  dbExec(`UPDATE channels SET is_archived = 1, updated_at = ${esc(new Date().toISOString())} WHERE id = ${esc(req.params.id)}`);
  res.writeHead(204).end();
});

/** POST /api/v1/admin/agents/:id/rotate-key - 强制轮换 API Key */
addRoute('POST', '/api/v1/admin/agents/:id/rotate-key', authAdmin, (req, res) => {
  const agent = dbGet(`SELECT * FROM agents WHERE id = ${esc(req.params.id)}`);
  if (!agent) return sendJson(res, 404, { error: 'Agent not found' });
  const newKey = `af_${crypto.randomBytes(32).toString('hex')}`;
  const newHash = crypto.createHash('sha256').update(newKey).digest('hex');
  dbExec(`UPDATE agents SET api_key_hash = ${esc(newHash)} WHERE id = ${esc(req.params.id)}`);
  wsDisconnectAgent(req.params.id, 'API Key rotated');
  sendJson(res, 200, { apiKey: newKey });
});

/** GET /api/health - 健康检查 */
addRoute('GET', '/api/health', (req, res) => {
  let totalConns = 0;
  for (const conns of wsConnections.values()) totalConns += conns.length;
  let adminConns = 0;
  for (const conns of wsAdminConnections.values()) adminConns += conns.length;
  const channelCount = dbGet('SELECT COUNT(*) AS cnt FROM channels WHERE is_archived = 0');
  const agentCount = dbGet('SELECT COUNT(*) AS cnt FROM agents');
  sendJson(res, 200, {
    status: 'ok',
    timestamp: new Date().toISOString(),
    onlineAgents: wsConnections.size,
    totalAgents: agentCount?.cnt || 0,
    activeChannels: channelCount?.cnt || 0,
    totalConnections: totalConns,
    adminConnections: adminConns,
  });
});

// =====================================
// 认证中间件
// =====================================

/**
 * Agent API Key 认证
 */
function authAgent(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return sendJson(res, 401, { error: 'Missing Authorization header' });
  const apiKey = auth.substring(7);
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const agent = dbGet(`SELECT * FROM agents WHERE api_key_hash = ${esc(hash)}`);
  if (!agent) return sendJson(res, 401, { error: 'Invalid API Key' });
  if (agent.status === 'suspended') return sendJson(res, 403, { error: 'Agent is suspended' });
  dbExec(`UPDATE agents SET last_seen_at = ${esc(new Date().toISOString())} WHERE id = ${esc(agent.id)}`);
  req.agent = agent;
  next();
}

/**
 * 管理员 JWT 认证
 */
function authAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return sendJson(res, 401, { error: 'Missing Authorization header' });
  const payload = verifyJwt(auth.substring(7));
  if (!payload) return sendJson(res, 401, { error: 'Invalid or expired token' });
  const admin = dbGet(`SELECT * FROM admin_users WHERE id = ${esc(payload.id)}`);
  if (!admin) return sendJson(res, 401, { error: 'Admin not found' });
  req.admin = admin;
  next();
}

// =====================================
// 工具函数
// =====================================

/**
 * 发送 JSON 响应
 */
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': config.CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(body);
}

/**
 * 格式化 Agent 对象（隐藏 api_key_hash，附加在线状态）
 */
function formatAgent(a) {
  if (!a) return null;
  const result = {
    id: a.id, name: a.name, description: a.description,
    inviteCodeId: a.invite_code_id, status: a.status,
    online: wsConnections.has(a.id),
    metadata: tryParseJson(a.metadata), createdAt: a.created_at, lastSeenAt: a.last_seen_at,
  };
  // 如果有邀请码详情（通过 JOIN 查询时），附加到输出
  if (a.invite_code !== undefined) result.inviteCode = a.invite_code;
  if (a.invite_label !== undefined) result.inviteLabel = a.invite_label;
  return result;
}

/**
 * 安全解析 JSON
 */
function tryParseJson(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return str; }
}

/** MIME 类型映射 */
const MIME_TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

// =====================================
// HTTP 服务器
// =====================================

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': config.CORS_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  const query = Object.fromEntries(parsedUrl.searchParams);

  // 限流检查
  const ip = req.socket.remoteAddress || 'unknown';
  if (pathname.startsWith('/api/') && isRateLimited(ip)) {
    return sendJson(res, 429, { error: 'Rate limit exceeded' });
  }

  // 解析 body
  const body = req.method !== 'GET' && req.method !== 'HEAD' ? await parseBody(req) : {};

  // 匹配路由
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const match = pathname.match(route.re);
    if (!match) continue;

    // 提取路径参数
    const params = {};
    route.paramNames.forEach((name, i) => { params[name] = match[i + 1]; });
    req.params = params;
    req.query = query;
    req.body = body;

    // 执行中间件链
    let idx = 0;
    const next = () => {
      if (idx < route.handlers.length) {
        const handler = route.handlers[idx++];
        try { handler(req, res, next); } catch (err) {
          console.error('Handler error:', err);
          sendJson(res, 500, { error: 'Internal server error' });
        }
      }
    };
    next();
    return;
  }

  // 静态文件服务（前端 SPA）
  if (!pathname.startsWith('/api/') && !pathname.startsWith('/ws')) {
    let filePath = path.join(config.WEB_PATH, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(filePath)) filePath = path.join(config.WEB_PATH, 'index.html');
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  sendJson(res, 404, { error: 'Not found' });
});

// WebSocket 升级处理
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/ws')) {
    handleUpgrade(req, socket);
  } else {
    socket.destroy();
  }
});

// =====================================
// 启动服务器
// =====================================

initDatabase();
seedAdmin();

server.listen(config.PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║       AgentForum Server Started       ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  REST API:  http://localhost:${config.PORT}/api/v1  ║`);
  console.log(`║  WebSocket: ws://localhost:${config.PORT}/ws       ║`);
  console.log(`║  Admin UI:  http://localhost:${config.PORT}        ║`);
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  console.log(`👤 Admin: ${config.ADMIN_INIT_USERNAME} / ${config.ADMIN_INIT_PASSWORD}`);
  console.log('');
});

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  server.close();
  try { fs.unlinkSync(TMP_SQL); } catch {}
  process.exit(0);
});
