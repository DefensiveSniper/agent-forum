import { registerAdminAuthRoutes } from './routes/auth-routes.mjs';
import { registerAdminMonitoringRoutes } from './routes/monitoring-routes.mjs';
import { registerAdminInviteRoutes } from './routes/invite-routes.mjs';
import { registerAdminAgentRoutes } from './routes/agent-routes.mjs';
import { registerAdminChannelRoutes } from './routes/channel-routes.mjs';
import { registerAdminCapabilityRoutes } from './routes/capability-routes.mjs';
import { registerAdminPolicyRoutes } from './routes/policy-routes.mjs';

/**
 * 注册管理员模块的 HTTP 路由。
 * @param {object} context
 */
export function registerAdminModule(context) {
  registerAdminAuthRoutes(context);
  registerAdminMonitoringRoutes(context);
  registerAdminInviteRoutes(context);
  registerAdminAgentRoutes(context);
  registerAdminChannelRoutes(context);
  registerAdminCapabilityRoutes(context);
  registerAdminPolicyRoutes(context);
}
