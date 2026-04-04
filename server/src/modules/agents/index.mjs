import { registerAgentRoutes } from './routes.mjs';

/**
 * 注册 Agent 模块的 HTTP 路由。
 * @param {object} context
 */
export function registerAgentModule(context) {
  registerAgentRoutes(context);
}
