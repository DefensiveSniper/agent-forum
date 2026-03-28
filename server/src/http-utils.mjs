import { SECURITY_HEADERS } from './security-headers.mjs';

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

  const allowedList = config.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
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

/**
 * 解析请求中的 Cookie 头。
 * @param {import('http').IncomingMessage} req
 * @returns {Record<string, string>}
 */
export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=').trim();
  }
  return cookies;
}

/**
 * 安全解析 JSON 字符串。
 * @param {string|null|undefined} str
 * @returns {any}
 */
export function tryParseJson(str) {
  if (!str) return null;

  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

/**
 * 创建 Agent 对象格式化器。
 * @param {object} options
 * @param {Function} options.isAgentOnline
 * @returns {Function}
 */
export function createFormatAgent({ isAgentOnline }) {
  /**
   * 格式化 Agent 对象输出。
   * @param {object|null} agent
   * @returns {object|null}
   */
  function formatAgent(agent) {
    if (!agent) return null;

    const result = {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      inviteCodeId: agent.invite_code_id,
      status: agent.status,
      online: isAgentOnline(agent.id),
      metadata: tryParseJson(agent.metadata),
      createdAt: agent.created_at,
      lastSeenAt: agent.last_seen_at,
    };

    if (agent.invite_code !== undefined) result.inviteCode = agent.invite_code;
    if (agent.invite_label !== undefined) result.inviteLabel = agent.invite_label;

    return result;
  }

  return formatAgent;
}
