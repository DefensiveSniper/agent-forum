import crypto from 'crypto';

/** 排除易混淆字符的字符池。 */
const CHAR_POOL = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/** 深色系随机颜色候选。 */
const DARK_COLORS = [
  '#c0392b', '#2980b9', '#8e44ad', '#27ae60', '#d35400',
  '#2c3e50', '#16a085', '#e74c3c', '#3498db', '#9b59b6',
];

/**
 * 生成指定范围内的随机整数。
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 从颜色候选中随机选取一个。
 * @returns {string}
 */
function randColor() {
  return DARK_COLORS[randInt(0, DARK_COLORS.length - 1)];
}

/**
 * 生成随机浅色（用于干扰线和噪点）。
 * @returns {string}
 */
function randLightColor() {
  const r = randInt(160, 230);
  const g = randInt(160, 230);
  const b = randInt(160, 230);
  return `rgb(${r},${g},${b})`;
}

/**
 * 生成 SVG 图形验证码。
 * @param {string} text - 验证码文本
 * @returns {string} SVG 字符串
 */
function renderSvg(text) {
  const width = 150;
  const height = 50;
  const chars = text.split('');

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;

  // 背景
  svg += `<rect width="${width}" height="${height}" fill="#f5f5f5"/>`;

  // 干扰线（6-8条）
  const lineCount = randInt(6, 8);
  for (let i = 0; i < lineCount; i++) {
    svg += `<line x1="${randInt(0, width)}" y1="${randInt(0, height)}" x2="${randInt(0, width)}" y2="${randInt(0, height)}" stroke="${randLightColor()}" stroke-width="${randInt(1, 2)}"/>`;
  }

  // 噪点圆（20-30个）
  const dotCount = randInt(20, 30);
  for (let i = 0; i < dotCount; i++) {
    svg += `<circle cx="${randInt(0, width)}" cy="${randInt(0, height)}" r="${randInt(1, 3)}" fill="${randLightColor()}"/>`;
  }

  // 字符
  const charWidth = width / (chars.length + 1);
  for (let i = 0; i < chars.length; i++) {
    const x = charWidth * (i + 0.5) + randInt(-5, 5);
    const y = height / 2 + randInt(-5, 8);
    const rotate = randInt(-18, 18);
    const fontSize = randInt(22, 30);
    const color = randColor();
    svg += `<text x="${x}" y="${y}" font-size="${fontSize}" font-family="monospace, sans-serif" font-weight="bold" fill="${color}" transform="rotate(${rotate},${x},${y})">${chars[i]}</text>`;
  }

  // 额外弯曲干扰线（2条贝塞尔曲线）
  for (let i = 0; i < 2; i++) {
    svg += `<path d="M${randInt(0, 20)},${randInt(10, 40)} Q${randInt(40, 110)},${randInt(-10, 60)} ${randInt(130, 150)},${randInt(10, 40)}" stroke="${randColor()}" stroke-width="1.5" fill="none" opacity="0.4"/>`;
  }

  svg += '</svg>';
  return svg;
}

/**
 * 创建验证码服务。
 * 包含 SVG 生成、验证、失败计数和锁定机制。
 * @returns {object}
 */
export function createCaptchaService() {
  /** @type {Map<string, { text: string, expiresAt: number }>} */
  const captchaStore = new Map();

  /** @type {Map<string, { count: number, lockedUntil: number }>} */
  const failureStore = new Map();

  const CAPTCHA_TTL_MS = 5 * 60 * 1000;
  const LOCK_DURATION_MS = 15 * 60 * 1000;
  const MAX_FAILURES = 3;

  /**
   * 生成随机验证码文本。
   * @param {number} length
   * @returns {string}
   */
  function randomText(length = 4) {
    let text = '';
    for (let i = 0; i < length; i++) {
      text += CHAR_POOL[randInt(0, CHAR_POOL.length - 1)];
    }
    return text;
  }

  /**
   * 生成验证码并缓存。
   * @returns {{ captchaId: string, svg: string, expiresAt: string }}
   */
  function generateCaptcha() {
    const id = crypto.randomUUID();
    const text = randomText(4);
    const expiresAt = Date.now() + CAPTCHA_TTL_MS;

    captchaStore.set(id, { text, expiresAt });

    return {
      captchaId: id,
      svg: renderSvg(text),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * 验证验证码输入（不区分大小写，一次性使用）。
   * @param {string} id
   * @param {string} input
   * @returns {{ valid: boolean, reason?: string }}
   */
  function verifyCaptcha(id, input) {
    const entry = captchaStore.get(id);
    if (!entry) {
      return { valid: false, reason: '验证码不存在或已过期' };
    }

    // 无论验证结果如何，都删除（一次性）
    captchaStore.delete(id);

    if (Date.now() > entry.expiresAt) {
      return { valid: false, reason: '验证码已过期' };
    }

    if (entry.text.toLowerCase() !== String(input || '').toLowerCase()) {
      return { valid: false, reason: '验证码错误' };
    }

    return { valid: true };
  }

  /**
   * 记录登录失败次数。
   * @param {string} ip
   * @param {string} username
   */
  function recordFailure(ip, username) {
    const key = `${ip}:${username}`;
    const entry = failureStore.get(key);
    const now = Date.now();

    if (!entry || now > entry.lockedUntil) {
      failureStore.set(key, { count: 1, lockedUntil: 0 });
      return;
    }

    const newCount = entry.count + 1;
    if (newCount >= MAX_FAILURES) {
      failureStore.set(key, { count: newCount, lockedUntil: now + LOCK_DURATION_MS });
    } else {
      failureStore.set(key, { count: newCount, lockedUntil: entry.lockedUntil });
    }
  }

  /**
   * 检查是否处于锁定状态。
   * @param {string} ip
   * @param {string} username
   * @returns {{ locked: boolean, lockedUntil?: string, remainingSeconds?: number }}
   */
  function isLocked(ip, username) {
    const key = `${ip}:${username}`;
    const entry = failureStore.get(key);
    if (!entry || !entry.lockedUntil) return { locked: false };

    const now = Date.now();
    if (now >= entry.lockedUntil) {
      failureStore.delete(key);
      return { locked: false };
    }

    return {
      locked: true,
      lockedUntil: new Date(entry.lockedUntil).toISOString(),
      remainingSeconds: Math.ceil((entry.lockedUntil - now) / 1000),
    };
  }

  /**
   * 清除指定用户的失败记录（登录成功时调用）。
   * @param {string} ip
   * @param {string} username
   */
  function clearFailure(ip, username) {
    failureStore.delete(`${ip}:${username}`);
  }

  /**
   * 清理过期的验证码和失败记录。
   */
  function cleanupExpired() {
    const now = Date.now();
    for (const [id, entry] of captchaStore) {
      if (now > entry.expiresAt) captchaStore.delete(id);
    }
    for (const [key, entry] of failureStore) {
      if (entry.lockedUntil && now > entry.lockedUntil) failureStore.delete(key);
    }
  }

  // 每 5 分钟自动清理
  const cleanupTimer = setInterval(cleanupExpired, 5 * 60 * 1000);
  cleanupTimer.unref();

  /**
   * 停止定期清理（优雅关闭时调用）。
   */
  function stopCleanup() {
    clearInterval(cleanupTimer);
  }

  return {
    generateCaptcha,
    verifyCaptcha,
    recordFailure,
    isLocked,
    clearFailure,
    cleanupExpired,
    stopCleanup,
  };
}
