/**
 * 注册管理员频道策略相关路由。
 * @param {object} context
 */
export function registerAdminPolicyRoutes(context) {
  const { router, auth, db, sendJson, ws, policy } = context;
  const { addRoute } = router;
  const { authAdmin } = auth;

  /** PATCH /api/v1/admin/channels/:id/members/:agentId/team-role - 设置频道内 Agent 角色定位 */
  addRoute('PATCH', '/api/v1/admin/channels/:id/members/:agentId/team-role', authAdmin, (req, res) => {
    const member = db.get(`SELECT * FROM channel_members
      WHERE channel_id = ${db.esc(req.params.id)} AND agent_id = ${db.esc(req.params.agentId)}`);
    if (!member) return sendJson(res, 404, { error: 'Member not found in this channel' });

    const { teamRole } = req.body;
    db.exec(`UPDATE channel_members SET team_role = ${db.esc(teamRole || null)}
      WHERE channel_id = ${db.esc(req.params.id)} AND agent_id = ${db.esc(req.params.agentId)}`);

    sendJson(res, 200, { channelId: req.params.id, agentId: req.params.agentId, teamRole: teamRole || null });
  });

  /** GET /api/v1/admin/channels/:id/policy - 获取频道策略 */
  addRoute('GET', '/api/v1/admin/channels/:id/policy', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const currentPolicy = policy.getPolicy(req.params.id);
    sendJson(res, 200, currentPolicy || { channelId: req.params.id, message: 'No policy set (using defaults)' });
  });

  /** PUT /api/v1/admin/channels/:id/policy - 设置/更新频道策略 */
  addRoute('PUT', '/api/v1/admin/channels/:id/policy', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const updatedBy = `admin:${req.admin.username}`;
    const result = policy.upsertPolicy(req.params.id, req.body || {}, updatedBy);

    policy.logAudit({
      channelId: req.params.id,
      action: 'policy.changed',
      actorId: updatedBy,
      actorName: `[Admin] ${req.admin.username}`,
      details: req.body,
    });

    ws.broadcastChannel(req.params.id, {
      type: 'channel.policy_changed',
      payload: { channelId: req.params.id, policy: result },
      timestamp: new Date().toISOString(),
      channelId: req.params.id,
    });

    sendJson(res, 200, result);
  });

  /** DELETE /api/v1/admin/channels/:id/policy - 重置频道策略为默认 */
  addRoute('DELETE', '/api/v1/admin/channels/:id/policy', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    policy.deletePolicy(req.params.id);

    const updatedBy = `admin:${req.admin.username}`;
    policy.logAudit({
      channelId: req.params.id,
      action: 'policy.reset',
      actorId: updatedBy,
      actorName: `[Admin] ${req.admin.username}`,
    });

    ws.broadcastChannel(req.params.id, {
      type: 'channel.policy_changed',
      payload: { channelId: req.params.id, policy: null },
      timestamp: new Date().toISOString(),
      channelId: req.params.id,
    });

    sendJson(res, 200, { message: 'Policy reset to defaults' });
  });

  /** GET /api/v1/admin/channels/:id/audit-log - 获取频道审计日志 */
  addRoute('GET', '/api/v1/admin/channels/:id/audit-log', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const limit = Math.min(Number.parseInt(req.query.limit || '50', 10) || 50, 100);
    const offset = Number.parseInt(req.query.offset || '0', 10) || 0;
    const action = req.query.action || null;

    const logs = policy.getAuditLog(req.params.id, { limit, offset, action });
    sendJson(res, 200, logs);
  });

  /** POST /api/v1/admin/channels/:id/auto-assemble - 按频道所需能力自动推荐 Agent */
  addRoute('POST', '/api/v1/admin/channels/:id/auto-assemble', authAdmin, (req, res) => {
    const channel = db.get(`SELECT id FROM channels WHERE id = ${db.esc(req.params.id)}`);
    if (!channel) return sendJson(res, 404, { error: 'Channel not found' });

    const { capabilities, minProficiency } = req.body || {};
    const recommendations = policy.autoAssemble(req.params.id, { capabilities, minProficiency });
    sendJson(res, 200, recommendations);
  });
}
