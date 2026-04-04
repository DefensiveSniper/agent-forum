import { parseCookies } from '../../../shared/http/cookies.mjs';
import { buildClearDeviceCookie, buildDeviceCookie, issueDeviceToken } from '../support/auth-device.mjs';

/**
 * 注册管理员认证相关路由。
 * @param {object} context
 */
export function registerAdminAuthRoutes(context) {
  const { config, router, db, sendJson, security, captcha, rateLimiter } = context;
  const { addRoute } = router;

  /** GET /api/v1/admin/captcha - 获取图形验证码 */
  addRoute('GET', '/api/v1/admin/captcha', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (rateLimiter.isRateLimited(`captcha:${ip}`, 20, 60000)) {
      return sendJson(res, 429, { error: 'Too many captcha requests' });
    }
    sendJson(res, 200, captcha.generateCaptcha());
  });

  /** POST /api/v1/admin/login - 管理员登录（含验证码校验和失败锁定） */
  addRoute('POST', '/api/v1/admin/login', (req, res) => {
    const { username, password, captchaId, captchaText } = req.body;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    if (!username || !password) {
      return sendJson(res, 400, { error: 'username and password required' });
    }
    if (!captchaId || !captchaText) {
      return sendJson(res, 400, { error: 'captchaId and captchaText required' });
    }

    const lockStatus = captcha.isLocked(ip, username);
    if (lockStatus.locked) {
      return sendJson(res, 423, {
        error: '登录尝试次数过多，账户已暂时锁定',
        lockedUntil: lockStatus.lockedUntil,
        remainingSeconds: lockStatus.remainingSeconds,
      });
    }

    const captchaResult = captcha.verifyCaptcha(captchaId, captchaText);
    if (!captchaResult.valid) {
      return sendJson(res, 400, { error: captchaResult.reason });
    }

    const admin = db.get(`SELECT * FROM admin_users WHERE username = ${db.esc(username)}`);
    if (!admin || !security.verifyPassword(password, admin.password_hash)) {
      captcha.recordFailure(ip, username);
      const newLockStatus = captcha.isLocked(ip, username);
      return sendJson(res, 401, {
        error: 'Invalid credentials',
        ...(newLockStatus.locked ? {
          locked: true,
          lockedUntil: newLockStatus.lockedUntil,
          remainingSeconds: newLockStatus.remainingSeconds,
        } : {}),
      });
    }

    captcha.clearFailure(ip, username);
    const token = security.signJwt({ id: admin.id, username: admin.username, role: admin.role });
    const deviceToken = issueDeviceToken({
      config,
      db,
      security,
      adminId: admin.id,
      userAgent: req.headers['user-agent'],
      ip,
    });

    console.log(`🔑 Admin login: ${username}`);
    sendJson(res, 200, {
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        role: admin.role,
        createdAt: admin.created_at,
      },
    }, {
      'Set-Cookie': buildDeviceCookie(config, deviceToken, config.DEVICE_TRUST_MAX_AGE),
    });
  });

  /** POST /api/v1/admin/refresh - 通过设备信任 Cookie 刷新 JWT（7天免登录） */
  addRoute('POST', '/api/v1/admin/refresh', (req, res) => {
    const cookies = parseCookies(req);
    const deviceToken = cookies.device_trust;

    if (!deviceToken) {
      return sendJson(res, 401, { error: 'No device trust token' });
    }

    const hash = security.hashDeviceToken(deviceToken);
    const device = db.get(`SELECT * FROM admin_devices WHERE device_token_hash = ${db.esc(hash)}`);

    if (!device) {
      return sendJson(res, 401, { error: 'Invalid device token' }, {
        'Set-Cookie': buildClearDeviceCookie(config),
      });
    }

    if (new Date(device.expires_at) <= new Date()) {
      db.exec(`DELETE FROM admin_devices WHERE id = ${db.esc(device.id)}`);
      return sendJson(res, 401, { error: 'Device token expired' }, {
        'Set-Cookie': buildClearDeviceCookie(config),
      });
    }

    const admin = db.get(`SELECT * FROM admin_users WHERE id = ${db.esc(device.admin_id)}`);
    if (!admin) {
      db.exec(`DELETE FROM admin_devices WHERE id = ${db.esc(device.id)}`);
      return sendJson(res, 401, { error: 'Admin not found' }, {
        'Set-Cookie': buildClearDeviceCookie(config),
      });
    }

    db.exec(`UPDATE admin_devices SET last_used_at = ${db.esc(new Date().toISOString())} WHERE id = ${db.esc(device.id)}`);

    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
    const extraHeaders = {};
    if (new Date(device.expires_at).getTime() - Date.now() < twoDaysMs) {
      const newExpiresAt = new Date(Date.now() + config.DEVICE_TRUST_MAX_AGE * 1000).toISOString();
      db.exec(`UPDATE admin_devices SET expires_at = ${db.esc(newExpiresAt)} WHERE id = ${db.esc(device.id)}`);
      extraHeaders['Set-Cookie'] = buildDeviceCookie(config, deviceToken, config.DEVICE_TRUST_MAX_AGE);
    }

    const token = security.signJwt({ id: admin.id, username: admin.username, role: admin.role });
    console.log(`🔄 Admin token refreshed via device trust: ${admin.username}`);
    sendJson(res, 200, {
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        role: admin.role,
        createdAt: admin.created_at,
      },
    }, extraHeaders);
  });

  /** POST /api/v1/admin/logout - 管理员登出（清除设备信任） */
  addRoute('POST', '/api/v1/admin/logout', (req, res) => {
    const cookies = parseCookies(req);
    const deviceToken = cookies.device_trust;

    if (deviceToken) {
      const hash = security.hashDeviceToken(deviceToken);
      db.exec(`DELETE FROM admin_devices WHERE device_token_hash = ${db.esc(hash)}`);
    }

    sendJson(res, 200, { message: 'Logged out' }, {
      'Set-Cookie': buildClearDeviceCookie(config),
    });
  });
}
