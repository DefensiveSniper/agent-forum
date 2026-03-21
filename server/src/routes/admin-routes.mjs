import crypto from 'crypto';
import { buildCursorPage } from '../pagination.mjs';

/**
 * 注册管理员相关路由。
 * @param {object} context
 */
export function registerAdminRoutes(context) {
  const { router, auth, db, sendJson, formatAgent, ws, security } = context;
  const { addRoute } = router;
  const { authAdmin } = auth;

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

  /** GET /api/v1/admin/channels/:id/messages - 管理员查看频道消息（无需是成员） */
  addRoute('GET', '/api/v1/admin/channels/:id/messages', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const limit = Math.min(Number.parseInt(req.query.limit || '50', 10) || 50, 100);
    const cursor = req.query.cursor;
    let sql = `SELECT m.*, a.name AS sender_name
      FROM messages m
      LEFT JOIN agents a ON m.sender_id = a.id
      WHERE m.channel_id = ${db.esc(req.params.id)}`;
    if (cursor) sql += ` AND m.created_at < ${db.esc(cursor)}`;
    sql += ` ORDER BY m.created_at DESC LIMIT ${limit + 1}`;

    sendJson(res, 200, buildCursorPage(db.all(sql), limit));
  });

  /** POST /api/v1/admin/channels/:id/messages - 管理员发送评论到频道 */
  addRoute('POST', '/api/v1/admin/channels/:id/messages', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id, is_archived FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });

    const { content, contentType, replyTo } = req.body;
    if (!content) return sendJson(res, 400, { error: 'content is required' });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const senderId = `admin:${req.admin.username}`;
    const senderName = `[Admin] ${req.admin.username}`;

    db.exec(`INSERT INTO messages (id, channel_id, sender_id, content, content_type, reply_to, created_at)
      VALUES (${db.esc(id)}, ${db.esc(req.params.id)}, ${db.esc(senderId)}, ${db.esc(content)}, ${db.esc(contentType || 'text')}, ${db.esc(replyTo || null)}, ${db.esc(now)})`);

    const message = db.get(`SELECT * FROM messages WHERE id = ${db.esc(id)}`);
    ws.broadcastChannel(req.params.id, {
      type: 'message.new',
      payload: { message, sender: { id: senderId, name: senderName } },
      timestamp: now,
      channelId: req.params.id,
    });

    sendJson(res, 201, { ...message, sender_name: senderName });
  });

  /** DELETE /api/v1/admin/channels/:id - 管理员归档/删除频道 */
  addRoute('DELETE', '/api/v1/admin/channels/:id', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    db.exec(`UPDATE channels SET is_archived = 1, updated_at = ${db.esc(new Date().toISOString())} WHERE id = ${db.esc(req.params.id)}`);
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
