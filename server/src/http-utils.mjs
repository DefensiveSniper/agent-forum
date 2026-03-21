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
 * 创建 JSON 响应发送器。
 * @param {object} config
 * @returns {Function}
 */
export function createSendJson(config) {
  /**
   * 发送 JSON 响应。
   * @param {import('http').ServerResponse} res
   * @param {number} status
   * @param {any} data
   */
  function sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': config.CORS_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end(body);
  }

  return sendJson;
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
