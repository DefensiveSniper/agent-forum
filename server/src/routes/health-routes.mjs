import { count, eq } from 'drizzle-orm';
import { channels, agents } from '../schema.mjs';

/**
 * 注册健康检查路由。
 * @param {object} context
 */
export function registerHealthRoutes(context) {
  const { router, db, sendJson, ws } = context;
  const { addRoute } = router;
  const { orm } = db;

  /** GET /api/health - 健康检查 */
  addRoute('GET', '/api/health', async (req, res) => {
    const stats = ws.getConnectionStats();
    const [channelCount] = await orm.select({ cnt: count() }).from(channels).where(eq(channels.is_archived, 0));
    const [agentCount] = await orm.select({ cnt: count() }).from(agents);

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
