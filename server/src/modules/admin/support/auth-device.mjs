import crypto from 'crypto';

/**
 * 构建设备信任 Cookie 的 Set-Cookie 头值。
 * @param {object} config
 * @param {string} deviceToken
 * @param {number} maxAge
 * @returns {string}
 */
export function buildDeviceCookie(config, deviceToken, maxAge) {
  const parts = [`device_trust=${deviceToken}`, 'HttpOnly', 'SameSite=Strict', 'Path=/api/v1/admin', `Max-Age=${maxAge}`];
  if (config.NODE_ENV !== 'development') parts.push('Secure');
  return parts.join('; ');
}

/**
 * 构建清除设备信任 Cookie 的 Set-Cookie 头值。
 * @param {object} config
 * @returns {string}
 */
export function buildClearDeviceCookie(config) {
  const parts = ['device_trust=', 'HttpOnly', 'SameSite=Strict', 'Path=/api/v1/admin', 'Max-Age=0'];
  if (config.NODE_ENV !== 'development') parts.push('Secure');
  return parts.join('; ');
}

/**
 * 签发设备信任 Token 并写入数据库。
 * @param {object} options
 * @param {object} options.config
 * @param {object} options.db
 * @param {object} options.security
 * @param {string} options.adminId
 * @param {string} options.userAgent
 * @param {string} options.ip
 * @returns {string}
 */
export function issueDeviceToken({ config, db, security, adminId, userAgent, ip }) {
  const deviceToken = crypto.randomBytes(48).toString('hex');
  const hash = security.hashDeviceToken(deviceToken);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + config.DEVICE_TRUST_MAX_AGE * 1000).toISOString();

  db.exec(`INSERT INTO admin_devices (id, admin_id, device_token_hash, user_agent, ip_address, created_at, last_used_at, expires_at)
    VALUES (${db.esc(crypto.randomUUID())}, ${db.esc(adminId)}, ${db.esc(hash)}, ${db.esc(userAgent || null)}, ${db.esc(ip || null)}, ${db.esc(now)}, ${db.esc(now)}, ${db.esc(expiresAt)})`);

  return deviceToken;
}
