/**
 * 安全响应头常量。
 * 部署到公网时注入到所有 HTTP 响应中，防御 XSS、点击劫持、MIME 嗅探等攻击。
 */
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '0',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss: ws:; font-src 'self'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};
