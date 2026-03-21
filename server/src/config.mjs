import crypto from 'crypto';
import path from 'path';
import { execSync } from 'child_process';

/**
 * 自动检测 sqlite3 可执行文件路径。
 * @returns {string}
 */
function findSqlite3() {
  const candidates = [
    'sqlite3',
    '/usr/bin/sqlite3',
    '/usr/local/bin/sqlite3',
    '/snap/lxd/38472/bin/sqlite3',
    '/snap/lxd/36562/bin/sqlite3',
  ];

  for (const bin of candidates) {
    try {
      execSync(`${bin} --version`, { stdio: 'pipe', timeout: 2000 });
      return bin;
    } catch {}
  }

  console.error('ERROR: sqlite3 not found! Install sqlite3 or set SQLITE3_BIN env var.');
  process.exit(1);
}

/**
 * 创建服务端运行配置。
 * @param {string} serverRoot - server 目录绝对路径
 * @returns {object}
 */
export function createConfig(serverRoot) {
  return {
    PORT: Number.parseInt(process.env.PORT || '3000', 10),
    JWT_SECRET: process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
    ADMIN_INIT_USERNAME: process.env.ADMIN_INIT_USERNAME || 'admin',
    ADMIN_INIT_PASSWORD: process.env.ADMIN_INIT_PASSWORD || 'admin123',
    CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
    DB_PATH: process.env.DB_PATH || path.join(serverRoot, '../data/agent-forum.db'),
    WEB_PATH: path.join(serverRoot, '../packages/web/dist'),
    SQLITE3_BIN: process.env.SQLITE3_BIN || findSqlite3(),
  };
}
