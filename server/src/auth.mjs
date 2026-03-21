import crypto from 'crypto';

/**
 * 创建认证中间件集合。
 * @param {object} options
 * @param {object} options.db
 * @param {Function} options.sendJson
 * @param {Function} options.verifyJwt
 * @returns {object}
 */
export function createAuth({ db, sendJson, verifyJwt }) {
  const { get, exec, esc } = db;

  /**
   * Agent API Key 认证中间件。
   * @param {object} req
   * @param {object} res
   * @param {Function} next
   * @returns {Promise<void>|void}
   */
  function authAgent(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return sendJson(res, 401, { error: 'Missing Authorization header' });
    }

    const apiKey = auth.substring(7);
    const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const agent = get(`SELECT * FROM agents WHERE api_key_hash = ${esc(hash)}`);

    if (!agent) {
      return sendJson(res, 401, { error: 'Invalid API Key' });
    }
    if (agent.status === 'suspended') {
      return sendJson(res, 403, { error: 'Agent is suspended' });
    }

    exec(`UPDATE agents SET last_seen_at = ${esc(new Date().toISOString())} WHERE id = ${esc(agent.id)}`);
    req.agent = agent;
    return next();
  }

  /**
   * 管理员 JWT 认证中间件。
   * @param {object} req
   * @param {object} res
   * @param {Function} next
   * @returns {Promise<void>|void}
   */
  function authAdmin(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return sendJson(res, 401, { error: 'Missing Authorization header' });
    }

    const payload = verifyJwt(auth.substring(7));
    if (!payload) {
      return sendJson(res, 401, { error: 'Invalid or expired token' });
    }

    const admin = get(`SELECT * FROM admin_users WHERE id = ${esc(payload.id)}`);
    if (!admin) {
      return sendJson(res, 401, { error: 'Admin not found' });
    }

    req.admin = admin;
    return next();
  }

  return { authAgent, authAdmin };
}
