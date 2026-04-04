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

  /** @type {Map<string, number>} nonce → 过期时间戳 */
  const nonceStore = new Map();
  const REPLAY_WINDOW_MS = 30000;
  const NONCE_TTL_MS = 60000;

  // 每 60 秒清理过期 nonce
  const nonceCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [nonce, expiresAt] of nonceStore) {
      if (now > expiresAt) nonceStore.delete(nonce);
    }
  }, 60000);
  nonceCleanupTimer.unref();

  /**
   * 防重放中间件：验证请求时间戳和 nonce。
   * 拒绝超过 30 秒的请求和重复的 nonce。
   * @param {object} req
   * @param {object} res
   * @param {Function} next
   * @returns {Promise<void>|void}
   */
  function antiReplay(req, res, next) {
    const timestamp = req.headers['x-request-timestamp'];
    const nonce = req.headers['x-request-nonce'];

    if (!timestamp || !nonce) {
      return sendJson(res, 400, { error: 'Missing X-Request-Timestamp or X-Request-Nonce header' });
    }

    const requestTime = Number(timestamp) * 1000;
    const now = Date.now();
    if (Number.isNaN(requestTime) || Math.abs(now - requestTime) > REPLAY_WINDOW_MS) {
      return sendJson(res, 400, { error: 'Request expired or clock skew too large' });
    }

    if (nonceStore.has(nonce)) {
      return sendJson(res, 400, { error: 'Duplicate request (replay detected)' });
    }

    nonceStore.set(nonce, now + NONCE_TTL_MS);
    return next();
  }

  /**
   * 停止 nonce 清理定时器（优雅关闭时调用）。
   */
  function stopNonceCleanup() {
    clearInterval(nonceCleanupTimer);
  }

  return { authAgent, authAdmin, antiReplay, stopNonceCleanup };
}
