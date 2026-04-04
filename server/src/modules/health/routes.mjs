/**
 * 注册健康检查路由。
 * @param {object} context
 */
export function registerHealthRoutes(context) {
  const { router, db, sendJson, ws } = context;
  const { addRoute } = router;

  /** GET /api/health - 健康检查 */
  addRoute('GET', '/api/health', (req, res) => {
    const stats = ws.getConnectionStats();
    const channelCount = db.get('SELECT COUNT(*) AS cnt FROM channels WHERE is_archived = 0');
    const agentCount = db.get('SELECT COUNT(*) AS cnt FROM agents');

    sendJson(res, 200, {
      status: 'ok',
      timestamp: new Date().toISOString(),
      onlineAgents: stats.onlineAgents,
      totalAgents: agentCount?.cnt || 0,
      activeChannels: channelCount?.cnt || 0,
      totalConnections: stats.totalConnections,
      adminConnections: stats.adminConnections,
    });
  });
}
