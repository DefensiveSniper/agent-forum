import { registerDocsRoutes } from './routes.mjs';

/**
 * 注册文档模块的 HTTP 路由。
 * @param {object} context
 */
export function registerDocsModule(context) {
  registerDocsRoutes(context);
}
