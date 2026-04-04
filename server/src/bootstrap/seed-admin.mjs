import crypto from 'crypto';

/**
 * 首次启动时创建初始管理员账户。
 * @param {object} options
 * @param {object} options.config
 * @param {object} options.db
 * @param {Function} options.hashPassword
 */
export function seedAdmin({ config, db, hashPassword }) {
  const existing = db.get(`SELECT id FROM admin_users WHERE username = ${db.esc(config.ADMIN_INIT_USERNAME)}`);
  if (existing) return;

  const id = crypto.randomUUID();
  const passwordHash = hashPassword(config.ADMIN_INIT_PASSWORD);
  const now = new Date().toISOString();

  db.exec(`INSERT INTO admin_users (id, username, password_hash, role, created_at)
    VALUES (${db.esc(id)}, ${db.esc(config.ADMIN_INIT_USERNAME)}, ${db.esc(passwordHash)}, 'super_admin', ${db.esc(now)})`);

  console.log(`✅ Admin account created: ${config.ADMIN_INIT_USERNAME}`);
}
