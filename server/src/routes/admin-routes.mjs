import crypto from 'crypto';
import { buildCursorPage } from '../pagination.mjs';
import { parseCookies } from '../http-utils.mjs';

/**
 * 注册管理员相关路由。
 * @param {object} context
 */
export function registerAdminRoutes(context) {
  const { config, router, auth, db, sendJson, formatAgent, ws, security, messaging, monitoring, captcha, rateLimiter } = context;
  const { addRoute } = router;
  const { authAdmin } = auth;
  const VALID_CHANNEL_TYPES = new Set(['public', 'private', 'broadcast']);

  /**
   * 归一化管理员提交的邀请 Agent 列表。
   * 同时兼容单个 `agentId` 和批量 `agentIds` 两种写法。
   * @param {object} body
   * @returns {string[]}
   */
  function resolveInviteAgentIds(body = {}) {
    const rawIds = [];

    if (typeof body.agentId === 'string') rawIds.push(body.agentId);
    if (Array.isArray(body.agentIds)) rawIds.push(...body.agentIds);

    return [...new Set(
      rawIds
        .map((agentId) => typeof agentId === 'string' ? agentId.trim() : '')
        .filter(Boolean)
    )];
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
   * 按输入顺序读取已注册 Agent，并返回缺失 ID 列表。
   * @param {string[]} agentIds
   * @returns {{ agents: Array<{ id: string, name: string, status: string }>, missingIds: string[] }}
   */
  function resolveRegisteredAgents(agentIds) {
    if (agentIds.length === 0) {
      return { agents: [], missingIds: [] };
    }

    const sql = `SELECT id, name, status FROM agents WHERE id IN (${agentIds.map((agentId) => db.esc(agentId)).join(', ')})`;
    const rows = db.all(sql);
    const rowMap = new Map(rows.map((row) => [row.id, row]));
    const agents = agentIds.map((agentId) => rowMap.get(agentId)).filter(Boolean);
    const missingIds = agentIds.filter((agentId) => !rowMap.has(agentId));

    return { agents, missingIds };
  }

  /**
   * 将 Agent 加入频道，并广播成员加入事件。
   * @param {object} options
   * @param {string} options.channelId
   * @param {Array<{ id: string, name: string }>} options.agents
   * @param {string} options.invitedBy
   * @returns {Array<{ id: string, name: string }>}
   */
  function addAgentsToChannel({ channelId, agents, invitedBy }) {
    if (agents.length === 0) return [];

    const now = new Date().toISOString();
    for (const agent of agents) {
      db.exec(`INSERT INTO channel_members (channel_id, agent_id, role, joined_at)
        VALUES (${db.esc(channelId)}, ${db.esc(agent.id)}, 'member', ${db.esc(now)})`);

      ws.broadcastChannel(channelId, {
        type: 'member.joined',
        payload: { channelId, agentId: agent.id, agentName: agent.name, invitedBy },
        timestamp: now,
        channelId,
      });
    }

    return agents.map((agent) => ({ id: agent.id, name: agent.name }));
  }

  /**
   * 彻底删除频道及其关联数据。
   * @param {string} channelId
   */
  function deleteChannelCascade(channelId) {
    db.exec(`
      DELETE FROM messages WHERE channel_id = ${db.esc(channelId)};
      DELETE FROM channel_members WHERE channel_id = ${db.esc(channelId)};
      DELETE FROM subscriptions WHERE channel_id = ${db.esc(channelId)};
      DELETE FROM discussion_sessions WHERE channel_id = ${db.esc(channelId)};
      DELETE FROM channels WHERE id = ${db.esc(channelId)};
    `);
  }

  /**
   * 将消息服务错误映射为 HTTP 响应。
   * @param {import('http').ServerResponse} res
   * @param {Error} err
   * @returns {void}
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
    if (message === 'Discussion session not found' || message === 'Discussion session does not belong to this channel') {
      sendJson(res, 404, { error: message });
      return;
    }
    if (
      message === 'Discussion session is not active'
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
   * 构建格式化后的消息分页结果。
   * @param {Array<object>} rows
   * @param {number} limit
   * @returns {object}
   */
  function buildMessagePage(rows, limit) {
    const page = buildCursorPage(rows, limit);
    return {
      ...page,
      data: messaging.formatMessages(page.data),
    };
  }

  /**
   * 基于最近一分钟的成功率和响应时延计算系统健康度。
   * 成功率决定基础分，高延迟会进一步扣分。
   * @param {object} snapshot
   * @param {number} snapshot.totalRequestsLastMinute
   * @param {number} snapshot.errorRate
   * @param {number} snapshot.avgResponseMs
   * @returns {{ score: number, level: string, label: string, summary: string }}
   */
  function buildHealthStatus(snapshot) {
    if (snapshot.totalRequestsLastMinute === 0) {
      return {
        score: 100,
        level: 'stable',
        label: '空闲',
        summary: '最近 1 分钟没有 API 请求，系统处于空闲状态。',
      };
    }

    const successRateScore = (1 - snapshot.errorRate) * 100;
    const latencyPenalty = snapshot.avgResponseMs <= 300
      ? 0
      : Math.min(25, (snapshot.avgResponseMs - 300) / 28);
    const score = Math.max(0, Math.round(successRateScore - latencyPenalty));

    if (score >= 90) {
      return {
        score,
        level: 'stable',
        label: '稳定',
        summary: '最近 1 分钟请求成功率和响应时延均在健康范围内。',
      };
    }

    if (score >= 70) {
      return {
        score,
        level: 'watch',
        label: '关注',
        summary: '最近 1 分钟存在少量错误或时延抬升，建议继续观察。',
      };
    }

    return {
      score,
      level: 'critical',
      label: '告警',
      summary: '最近 1 分钟错误率或响应时延偏高，需要立即排查。',
    };
  }

  /**
   * 构建设备信任 Cookie 的 Set-Cookie 头值。
   * @param {string} deviceToken
   * @param {number} maxAge
   * @returns {string}
   */
  function buildDeviceCookie(deviceToken, maxAge) {
    const parts = [`device_trust=${deviceToken}`, 'HttpOnly', 'SameSite=Strict', 'Path=/api/v1/admin', `Max-Age=${maxAge}`];
    if (config.NODE_ENV !== 'development') parts.push('Secure');
    return parts.join('; ');
  }

  /**
   * 构建清除设备信任 Cookie 的 Set-Cookie 头值。
   * @returns {string}
   */
  function buildClearDeviceCookie() {
    const parts = ['device_trust=', 'HttpOnly', 'SameSite=Strict', 'Path=/api/v1/admin', 'Max-Age=0'];
    if (config.NODE_ENV !== 'development') parts.push('Secure');
    return parts.join('; ');
  }

  /**
   * 签发设备信任 Token 并写入数据库。
   * @param {object} options
   * @param {string} options.adminId
   * @param {string} options.userAgent
   * @param {string} options.ip
   * @returns {string} 原始 deviceToken（用于 cookie）
   */
  function issueDeviceToken({ adminId, userAgent, ip }) {
    const deviceToken = crypto.randomBytes(48).toString('hex');
    const hash = security.hashDeviceToken(deviceToken);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + config.DEVICE_TRUST_MAX_AGE * 1000).toISOString();

    db.exec(`INSERT INTO admin_devices (id, admin_id, device_token_hash, user_agent, ip_address, created_at, last_used_at, expires_at)
      VALUES (${db.esc(crypto.randomUUID())}, ${db.esc(adminId)}, ${db.esc(hash)}, ${db.esc(userAgent || null)}, ${db.esc(ip || null)}, ${db.esc(now)}, ${db.esc(now)}, ${db.esc(expiresAt)})`);

    return deviceToken;
  }

  /** GET /api/v1/admin/captcha - 获取图形验证码 */
  addRoute('GET', '/api/v1/admin/captcha', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (rateLimiter.isRateLimited(`captcha:${ip}`, 20, 60000)) {
      return sendJson(res, 429, { error: 'Too many captcha requests' });
    }
    sendJson(res, 200, captcha.generateCaptcha());
  });

  /** POST /api/v1/admin/login - 管理员登录（含验证码校验和失败锁定） */
  addRoute('POST', '/api/v1/admin/login', (req, res) => {
    const { username, password, captchaId, captchaText } = req.body;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    if (!username || !password) {
      return sendJson(res, 400, { error: 'username and password required' });
    }
    if (!captchaId || !captchaText) {
      return sendJson(res, 400, { error: 'captchaId and captchaText required' });
    }

    // 检查是否被锁定
    const lockStatus = captcha.isLocked(ip, username);
    if (lockStatus.locked) {
      return sendJson(res, 423, {
        error: '登录尝试次数过多，账户已暂时锁定',
        lockedUntil: lockStatus.lockedUntil,
        remainingSeconds: lockStatus.remainingSeconds,
      });
    }

    // 验证验证码
    const captchaResult = captcha.verifyCaptcha(captchaId, captchaText);
    if (!captchaResult.valid) {
      return sendJson(res, 400, { error: captchaResult.reason });
    }

    // 验证用户名密码
    const admin = db.get(`SELECT * FROM admin_users WHERE username = ${db.esc(username)}`);
    if (!admin || !security.verifyPassword(password, admin.password_hash)) {
      captcha.recordFailure(ip, username);
      const newLockStatus = captcha.isLocked(ip, username);
      return sendJson(res, 401, {
        error: 'Invalid credentials',
        ...(newLockStatus.locked ? {
          locked: true,
          lockedUntil: newLockStatus.lockedUntil,
          remainingSeconds: newLockStatus.remainingSeconds,
        } : {}),
      });
    }

    // 登录成功：清除失败计数，签发 JWT 和设备信任 Token
    captcha.clearFailure(ip, username);
    const token = security.signJwt({ id: admin.id, username: admin.username, role: admin.role });
    const deviceToken = issueDeviceToken({
      adminId: admin.id,
      userAgent: req.headers['user-agent'],
      ip,
    });

    console.log(`🔑 Admin login: ${username}`);
    sendJson(res, 200, {
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        role: admin.role,
        createdAt: admin.created_at,
      },
    }, {
      'Set-Cookie': buildDeviceCookie(deviceToken, config.DEVICE_TRUST_MAX_AGE),
    });
  });

  /** POST /api/v1/admin/refresh - 通过设备信任 Cookie 刷新 JWT（7天免登录） */
  addRoute('POST', '/api/v1/admin/refresh', (req, res) => {
    const cookies = parseCookies(req);
    const deviceToken = cookies.device_trust;

    if (!deviceToken) {
      return sendJson(res, 401, { error: 'No device trust token' });
    }

    const hash = security.hashDeviceToken(deviceToken);
    const device = db.get(`SELECT * FROM admin_devices WHERE device_token_hash = ${db.esc(hash)}`);

    if (!device) {
      return sendJson(res, 401, { error: 'Invalid device token' }, {
        'Set-Cookie': buildClearDeviceCookie(),
      });
    }

    // 检查是否过期
    if (new Date(device.expires_at) <= new Date()) {
      db.exec(`DELETE FROM admin_devices WHERE id = ${db.esc(device.id)}`);
      return sendJson(res, 401, { error: 'Device token expired' }, {
        'Set-Cookie': buildClearDeviceCookie(),
      });
    }

    // 查找关联的管理员
    const admin = db.get(`SELECT * FROM admin_users WHERE id = ${db.esc(device.admin_id)}`);
    if (!admin) {
      db.exec(`DELETE FROM admin_devices WHERE id = ${db.esc(device.id)}`);
      return sendJson(res, 401, { error: 'Admin not found' }, {
        'Set-Cookie': buildClearDeviceCookie(),
      });
    }

    // 更新最后使用时间
    db.exec(`UPDATE admin_devices SET last_used_at = ${db.esc(new Date().toISOString())} WHERE id = ${db.esc(device.id)}`);

    // 如果距过期不足 2 天，滑动续期
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
    const extraHeaders = {};
    if (new Date(device.expires_at).getTime() - Date.now() < twoDaysMs) {
      const newExpiresAt = new Date(Date.now() + config.DEVICE_TRUST_MAX_AGE * 1000).toISOString();
      db.exec(`UPDATE admin_devices SET expires_at = ${db.esc(newExpiresAt)} WHERE id = ${db.esc(device.id)}`);
      extraHeaders['Set-Cookie'] = buildDeviceCookie(deviceToken, config.DEVICE_TRUST_MAX_AGE);
    }

    const token = security.signJwt({ id: admin.id, username: admin.username, role: admin.role });
    console.log(`🔄 Admin token refreshed via device trust: ${admin.username}`);
    sendJson(res, 200, {
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        role: admin.role,
        createdAt: admin.created_at,
      },
    }, extraHeaders);
  });

  /** POST /api/v1/admin/logout - 管理员登出（清除设备信任） */
  addRoute('POST', '/api/v1/admin/logout', (req, res) => {
    const cookies = parseCookies(req);
    const deviceToken = cookies.device_trust;

    if (deviceToken) {
      const hash = security.hashDeviceToken(deviceToken);
      db.exec(`DELETE FROM admin_devices WHERE device_token_hash = ${db.esc(hash)}`);
    }

    sendJson(res, 200, { message: 'Logged out' }, {
      'Set-Cookie': buildClearDeviceCookie(),
    });
  });

  /** GET /api/v1/admin/monitoring - 获取管理员监控面板数据 */
  addRoute('GET', '/api/v1/admin/monitoring', authAdmin, (req, res) => {
    const traffic = monitoring.getSnapshot();
    const channelCount = db.get('SELECT COUNT(*) AS cnt FROM channels WHERE is_archived = 0');
    const agentCount = db.get('SELECT COUNT(*) AS cnt FROM agents');
    const health = buildHealthStatus(traffic);

    sendJson(res, 200, {
      generatedAt: traffic.generatedAt,
      startedAt: traffic.startedAt,
      health,
      overview: {
        uptimeMs: traffic.uptimeMs,
        totalAgents: agentCount?.cnt || 0,
        activeChannels: channelCount?.cnt || 0,
        onlineAgents: traffic.connections.onlineAgents,
        totalConnections: traffic.connections.totalConnections,
        adminConnections: traffic.connections.adminConnections,
        qps: traffic.currentQps,
        peakQps: traffic.peakQps,
        requestsLastMinute: traffic.totalRequestsLastMinute,
        errorsLastMinute: traffic.totalErrorsLastMinute,
        avgResponseMs: traffic.avgResponseMs,
        errorRate: traffic.errorRate,
        errorRatePercent: Number((traffic.errorRate * 100).toFixed(1)),
      },
      history: traffic.history,
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

    const { agents, missingIds } = resolveRegisteredAgents(inviteAgentIds);
    if (missingIds.length > 0) {
      return sendJson(res, 404, { error: 'Some target agents were not found', missingAgentIds: missingIds });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.exec(`INSERT INTO channels (id, name, description, type, created_by, max_members, created_at, updated_at)
      VALUES (${db.esc(id)}, ${db.esc(trimmedName)}, ${db.esc(description || null)}, ${db.esc(resolvedType)}, ${db.esc(`admin:${req.admin.id}`)}, ${db.esc(maxMembers)}, ${db.esc(now)}, ${db.esc(now)})`);

    const invitedAgents = addAgentsToChannel({
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

    const { agents, missingIds } = resolveRegisteredAgents(inviteAgentIds);
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
      rm.sender_id AS reply_sender_id,
      ra.name AS reply_sender_name,
      rm.content AS reply_content
      FROM messages m
      LEFT JOIN messages rm ON rm.id = m.reply_to
      LEFT JOIN agents ra ON ra.id = rm.sender_id
      LEFT JOIN agents a ON m.sender_id = a.id
      WHERE m.channel_id = ${db.esc(req.params.id)}`;
    if (cursor) sql += ` AND m.created_at < ${db.esc(cursor)}`;
    sql += ` ORDER BY m.created_at DESC LIMIT ${limit + 1}`;

    sendJson(res, 200, buildMessagePage(db.all(sql), limit));
  });

  /** POST /api/v1/admin/channels/:id/messages - 管理员发送评论到频道 */
  addRoute('POST', '/api/v1/admin/channels/:id/messages', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id, is_archived FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });

    const { content, contentType, replyTo, mentionAgentIds, discussionSessionId } = req.body;
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
      });

      ws.broadcastChannel(req.params.id, {
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

  /** POST /api/v1/admin/channels/:id/discussions - 管理员发起线性多 Agent 讨论 */
  addRoute('POST', '/api/v1/admin/channels/:id/discussions', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id, is_archived FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });

    const { content, participantAgentIds, maxRounds } = req.body || {};
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
      });

      ws.broadcastChannel(req.params.id, {
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

  /** POST /api/v1/admin/channels/:id/discussions/:sessionId/interrupt - 管理员中断活跃的线性讨论 */
  addRoute('POST', '/api/v1/admin/channels/:id/discussions/:sessionId/interrupt', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id, is_archived FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const senderId = `admin:${req.admin.username}`;
    const senderName = `[Admin] ${req.admin.username}`;

    try {
      const { message, discussion } = messaging.interruptLinearDiscussion({
        sessionId: req.params.sessionId,
        channelId: req.params.id,
        senderId,
        senderName,
      });

      ws.broadcastChannel(req.params.id, {
        type: 'message.new',
        payload: { message, sender: { id: senderId, name: senderName } },
        timestamp: message.created_at,
        channelId: req.params.id,
      });

      sendJson(res, 200, { message, discussion });
    } catch (err) {
      sendMessagingError(res, err);
    }
  });

  /** DELETE /api/v1/admin/channels/:id - 管理员彻底删除频道 */
  addRoute('DELETE', '/api/v1/admin/channels/:id', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id, name FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    deleteChannelCascade(req.params.id);
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
