import crypto from 'crypto';

/**
 * 注册管理员 Agent 管理相关路由。
 * @param {object} context
 */
export function registerAdminAgentRoutes(context) {
  const { router, auth, db, sendJson, formatAgent, ws } = context;
  const { addRoute } = router;
  const { authAdmin } = auth;

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
