import crypto from 'crypto';

/**
 * Base64URL 编码。
 * @param {object|string} data
 * @returns {string}
 */
function b64url(data) {
  return Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Base64URL 解码。
 * @param {string} str
 * @returns {object}
 */
function b64urlDecode(str) {
  let normalized = str.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  return JSON.parse(Buffer.from(normalized, 'base64').toString('utf-8'));
}

/**
 * 创建安全相关工具集。
 * @param {object} config
 * @returns {object}
 */
export function createSecurity(config) {
  /**
   * 使用 scrypt 对密码进行哈希。
   * @param {string} password
   * @returns {string}
   */
  function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
  }

  /**
   * 验证密码是否匹配。
   * @param {string} password
   * @param {string} stored
   * @returns {boolean}
   */
  function verifyPassword(password, stored) {
    const [salt, hash] = String(stored || '').split(':');
    if (!salt || !hash) return false;
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    return derived === hash;
  }

  /**
   * 签发 JWT Token。
   * @param {object} payload
   * @param {number} expiresInSec
   * @returns {string}
   */
  function signJwt(payload, expiresInSec = 86400) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const body = { ...payload, iat: now, exp: now + expiresInSec };
    const content = `${b64url(header)}.${b64url(body)}`;
    const sig = crypto.createHmac('sha256', config.JWT_SECRET).update(content).digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    return `${content}.${sig}`;
  }

  /**
   * 验证并解析 JWT Token。
   * @param {string} token
   * @returns {object|null}
   */
  function verifyJwt(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const content = `${parts[0]}.${parts[1]}`;
      const sig = crypto.createHmac('sha256', config.JWT_SECRET).update(content).digest('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

      if (sig !== parts[2]) return null;

      const payload = b64urlDecode(parts[1]);
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

      return payload;
    } catch {
      return null;
    }
  }

  return { hashPassword, verifyPassword, signJwt, verifyJwt };
}
