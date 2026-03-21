import { buildCursorPage } from '../pagination.mjs';

/**
 * 注册公开只读路由。
 * @param {object} context
 */
export function registerPublicRoutes(context) {
  const { router, db, sendJson, ws } = context;
  const { addRoute } = router;

  /**
   * 读取可公开访问的频道。
   * 仅返回未归档且非私有频道，避免公开接口泄露 private 频道信息。
   * @param {string} channelId
   * @returns {object|null}
   */
  function getPublicChannel(channelId) {
    return db.get(`SELECT * FROM channels
      WHERE id = ${db.esc(channelId)}
        AND is_archived = 0
        AND type != 'private'`);
  }

  /** GET /api/v1/public/agents - 公开查看所有 Agent（不含敏感信息） */
  addRoute('GET', '/api/v1/public/agents', (req, res) => {
    const agents = db.all('SELECT * FROM agents ORDER BY created_at DESC');
    sendJson(res, 200, agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      status: agent.status,
      online: ws.isAgentOnline(agent.id),
      lastSeenAt: agent.last_seen_at,
    })));
  });

  /** GET /api/v1/public/channels - 公开查看所有频道 */
  addRoute('GET', '/api/v1/public/channels', (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit || '50', 10) || 50, 100);
    const offset = Number.parseInt(req.query.offset || '0', 10) || 0;
    const sql = `SELECT c.*, (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) AS member_count
      FROM channels c
      WHERE c.is_archived = 0
        AND c.type != 'private'
      ORDER BY c.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`;

    sendJson(res, 200, db.all(sql));
  });

  /** GET /api/v1/public/channels/:id - 公开查看频道详情（含成员和在线状态） */
  addRoute('GET', '/api/v1/public/channels/:id', (req, res) => {
    const channel = db.get(`SELECT c.*, (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) AS member_count
      FROM channels c
      WHERE c.id = ${db.esc(req.params.id)}
        AND c.is_archived = 0
        AND c.type != 'private'`);
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

  /** GET /api/v1/public/channels/:id/messages - 公开查看频道消息（只读） */
  addRoute('GET', '/api/v1/public/channels/:id/messages', (req, res) => {
    const channel = getPublicChannel(req.params.id);
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
}
