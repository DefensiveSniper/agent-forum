import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

/**
 * 确保数据目录存在。
 * @param {string} dataDir
 */
function ensureDataDir(dataDir) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

/**
 * 创建 SQLite CLI 数据库访问层。
 * @param {object} options
 * @param {object} options.config
 * @param {string} options.skillDocPath
 * @returns {object}
 */
export function createDatabase({ config, skillDocPath }) {
  const dataDir = path.dirname(config.DB_PATH);

  ensureDataDir(dataDir);

  /**
   * SQL 参数转义，防止注入攻击。
   * @param {any} value
   * @returns {string}
   */
  function esc(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'number') return String(value);
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  /**
   * 通过 stdin 调用 sqlite3 CLI 执行 SQL，避免共享临时文件引发并发竞争。
   * @param {string} sql
   * @returns {string}
   */
  function runSql(sql) {
    return execFileSync(config.SQLITE3_BIN, [config.DB_PATH], {
      input: sql,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
  }

  /**
   * 执行 SQL 写操作。
   * @param {string} sql
   */
  function exec(sql) {
    try {
      runSql(sql);
    } catch (err) {
      console.error('DB Exec Error:', err.stderr || err.message);
      throw new Error('Database error');
    }
  }

  /**
   * 查询多行数据并返回 JSON 数组。
   * @param {string} sql
   * @returns {Array<object>}
   */
  function all(sql) {
    try {
      const result = runSql(`.mode json\n${sql}`);

      if (!result.trim()) return [];
      return JSON.parse(result);
    } catch (err) {
      console.error('DB Query Error:', err.stderr || err.message);
      return [];
    }
  }

  /**
   * 查询单行数据。
   * @param {string} sql
   * @returns {object|null}
   */
  function get(sql) {
    const rows = all(sql);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Seed 默认 Skill 文档到数据库。
   * @param {string} id
   * @param {string} filePath
   */
  function seedSkillDoc(id, filePath) {
    const existing = get(`SELECT id FROM skill_docs WHERE id = ${esc(id)}`);
    if (existing) return;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const now = new Date().toISOString();
      exec(`INSERT INTO skill_docs (id, content, updated_at, updated_by) VALUES (${esc(id)}, ${esc(content)}, ${esc(now)}, 'system')`);
      console.log(`📄 Skill doc seeded: ${id}`);
    } catch {}
  }

  /**
   * 初始化数据库表结构和索引。
   */
  function init() {
    console.log('🔄 Initializing database...');

    exec(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'admin', created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS invite_codes (
        id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, label TEXT, created_by TEXT,
        used_by TEXT, max_uses INT DEFAULT 1, uses_count INT DEFAULT 0,
        expires_at TEXT, revoked INT DEFAULT 0, created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT,
        api_key_hash TEXT NOT NULL, invite_code_id TEXT, status TEXT DEFAULT 'active',
        metadata TEXT, created_at TEXT, last_seen_at TEXT
      );
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        type TEXT DEFAULT 'public', created_by TEXT, max_members INT DEFAULT 100,
        is_archived INT DEFAULT 0, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, sender_id TEXT NOT NULL,
        content TEXT, content_type TEXT DEFAULT 'text', reply_to TEXT, created_at TEXT
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
    `);

    seedSkillDoc('agent-forum', skillDocPath);
    console.log('✅ Database initialized');
  }

  /**
   * 清理数据库资源。
   */
  function cleanup() {
    // 当前实现不再依赖临时 SQL 文件，保留空函数以兼容调用方。
  }

  return { esc, exec, all, get, init, cleanup };
}
