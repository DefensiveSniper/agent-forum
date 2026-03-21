import crypto from 'crypto';

/**
 * 注册订阅相关路由。
 * @param {object} context
 */
export function registerSubscriptionRoutes(context) {
  const { router, auth, db, sendJson, tryParseJson } = context;
  const { addRoute } = router;
  const { authAgent } = auth;

  /**
   * 将订阅记录转换为对外返回的 camelCase 结构。
   * @param {object} subscription
   * @returns {object}
   */
  function formatSubscription(subscription) {
    const eventTypes = tryParseJson(subscription.event_types);
    return {
      id: subscription.id,
      agentId: subscription.agent_id,
      channelId: subscription.channel_id,
      eventTypes: Array.isArray(eventTypes) ? eventTypes : [],
      createdAt: subscription.created_at,
    };
  }

  /** POST /api/v1/subscriptions - 创建订阅 */
  addRoute('POST', '/api/v1/subscriptions', authAgent, (req, res) => {
    const { channelId, eventTypes } = req.body;
    if (!channelId) {
      return sendJson(res, 400, { error: 'channelId is required' });
    }

    const channel = db.get(`SELECT id, type, is_archived FROM channels WHERE id = ${db.esc(channelId)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });

    const member = db.get(`SELECT agent_id FROM channel_members
      WHERE channel_id = ${db.esc(channelId)}
        AND agent_id = ${db.esc(req.agent.id)}`);
    if (channel.type === 'private' && !member) {
      return sendJson(res, 403, { error: 'Private channel subscriptions require membership' });
    }

    const resolvedEventTypes = Array.isArray(eventTypes) && eventTypes.length > 0 ? eventTypes : ['*'];
    const existing = db.get(`SELECT * FROM subscriptions
      WHERE agent_id = ${db.esc(req.agent.id)}
        AND channel_id = ${db.esc(channelId)}`);

    if (existing) {
      db.exec(`UPDATE subscriptions
        SET event_types = ${db.esc(JSON.stringify(resolvedEventTypes))}
        WHERE id = ${db.esc(existing.id)}`);
      const updated = db.get(`SELECT * FROM subscriptions WHERE id = ${db.esc(existing.id)}`);
      return sendJson(res, 200, formatSubscription(updated));
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.exec(`INSERT INTO subscriptions (id, agent_id, channel_id, event_types, created_at)
      VALUES (${db.esc(id)}, ${db.esc(req.agent.id)}, ${db.esc(channelId)}, ${db.esc(JSON.stringify(resolvedEventTypes))}, ${db.esc(now)})`);

    sendJson(res, 201, { id, agentId: req.agent.id, channelId, eventTypes: resolvedEventTypes, createdAt: now });
  });

  /** GET /api/v1/subscriptions - 获取当前 Agent 的订阅 */
  addRoute('GET', '/api/v1/subscriptions', authAgent, (req, res) => {
    const subscriptions = db.all(`SELECT * FROM subscriptions WHERE agent_id = ${db.esc(req.agent.id)}`);
    sendJson(res, 200, subscriptions.map(formatSubscription));
  });

  /** DELETE /api/v1/subscriptions/:id - 取消订阅 */
  addRoute('DELETE', '/api/v1/subscriptions/:id', authAgent, (req, res) => {
    db.exec(`DELETE FROM subscriptions WHERE id = ${db.esc(req.params.id)} AND agent_id = ${db.esc(req.agent.id)}`);
    res.writeHead(204).end();
  });
}
