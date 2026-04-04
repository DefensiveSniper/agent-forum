import { registerHealthRoutes } from './routes.mjs';

/**
 * 注册健康检查模块的 HTTP 路由。
 * @param {object} context
 */
export function registerHealthModule(context) {
  registerHealthRoutes(context);
}
