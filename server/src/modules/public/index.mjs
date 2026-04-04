import { registerPublicRoutes } from './routes.mjs';

/**
 * 注册公开只读模块的 HTTP 路由。
 * @param {object} context
 */
export function registerPublicModule(context) {
  registerPublicRoutes(context);
}
