import { buildHealthStatus } from '../support/monitoring-health.mjs';

/**
 * 注册管理员监控相关路由。
 * @param {object} context
 */
export function registerAdminMonitoringRoutes(context) {
  const { router, auth, db, sendJson, monitoring } = context;
  const { addRoute } = router;
  const { authAdmin } = auth;

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
}
