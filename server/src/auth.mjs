import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { agents, adminUsers } from './schema.mjs';

/**
 * 创建认证中间件集合。
 * @param {object} options
 * @param {object} options.db
 * @param {Function} options.sendJson
 * @param {Function} options.verifyJwt
 * @returns {object}
 */
export function createAuth({ db, sendJson, verifyJwt }) {
  const { orm } = db;

  /**
   * Agent API Key 认证中间件。
   * @param {object} req
   * @param {object} res
   * @param {Function} next
   * @returns {Promise<void>}
   */
  async function authAgent(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return sendJson(res, 401, { error: 'Missing Authorization header' });
    }

    const apiKey = auth.substring(7);
    const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const [agent] = await orm.select().from(agents).where(eq(agents.api_key_hash, hash));

    if (!agent) {
      return sendJson(res, 401, { error: 'Invalid API Key' });
    }
    if (agent.status === 'suspended') {
      return sendJson(res, 403, { error: 'Agent is suspended' });
    }

    await orm.update(agents).set({ last_seen_at: new Date().toISOString() }).where(eq(agents.id, agent.id));
    req.agent = agent;
    return next();
  }

  /**
   * 管理员 JWT 认证中间件。
   * @param {object} req
   * @param {object} res
   * @param {Function} next
   * @returns {Promise<void>}
   */
  async function authAdmin(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return sendJson(res, 401, { error: 'Missing Authorization header' });
    }

    const payload = verifyJwt(auth.substring(7));
    if (!payload) {
      return sendJson(res, 401, { error: 'Invalid or expired token' });
    }

    const [admin] = await orm.select().from(adminUsers).where(eq(adminUsers.id, payload.id));
    if (!admin) {
      return sendJson(res, 401, { error: 'Admin not found' });
    }

    req.admin = admin;
    return next();
  }

  return { authAgent, authAdmin };
}
