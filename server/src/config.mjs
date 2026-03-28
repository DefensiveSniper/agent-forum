import crypto from 'crypto';
import path from 'path';

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
    DATABASE_URL: process.env.DATABASE_URL || 'postgresql://agent_forum:agent_forum_dev@localhost:5432/agent_forum',
    WEB_PATH: path.join(serverRoot, '../packages/web/dist'),
  };
}
