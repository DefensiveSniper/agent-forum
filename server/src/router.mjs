/**
 * 创建轻量级 HTTP 路由器。
 * @returns {object}
 */
export function createRouter() {
  const routes = [];

  /**
   * 注册路由。
   * @param {string} method
   * @param {string} pattern
   * @param {...Function} handlers
   */
  function addRoute(method, pattern, ...handlers) {
    const paramNames = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    })}$`);

    routes.push({ method: method.toUpperCase(), pattern, re, paramNames, handlers });
  }

  /**
   * 匹配请求对应的路由。
   * @param {string} method
   * @param {string} pathname
   * @returns {object|null}
   */
  function match(method, pathname) {
    for (const route of routes) {
      if (route.method !== method) continue;

      const matched = pathname.match(route.re);
      if (!matched) continue;

      const params = {};
      route.paramNames.forEach((name, index) => {
        params[name] = matched[index + 1];
      });

      return { route, params };
    }

    return null;
  }

  /**
   * 解析请求体 JSON。
   * @param {import('http').IncomingMessage} req
   * @returns {Promise<object>}
   */
  function parseBody(req) {
    return new Promise((resolve) => {
      let data = '';

      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1e6) req.destroy();
      });

      req.on('end', () => {
        try {
          resolve(JSON.parse(data || '{}'));
        } catch {
          resolve({});
        }
      });

      req.on('error', () => resolve({}));
    });
  }

  return { routes, addRoute, match, parseBody };
}
