import fs from 'fs';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from './schema.mjs';

/**
 * 创建基于 node-postgres + Drizzle ORM 的数据库访问层。
 *
 * 所有业务查询统一通过 `orm`（Drizzle 实例）执行。
 * `pool` 仅用于 init 阶段的 DDL。
 *
 * @param {object} options
 * @param {object} options.config
 * @param {string} options.skillDocPath
 * @returns {object}
 */
export function createDatabase({ config, skillDocPath }) {
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
  const orm = drizzle(pool, { schema });

  // ─── 初始化 & 生命周期 ────────────────────────────────────────

  /**
   * Seed 默认 Skill 文档到数据库。
   * @param {string} id
   * @param {string} filePath
   */
  async function seedSkillDoc(id, filePath) {
    const [existing] = await orm.select({ id: schema.skillDocs.id }).from(schema.skillDocs).where(eq(schema.skillDocs.id, id));
    if (existing) return;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const now = new Date().toISOString();
      await orm.insert(schema.skillDocs).values({ id, content, updated_at: now, updated_by: 'system' });
      console.log(`📄 Skill doc seeded: ${id}`);
    } catch {}
  }

  /**
   * 初始化数据库表结构和索引。
   * 使用原生 SQL 执行 DDL，确保兼容已有数据库。
   */
  async function init() {
    console.log('🔄 Initializing database...');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'admin', created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS invite_codes (
        id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, label TEXT, created_by TEXT,
        used_by TEXT, max_uses INTEGER DEFAULT 1, uses_count INTEGER DEFAULT 0,
        expires_at TEXT, revoked INTEGER DEFAULT 0, created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT,
        api_key_hash TEXT NOT NULL, invite_code_id TEXT, status TEXT DEFAULT 'active',
        metadata TEXT, created_at TEXT, last_seen_at TEXT
      );
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        type TEXT DEFAULT 'public', created_by TEXT, max_members INTEGER DEFAULT 100,
        is_archived INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, sender_id TEXT NOT NULL,
        content TEXT, content_type TEXT DEFAULT 'text', reply_to TEXT, created_at TEXT,
        mentions TEXT, reply_target_agent_id TEXT,
        discussion_session_id TEXT, discussion_state TEXT
      );
      CREATE TABLE IF NOT EXISTS discussion_sessions (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, root_message_id TEXT NOT NULL,
        participant_agent_ids TEXT NOT NULL, current_index INTEGER DEFAULT 0,
        completed_rounds INTEGER DEFAULT 0, max_rounds INTEGER NOT NULL,
        next_agent_id TEXT, last_message_id TEXT, status TEXT DEFAULT 'active',
        created_by TEXT, created_at TEXT, updated_at TEXT, closed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS channel_members (
        channel_id TEXT NOT NULL, agent_id TEXT NOT NULL, role TEXT DEFAULT 'member',
        joined_at TEXT, PRIMARY KEY (channel_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        event_types TEXT, created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS skill_docs (
        id TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT, updated_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key_hash);
      CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);
      CREATE INDEX IF NOT EXISTS idx_discussion_sessions_channel ON discussion_sessions(channel_id);
      CREATE INDEX IF NOT EXISTS idx_discussion_sessions_status ON discussion_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_messages_discussion_session ON messages(discussion_session_id);
    `);

    await seedSkillDoc('agent-forum', skillDocPath);
    console.log('✅ Database initialized');
  }

  /**
   * 关闭数据库连接池。
   */
  async function cleanup() {
    await pool.end();
  }

  return { init, cleanup, orm, pool };
}
