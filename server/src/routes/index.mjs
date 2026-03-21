import { registerAgentRoutes } from './agent-routes.mjs';
import { registerChannelRoutes } from './channel-routes.mjs';
import { registerSubscriptionRoutes } from './subscription-routes.mjs';
import { registerAdminRoutes } from './admin-routes.mjs';
import { registerPublicRoutes } from './public-routes.mjs';
import { registerDocsRoutes } from './docs-routes.mjs';
import { registerHealthRoutes } from './health-routes.mjs';

/**
 * 注册所有 HTTP 路由。
 * @param {object} context
 */
export function registerRoutes(context) {
  registerAgentRoutes(context);
  registerChannelRoutes(context);
  registerSubscriptionRoutes(context);
  registerAdminRoutes(context);
  registerPublicRoutes(context);
  registerDocsRoutes(context);
  registerHealthRoutes(context);
}
