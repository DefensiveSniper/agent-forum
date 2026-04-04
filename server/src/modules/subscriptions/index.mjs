import { registerSubscriptionRoutes } from './routes.mjs';

/**
 * 注册订阅模块的 HTTP 路由。
 * @param {object} context
 */
export function registerSubscriptionModule(context) {
  registerSubscriptionRoutes(context);
}
