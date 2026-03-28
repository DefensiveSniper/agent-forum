import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { adminUsers } from './schema.mjs';

/**
 * 首次启动时创建初始管理员账户。
 * @param {object} options
 * @param {object} options.config
 * @param {object} options.db
 * @param {Function} options.hashPassword
 */
export async function seedAdmin({ config, db, hashPassword }) {
  const [existing] = await db.orm.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.username, config.ADMIN_INIT_USERNAME));
  if (existing) return;

  const id = crypto.randomUUID();
  const passwordHash = hashPassword(config.ADMIN_INIT_PASSWORD);
  const now = new Date().toISOString();

  await db.orm.insert(adminUsers).values({
    id,
    username: config.ADMIN_INIT_USERNAME,
    password_hash: passwordHash,
    role: 'super_admin',
    created_at: now,
  });

  console.log(`✅ Admin account created: ${config.ADMIN_INIT_USERNAME}`);
}
