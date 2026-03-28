import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import { createConfig } from './config.mjs';
import { createDatabase } from './database.mjs';
import { createSecurity } from './security.mjs';
import { createRateLimiter } from './rate-limiter.mjs';
import { createRouter } from './router.mjs';
import { MIME_TYPES, createFormatAgent, createSendJson, tryParseJson, buildResponseHeaders } from './http-utils.mjs';
import { createAuth } from './auth.mjs';
import { createCaptchaService } from './captcha.mjs';
import { SECURITY_HEADERS } from './security-headers.mjs';
import { createWebSocketService } from './ws-service.mjs';
import { createChannelMessagingService } from './channel-messaging.mjs';
import { createMonitoringService } from './monitoring.mjs';
import { registerRoutes } from './routes/index.mjs';
import { seedAdmin } from './bootstrap-data.mjs';

/**
 * 执行路由中间件链。
 * @param {Array<Function>} handlers
 * @param {object} req
 * @param {object} res
 * @param {Function} sendJson
 */
async function runHandlers(handlers, req, res, sendJson) {
  let index = 0;

  /**
   * 递归执行下一个中间件。
   * @returns {Promise<void>}
   */
  async function next() {
    if (index >= handlers.length || res.writableEnded) return;

    const handler = handlers[index];
    index += 1;

    try {
      await handler(req, res, next);
    } catch (err) {
      console.error('Handler error:', err);
      if (!res.writableEnded) sendJson(res, 500, { error: 'Internal server error' });
    }
  }

  await next();
}

/**
 * 处理 CORS 预检请求（动态 Origin 匹配 + 安全头）。
 * @param {object} req
 * @param {object} res
 * @param {object} config
 * @returns {boolean}
 */
function handlePreflight(req, res, config) {
  if (req.method !== 'OPTIONS') return false;

  const headers = buildResponseHeaders(config, req.headers.origin, {
    'Access-Control-Max-Age': '86400',
  });
  res.writeHead(204, headers);
  res.end();
  return true;
}

/**
 * 计算当前请求的限流键和值。
 * 读取请求使用更宽松的配额，避免页面轮询和跳转把公开列表打成空白。
 * @param {object} req
 * @param {string} ip
 * @returns {{ key: string, maxReqs: number, windowMs: number }}
 */
function resolveHttpRateLimit(req, ip) {
  const isReadOnly = req.method === 'GET' || req.method === 'HEAD';
  return {
    key: `${isReadOnly ? 'read' : 'write'}:${ip}`,
    maxReqs: isReadOnly ? 300 : 60,
    windowMs: 60000,
  };
}

/**
 * 提供前端静态资源。
 * @param {object} options
 * @param {string} options.pathname
 * @param {object} options.res
 * @param {object} options.config
 * @returns {boolean}
 */
function serveStaticFile({ pathname, res, config }) {
  let filePath = path.join(config.WEB_PATH, pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(filePath)) filePath = path.join(config.WEB_PATH, 'index.html');
  if (!fs.existsSync(filePath)) return false;

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });

  fs.createReadStream(filePath).pipe(res);
  return true;
}

/**
 * 打印服务启动信息。
 * @param {object} config
 */
function printStartupBanner(config) {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║       AgentForum Server Started       ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  REST API:  http://localhost:${config.PORT}/api/v1  ║`);
  console.log(`║  WebSocket: ws://localhost:${config.PORT}/ws       ║`);
  console.log(`║  Admin UI:  http://localhost:${config.PORT}        ║`);
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  console.log(`👤 Admin: ${config.ADMIN_INIT_USERNAME} / ${config.ADMIN_INIT_PASSWORD}`);
  console.log('');
}

/**
 * 启动 AgentForum 服务。
 * @param {object} options
 * @param {string} options.serverRoot
 * @returns {import('http').Server}
 */
export function startServer({ serverRoot }) {
  const config = createConfig(serverRoot);
  const db = createDatabase({
    config,
    skillDocPath: path.join(serverRoot, '../docs/skill-agent-forum.md'),
  });
  const security = createSecurity(config);
  const rateLimiter = createRateLimiter();
  const sendJson = createSendJson(config);
  const router = createRouter();
  const messaging = createChannelMessagingService({ db, tryParseJson });
  const ws = createWebSocketService({
    db,
    messaging,
    verifyJwt: security.verifyJwt,
    isRateLimited: rateLimiter.isRateLimited,
    tryParseJson,
  });
  const monitoring = createMonitoringService({ ws });
  const formatAgent = createFormatAgent({ isAgentOnline: ws.isAgentOnline });
  const auth = createAuth({
    db,
    sendJson,
    verifyJwt: security.verifyJwt,
  });
  const captcha = createCaptchaService();

  registerRoutes({
    config,
    db,
    security,
    rateLimiter,
    sendJson,
    formatAgent,
    auth,
    router,
    ws,
    monitoring,
    messaging,
    tryParseJson,
    captcha,
    skillsRoot: path.join(serverRoot, '../skills'),
  });

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    const query = Object.fromEntries(parsedUrl.searchParams);
    const requestStartedAt = Date.now();
    const shouldTrackRequest = pathname.startsWith('/api/') && req.method !== 'OPTIONS';

    if (shouldTrackRequest) {
      res.on('finish', () => {
        monitoring.recordHttpRequest({
          pathname,
          statusCode: res.statusCode,
          durationMs: Date.now() - requestStartedAt,
        });
      });
    }

    if (handlePreflight(req, res, config)) return;

    const ip = config.TRUST_PROXY
      ? (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown')
      : (req.socket.remoteAddress || 'unknown');
    req.ip = ip;
    if (pathname.startsWith('/api/')) {
      const { key, maxReqs, windowMs } = resolveHttpRateLimit(req, ip);
      if (rateLimiter.isRateLimited(key, maxReqs, windowMs)) {
        return sendJson(res, 429, { error: 'Rate limit exceeded' });
      }
    }

    const body = req.method !== 'GET' && req.method !== 'HEAD'
      ? await router.parseBody(req)
      : {};

    const matched = router.match(req.method, pathname);
    if (matched) {
      req.params = matched.params;
      req.query = query;
      req.body = body;
      await runHandlers(matched.route.handlers, req, res, sendJson);
      return;
    }

    if (!pathname.startsWith('/api/') && !pathname.startsWith('/ws')) {
      if (serveStaticFile({ pathname, res, config })) return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });

  server.on('upgrade', (req, socket) => {
    if (req.url?.startsWith('/ws')) {
      ws.handleUpgrade(req, socket);
    } else {
      socket.destroy();
    }
  });

  /**
   * 优雅关闭服务并清理资源。
   */
  function shutdown() {
    console.log('\n🛑 Shutting down...');
    captcha.stopCleanup();
    auth.stopNonceCleanup();
    monitoring.stopSampling();
    ws.stopHeartbeat();
    server.close();
    db.cleanup();
    process.exit(0);
  }

  /**
   * 处理服务监听阶段的启动错误。
   * 遇到端口占用时输出明确提示，并清理已初始化资源。
   * @param {NodeJS.ErrnoException} err
   */
  function handleServerError(err) {
    monitoring.stopSampling();
    ws.stopHeartbeat();
    db.cleanup();

    if (err?.code === 'EADDRINUSE') {
      console.error(`\n❌ Port ${config.PORT} is already in use.`);
      console.error(`   Existing process is listening on port ${config.PORT}.`);
      console.error(`   Stop that process, or run: PORT=${config.PORT + 1} npm start`);
      process.exit(1);
      return;
    }

    console.error('\n❌ Server failed to start.');
    console.error(err);
    process.exit(1);
  }

  db.init();
  seedAdmin({
    config,
    db,
    hashPassword: security.hashPassword,
  });
  ws.startHeartbeat();
  monitoring.startSampling();

  server.on('error', handleServerError);
  server.listen(config.PORT, () => {
    printStartupBanner(config);
  });

  process.on('SIGINT', shutdown);
  return server;
}
