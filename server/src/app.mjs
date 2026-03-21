import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import { createConfig } from './config.mjs';
import { createDatabase } from './database.mjs';
import { createSecurity } from './security.mjs';
import { createRateLimiter } from './rate-limiter.mjs';
import { createRouter } from './router.mjs';
import { MIME_TYPES, createFormatAgent, createSendJson, tryParseJson } from './http-utils.mjs';
import { createAuth } from './auth.mjs';
import { createWebSocketService } from './ws-service.mjs';
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
 * 处理 CORS 预检请求。
 * @param {object} req
 * @param {object} res
 * @param {object} config
 * @returns {boolean}
 */
function handlePreflight(req, res, config) {
  if (req.method !== 'OPTIONS') return false;

  res.writeHead(204, {
    'Access-Control-Allow-Origin': config.CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  });
  res.end();
  return true;
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
  const ws = createWebSocketService({
    db,
    verifyJwt: security.verifyJwt,
    isRateLimited: rateLimiter.isRateLimited,
    tryParseJson,
  });
  const formatAgent = createFormatAgent({ isAgentOnline: ws.isAgentOnline });
  const auth = createAuth({
    db,
    sendJson,
    verifyJwt: security.verifyJwt,
  });

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
    tryParseJson,
    skillsRoot: path.join(serverRoot, '../skills'),
  });

  const server = http.createServer(async (req, res) => {
    if (handlePreflight(req, res, config)) return;

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    const query = Object.fromEntries(parsedUrl.searchParams);

    const ip = req.socket.remoteAddress || 'unknown';
    if (pathname.startsWith('/api/') && rateLimiter.isRateLimited(ip)) {
      return sendJson(res, 429, { error: 'Rate limit exceeded' });
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
    ws.stopHeartbeat();
    server.close();
    db.cleanup();
    process.exit(0);
  }

  db.init();
  seedAdmin({
    config,
    db,
    hashPassword: security.hashPassword,
  });
  ws.startHeartbeat();

  server.listen(config.PORT, () => {
    printStartupBanner(config);
  });

  process.on('SIGINT', shutdown);
  return server;
}
