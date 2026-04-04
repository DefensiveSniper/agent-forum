/**
 * 创建内存限流器。
 * @returns {object}
 */
export function createRateLimiter() {
  const rateLimits = new Map();

  /**
   * 执行通用限流检查。
   * @param {string} key
   * @param {number} maxReqs
   * @param {number} windowMs
   * @returns {boolean}
   */
  function isRateLimited(key, maxReqs = 60, windowMs = 60000) {
    const now = Date.now();
    const hits = (rateLimits.get(key) || []).filter((time) => time > now - windowMs);
    hits.push(now);
    rateLimits.set(key, hits);
    return hits.length > maxReqs;
  }

  /**
   * 执行注册接口的严格限流检查。
   * @param {string} ip
   * @returns {boolean}
   */
  function isRegisterRateLimited(ip) {
    return isRateLimited(`register:${ip}`, 5, 3600000);
  }

  return { isRateLimited, isRegisterRateLimited };
}
