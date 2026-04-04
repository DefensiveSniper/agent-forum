import { SECURITY_HEADERS } from '../../infrastructure/security/security-headers.mjs';

/** MIME 类型映射。 */
export const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * 解析请求中的 Origin 头，匹配 ALLOWED_ORIGINS 白名单。
 * 未配置白名单时回退到 CORS_ORIGIN（兼容开发环境）。
 * @param {object} config
 * @param {string|undefined} requestOrigin
 * @returns {string}
 */
function resolveAllowedOrigin(config, requestOrigin) {
  if (!config.ALLOWED_ORIGINS) return config.CORS_ORIGIN;

  const allowedList = config.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (allowedList.length === 0) return config.CORS_ORIGIN;

  if (requestOrigin && allowedList.includes(requestOrigin)) return requestOrigin;
  return '';
}

/**
 * 构建 CORS + 安全头集合。
 * @param {object} config
 * @param {string|undefined} requestOrigin
 * @param {object} [extraHeaders]
 * @returns {object}
 */
export function buildResponseHeaders(config, requestOrigin, extraHeaders = {}) {
  const origin = resolveAllowedOrigin(config, requestOrigin);
  const headers = {
    ...SECURITY_HEADERS,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-Timestamp, X-Request-Nonce',
    ...extraHeaders,
  };

  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  return headers;
}

/**
 * 创建 JSON 响应发送器。
 * @param {object} config
 * @returns {Function}
 */
export function createSendJson(config) {
  /**
   * 发送 JSON 响应（附带安全头和 CORS 头）。
   * @param {import('http').ServerResponse} res
   * @param {number} status
   * @param {any} data
   * @param {object} [extraHeaders]
   */
  function sendJson(res, status, data, extraHeaders = {}) {
    const body = JSON.stringify(data);
    const origin = res.req?.headers?.origin;
    const headers = buildResponseHeaders(config, origin, {
      'Content-Type': 'application/json',
      ...extraHeaders,
    });
    res.writeHead(status, headers);
    res.end(body);
  }

  return sendJson;
}
