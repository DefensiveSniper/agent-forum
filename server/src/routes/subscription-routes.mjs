import crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import { channels, channelMembers, subscriptions } from '../schema.mjs';

/**
 * 注册订阅相关路由。
 * @param {object} context
 */
export function registerSubscriptionRoutes(context) {
  const { router, auth, db, sendJson, tryParseJson } = context;
  const { addRoute } = router;
  const { authAgent } = auth;
  const { orm } = db;

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
  addRoute('POST', '/api/v1/subscriptions', authAgent, async (req, res) => {
    const { channelId, eventTypes } = req.body;
    if (!channelId) {
      return sendJson(res, 400, { error: 'channelId is required' });
    }

    const [channel] = await orm.select({
      id: channels.id,
      type: channels.type,
      is_archived: channels.is_archived,
    }).from(channels).where(eq(channels.id, channelId));
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });
    if (channel.is_archived) return sendJson(res, 403, { error: 'Channel is archived' });

    const [member] = await orm.select({ agent_id: channelMembers.agent_id })
      .from(channelMembers)
      .where(and(eq(channelMembers.channel_id, channelId), eq(channelMembers.agent_id, req.agent.id)));
    if (channel.type === 'private' && !member) {
      return sendJson(res, 403, { error: 'Private channel subscriptions require membership' });
    }

    const resolvedEventTypes = Array.isArray(eventTypes) && eventTypes.length > 0 ? eventTypes : ['*'];
    const [existing] = await orm.select().from(subscriptions)
      .where(and(eq(subscriptions.agent_id, req.agent.id), eq(subscriptions.channel_id, channelId)));

    if (existing) {
      await orm.update(subscriptions)
        .set({ event_types: JSON.stringify(resolvedEventTypes) })
        .where(eq(subscriptions.id, existing.id));
      const [updated] = await orm.select().from(subscriptions).where(eq(subscriptions.id, existing.id));
      return sendJson(res, 200, formatSubscription(updated));
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await orm.insert(subscriptions).values({
      id,
      agent_id: req.agent.id,
      channel_id: channelId,
      event_types: JSON.stringify(resolvedEventTypes),
      created_at: now,
    });

    sendJson(res, 201, { id, agentId: req.agent.id, channelId, eventTypes: resolvedEventTypes, createdAt: now });
  });

  /** GET /api/v1/subscriptions - 获取当前 Agent 的订阅 */
  addRoute('GET', '/api/v1/subscriptions', authAgent, async (req, res) => {
    const rows = await orm.select().from(subscriptions).where(eq(subscriptions.agent_id, req.agent.id));
    sendJson(res, 200, rows.map(formatSubscription));
  });

  /** DELETE /api/v1/subscriptions/:id - 取消订阅 */
  addRoute('DELETE', '/api/v1/subscriptions/:id', authAgent, async (req, res) => {
    await orm.delete(subscriptions)
      .where(and(eq(subscriptions.id, req.params.id), eq(subscriptions.agent_id, req.agent.id)));
    res.writeHead(204).end();
  });
}
