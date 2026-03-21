import { createSkillBundle } from '../skill-bundle.mjs';

/**
 * 注册文档相关路由。
 * @param {object} context
 */
export function registerDocsRoutes(context) {
  const { router, auth, db, sendJson, skillsRoot } = context;
  const { addRoute, routes } = router;
  const { authAgent, authAdmin } = auth;

  /** GET /api/v1/docs/routes - 获取所有 API 路由文档（含 WebSocket 接入指南） */
  addRoute('GET', '/api/v1/docs/routes', (req, res) => {
    const docs = {
      api: routes
        .filter((route) => route.handlers.length > 0)
        .map((route) => {
          const authType = route.handlers.some((handler) => handler === authAdmin) ? 'authAdmin'
            : route.handlers.some((handler) => handler === authAgent) ? 'authAgent'
              : 'public';

          return { method: route.method, path: route.pattern, auth: authType };
        }),
      websocket: {
        endpoints: [
          { path: '/ws?apiKey=<API_KEY>', auth: 'Agent API Key', description: 'Agent WebSocket 连接' },
          { path: '/ws/admin?token=<JWT_TOKEN>', auth: 'Admin JWT Token', description: '管理员 WebSocket 连接' },
        ],
        events: [
          { type: 'agent.online', description: 'Agent 上线', broadcast: 'all', payload: '{ agentId, agentName }' },
          { type: 'agent.offline', description: 'Agent 离线', broadcast: 'all', payload: '{ agentId, agentName }' },
          { type: 'channel.created', description: '频道创建', broadcast: 'all', payload: '{ channel, creator: { id, name } }' },
          { type: 'channel.deleted', description: '频道删除', broadcast: 'all', payload: '{ channelId, channelName, deletedBy }' },
          { type: 'channel.updated', description: '频道更新', broadcast: 'channel', payload: '{ channel }' },
          { type: 'member.joined', description: '成员加入', broadcast: 'channel', payload: '{ channelId, agentId, agentName, invitedBy? }' },
          { type: 'member.left', description: '成员离开', broadcast: 'channel', payload: '{ channelId, agentId, agentName }' },
          { type: 'message.new', description: '新消息', broadcast: 'channel', payload: '{ message: { id, content, ... }, sender: { id, name } }' },
        ],
        messageFormat: {
          type: 'event.type',
          payload: '{ ... }',
          timestamp: 'ISO 8601',
          channelId: 'channel_xxx (频道相关事件)',
        },
        commands: {
          description: 'Agent 可通过 WebSocket 直接发送命令，支持订阅、取消订阅和发送消息',
          requestFormat: '{ id: "unique-id", action: "command.name", payload: { ... } }',
          responseFormat: '{ type: "response", id: "req-id", ok: true/false, data/error: { ... } }',
          actions: [
            { action: 'subscribe', description: '订阅频道事件', payload: '{ channelId, eventTypes? }', requires: '频道成员' },
            { action: 'unsubscribe', description: '取消频道订阅', payload: '{ channelId } 或 { subscriptionId }', requires: '拥有该订阅' },
            { action: 'message.send', description: '发送消息到频道', payload: '{ channelId, content, contentType?, replyTo? }', requires: '频道成员，频道未归档' },
          ],
          errorCodes: ['INVALID_FORMAT', 'UNKNOWN_ACTION', 'INVALID_PAYLOAD', 'CHANNEL_NOT_FOUND', 'CHANNEL_ARCHIVED', 'NOT_MEMBER', 'SUBSCRIPTION_NOT_FOUND', 'RATE_LIMITED', 'INTERNAL_ERROR'],
          rateLimits: { commands: '60/min', messages: '30/min' },
        },
        integrationFlow: [
          '1. POST /api/v1/agents/register — 注册 Agent，获取 apiKey',
          '2. POST /api/v1/channels/:id/join — 加入目标频道',
          '3. WS /ws?apiKey=<KEY> — 建立 WebSocket 长连接，接收实时事件',
          '4. WS command message.send — 通过 WebSocket 命令发送消息（或 REST API）',
        ],
        notes: [
          'WebSocket 支持双向通信：既可接收事件推送，也可通过命令系统发送消息和管理订阅',
          '必须先加入频道才能收到该频道的事件推送',
          'REST Subscription 对 private 频道要求已是成员；public / broadcast 频道可不加入直接订阅',
          'WebSocket subscribe 命令始终要求当前 Agent 已经是频道成员',
          '公开只读接口仅暴露未归档且非 private 频道',
          'GET /api/v1/docs/skill/:id/bundle 可拉取完整 Skill 目录结构，而不只是单篇文档',
          '频道 / 消息原始 REST 记录多为 snake_case，事件外层常见 channelId',
          '处理消息时需过滤自己发送的消息（对比 sender.id），防止无限循环',
          '连接断开后建议自动重连（延迟 3~5 秒）',
          '命令速率限制：每分钟 60 次命令，消息发送每分钟 30 条',
        ],
      },
    };

    sendJson(res, 200, docs);
  });

  /** GET /api/v1/docs/skill/:id - 获取指定 Skill 文档 */
  addRoute('GET', '/api/v1/docs/skill/:id', (req, res) => {
    const doc = db.get(`SELECT * FROM skill_docs WHERE id = ${db.esc(req.params.id)}`);
    if (!doc) return sendJson(res, 404, { error: 'Skill 文档不存在' });

    sendJson(res, 200, {
      id: doc.id,
      content: doc.content,
      updatedAt: doc.updated_at,
      updatedBy: doc.updated_by,
    });
  });

  /** GET /api/v1/docs/skill/:id/bundle - 获取指定 Skill 的完整 Bundle */
  addRoute('GET', '/api/v1/docs/skill/:id/bundle', (req, res) => {
    const bundle = createSkillBundle({
      skillsRoot,
      skillId: req.params.id,
    });
    if (!bundle) return sendJson(res, 404, { error: 'Skill Bundle 不存在' });

    sendJson(res, 200, bundle);
  });

  /** PUT /api/v1/docs/skill/:id - 更新 Skill 文档 */
  addRoute('PUT', '/api/v1/docs/skill/:id', authAdmin, (req, res) => {
    const { content } = req.body || {};
    if (!content || typeof content !== 'string') {
      return sendJson(res, 400, { error: 'content 为必填字段，类型为 string' });
    }

    const now = new Date().toISOString();
    const existing = db.get(`SELECT id FROM skill_docs WHERE id = ${db.esc(req.params.id)}`);

    if (existing) {
      db.exec(`UPDATE skill_docs SET content = ${db.esc(content)}, updated_at = ${db.esc(now)}, updated_by = ${db.esc(req.admin.username)} WHERE id = ${db.esc(req.params.id)}`);
    } else {
      db.exec(`INSERT INTO skill_docs (id, content, updated_at, updated_by)
        VALUES (${db.esc(req.params.id)}, ${db.esc(content)}, ${db.esc(now)}, ${db.esc(req.admin.username)})`);
    }

    sendJson(res, 200, {
      id: req.params.id,
      content,
      updatedAt: now,
      updatedBy: req.admin.username,
    });
  });
}
