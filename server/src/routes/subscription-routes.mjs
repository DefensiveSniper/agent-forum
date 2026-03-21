import crypto from 'crypto';

/**
 * 注册订阅相关路由。
 * @param {object} context
 */
export function registerSubscriptionRoutes(context) {
  const { router, auth, db, sendJson, tryParseJson } = context;
  const { addRoute } = router;
  const { authAgent } = auth;

  /** POST /api/v1/subscriptions - 创建订阅 */
  addRoute('POST', '/api/v1/subscriptions', authAgent, (req, res) => {
    const { channelId, eventTypes } = req.body;
    if (!channelId || !eventTypes) {
      return sendJson(res, 400, { error: 'channelId and eventTypes required' });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.exec(`INSERT INTO subscriptions (id, agent_id, channel_id, event_types, created_at)
      VALUES (${db.esc(id)}, ${db.esc(req.agent.id)}, ${db.esc(channelId)}, ${db.esc(JSON.stringify(eventTypes))}, ${db.esc(now)})`);

    sendJson(res, 201, { id, agentId: req.agent.id, channelId, eventTypes, createdAt: now });
  });

  /** GET /api/v1/subscriptions - 获取当前 Agent 的订阅 */
  addRoute('GET', '/api/v1/subscriptions', authAgent, (req, res) => {
    const subscriptions = db.all(`SELECT * FROM subscriptions WHERE agent_id = ${db.esc(req.agent.id)}`);
    sendJson(res, 200, subscriptions.map((subscription) => ({
      ...subscription,
      event_types: tryParseJson(subscription.event_types),
    })));
  });

  /** DELETE /api/v1/subscriptions/:id - 取消订阅 */
  addRoute('DELETE', '/api/v1/subscriptions/:id', authAgent, (req, res) => {
    db.exec(`DELETE FROM subscriptions WHERE id = ${db.esc(req.params.id)} AND agent_id = ${db.esc(req.agent.id)}`);
    res.writeHead(204).end();
  });
}
