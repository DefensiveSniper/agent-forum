import { eq, and, ne, desc, lt, sql, getTableColumns } from 'drizzle-orm';
import { channels, agents, channelMembers, messages } from '../schema.mjs';
import { alias } from 'drizzle-orm/pg-core';
import { buildCursorPage } from '../pagination.mjs';

/**
 * 注册公开只读路由。
 * @param {object} context
 */
export function registerPublicRoutes(context) {
  const { router, db, sendJson, ws, messaging } = context;
  const { addRoute } = router;
  const { orm } = db;

  const rm = alias(messages, 'rm');
  const ra = alias(agents, 'ra');

  /**
   * 读取可公开访问的频道。
   * @param {string} channelId
   * @returns {Promise<object|undefined>}
   */
  async function getPublicChannel(channelId) {
    const [channel] = await orm.select().from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.is_archived, 0), ne(channels.type, 'private')));
    return channel;
  }

  /** GET /api/v1/public/agents - 公开查看所有 Agent（不含敏感信息） */
  addRoute('GET', '/api/v1/public/agents', async (req, res) => {
    const rows = await orm.select().from(agents).orderBy(desc(agents.created_at));
    sendJson(res, 200, rows.map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      status: agent.status,
      online: ws.isAgentOnline(agent.id),
      lastSeenAt: agent.last_seen_at,
    })));
  });

  /** GET /api/v1/public/channels - 公开查看所有频道 */
  addRoute('GET', '/api/v1/public/channels', async (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit || '50', 10) || 50, 100);
    const offset = Number.parseInt(req.query.offset || '0', 10) || 0;

    const rows = await orm.select({
      ...getTableColumns(channels),
      member_count: sql`(SELECT COUNT(*) FROM channel_members WHERE channel_id = ${channels.id})`.as('member_count'),
    }).from(channels)
      .where(and(eq(channels.is_archived, 0), ne(channels.type, 'private')))
      .orderBy(desc(channels.created_at))
      .limit(limit)
      .offset(offset);

    sendJson(res, 200, rows);
  });

  /** GET /api/v1/public/channels/:id - 公开查看频道详情（含成员和在线状态） */
  addRoute('GET', '/api/v1/public/channels/:id', async (req, res) => {
    const [channel] = await orm.select({
      ...getTableColumns(channels),
      member_count: sql`(SELECT COUNT(*) FROM channel_members WHERE channel_id = ${channels.id})`.as('member_count'),
    }).from(channels)
      .where(and(eq(channels.id, req.params.id), eq(channels.is_archived, 0), ne(channels.type, 'private')));
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const members = await orm.select({
      ...getTableColumns(channelMembers),
      agent_name: agents.name,
      agent_status: agents.status,
    }).from(channelMembers)
      .leftJoin(agents, eq(channelMembers.agent_id, agents.id))
      .where(eq(channelMembers.channel_id, req.params.id));

    const membersWithOnline = members.map((member) => ({
      ...member,
      online: ws.isAgentOnline(member.agent_id),
    }));

    sendJson(res, 200, { ...channel, members: membersWithOnline });
  });

  /** GET /api/v1/public/channels/:id/messages - 公开查看频道消息（只读） */
  addRoute('GET', '/api/v1/public/channels/:id/messages', async (req, res) => {
    const channel = await getPublicChannel(req.params.id);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const limit = Math.min(Number.parseInt(req.query.limit || '50', 10) || 50, 100);
    const cursor = req.query.cursor;

    const conditions = [eq(messages.channel_id, req.params.id)];
    if (cursor) conditions.push(lt(messages.created_at, cursor));

    const rows = await orm.select({
      ...getTableColumns(messages),
      sender_name: agents.name,
      reply_sender_id: rm.sender_id,
      reply_sender_name: ra.name,
      reply_content: rm.content,
    }).from(messages)
      .leftJoin(agents, eq(agents.id, messages.sender_id))
      .leftJoin(rm, eq(rm.id, messages.reply_to))
      .leftJoin(ra, eq(ra.id, rm.sender_id))
      .where(and(...conditions))
      .orderBy(desc(messages.created_at))
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit);
    sendJson(res, 200, {
      ...page,
      data: messaging.formatMessages(page.data),
    });
  });
}
