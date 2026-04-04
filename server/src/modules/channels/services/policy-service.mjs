import crypto from 'crypto';

/**
 * 创建频道策略引擎。
 * 负责策略的加载、缓存、校验和执行。
 * @param {object} options
 * @param {object} options.db
 * @param {Function} options.tryParseJson
 * @param {Function} options.isRateLimited
 * @returns {object}
 */
export function createChannelPolicyEngine({ db, tryParseJson, isRateLimited }) {
  /** 内存策略缓存，策略变更时失效 */
  const policyCache = new Map();
  const DEFAULT_CHANNEL_POLICY = {
    isolation_level: 'standard',
    require_intent: false,
    allowed_task_types: null,
    default_requires_approval: false,
    required_capabilities: null,
    max_concurrent_discussions: 5,
    message_rate_limit: 60,
  };

  /**
   * 加载频道策略（带内存缓存）。
   * @param {string} channelId
   * @returns {object|null} 策略对象，未设置时返回 null
   */
  function getPolicy(channelId) {
    if (policyCache.has(channelId)) return policyCache.get(channelId);
    const row = db.get(`SELECT * FROM channel_policies WHERE channel_id = ${db.esc(channelId)}`);
    if (!row) {
      policyCache.set(channelId, null);
      return null;
    }
    const policy = {
      ...row,
      require_intent: !!row.require_intent,
      default_requires_approval: !!row.default_requires_approval,
      allowed_task_types: tryParseJson(row.allowed_task_types),
      required_capabilities: tryParseJson(row.required_capabilities),
    };
    policyCache.set(channelId, policy);
    return policy;
  }

  /**
   * 获取频道的有效策略快照。
   * 未配置策略时返回默认值，避免调用方自行猜测默认行为。
   * @param {string} channelId
   * @returns {object}
   */
  function getEffectivePolicy(channelId) {
    const policy = getPolicy(channelId);
    return {
      ...DEFAULT_CHANNEL_POLICY,
      ...(policy || {}),
    };
  }

  /**
   * 使指定频道的策略缓存失效。
   * @param {string} channelId
   */
  function invalidateCache(channelId) {
    policyCache.delete(channelId);
  }

  /**
   * 校验消息是否符合频道策略。
   * @param {string} channelId
   * @param {string} senderId
   * @param {object} messageData - { intent }
   * @returns {{ ok: boolean, code?: string, message?: string, policy?: string }}
   */
  function validateMessage(channelId, senderId, messageData) {
    const policy = getPolicy(channelId);
    if (!policy) return { ok: true };

    // 检查 require_intent
    if (policy.require_intent && !messageData.intent) {
      return { ok: false, code: 'POLICY_VIOLATION', message: '此频道要求消息携带意图字段', policy: 'require_intent' };
    }

    // 检查 allowed_task_types
    if (policy.allowed_task_types && Array.isArray(policy.allowed_task_types) && messageData.intent?.task_type) {
      if (!policy.allowed_task_types.includes(messageData.intent.task_type)) {
        return { ok: false, code: 'POLICY_VIOLATION', message: `此频道不允许 task_type: ${messageData.intent.task_type}`, policy: 'allowed_task_types' };
      }
    }

    // 检查 message_rate_limit
    if (policy.message_rate_limit && isRateLimited(`policy:msg:${channelId}:${senderId}`, policy.message_rate_limit, 60000)) {
      return { ok: false, code: 'POLICY_VIOLATION', message: '超出频道消息速率限制', policy: 'message_rate_limit' };
    }

    return { ok: true };
  }

  /**
   * 校验 Agent 是否满足频道能力要求。
   * @param {string} channelId
   * @param {string} agentId
   * @returns {{ ok: boolean, missing?: string[] }}
   */
  function validateMemberCapabilities(channelId, agentId) {
    const policy = getPolicy(channelId);
    if (!policy || !policy.required_capabilities || !Array.isArray(policy.required_capabilities) || policy.required_capabilities.length === 0) {
      return { ok: true };
    }

    const agentCaps = db.all(`SELECT capability FROM agent_capabilities WHERE agent_id = ${db.esc(agentId)}`);
    const capSet = new Set(agentCaps.map((r) => r.capability));
    const missing = policy.required_capabilities.filter((cap) => !capSet.has(cap));

    if (missing.length > 0) {
      return { ok: false, missing };
    }
    return { ok: true };
  }

  /**
   * 检查频道并发讨论数是否超限。
   * @param {string} channelId
   * @returns {{ ok: boolean, current?: number, max?: number }}
   */
  function checkConcurrentDiscussions(channelId) {
    const policy = getPolicy(channelId);
    if (!policy) return { ok: true };

    const max = policy.max_concurrent_discussions || 5;
    const current = db.get(`SELECT COUNT(*) as cnt FROM discussion_sessions
      WHERE channel_id = ${db.esc(channelId)}
        AND status IN ('open', 'in_progress', 'waiting_approval')`);
    const cnt = current?.cnt || 0;

    if (cnt >= max) {
      return { ok: false, current: cnt, max };
    }
    return { ok: true };
  }

  /**
   * 设置或更新频道策略。
   * @param {string} channelId
   * @param {object} policyData
   * @param {string} updatedBy
   * @returns {object} 更新后的策略
   */
  function upsertPolicy(channelId, policyData, updatedBy) {
    const now = new Date().toISOString();
    const existing = db.get(`SELECT id FROM channel_policies WHERE channel_id = ${db.esc(channelId)}`);

    if (existing) {
      const sets = [`updated_at = ${db.esc(now)}`, `updated_by = ${db.esc(updatedBy)}`];
      const allowedFields = [
        'isolation_level', 'require_intent', 'default_requires_approval',
        'auto_discussion_mode', 'max_concurrent_discussions', 'message_rate_limit',
      ];
      for (const field of allowedFields) {
        if (policyData[field] !== undefined) {
          sets.push(`${field} = ${db.esc(policyData[field])}`);
        }
      }
      // JSON 数组字段需要序列化
      if (policyData.allowed_task_types !== undefined) {
        sets.push(`allowed_task_types = ${db.esc(policyData.allowed_task_types ? JSON.stringify(policyData.allowed_task_types) : null)}`);
      }
      if (policyData.required_capabilities !== undefined) {
        sets.push(`required_capabilities = ${db.esc(policyData.required_capabilities ? JSON.stringify(policyData.required_capabilities) : null)}`);
      }

      db.exec(`UPDATE channel_policies SET ${sets.join(', ')} WHERE channel_id = ${db.esc(channelId)}`);
    } else {
      const id = crypto.randomUUID();
      const allowedTaskTypes = policyData.allowed_task_types ? JSON.stringify(policyData.allowed_task_types) : null;
      const requiredCapabilities = policyData.required_capabilities ? JSON.stringify(policyData.required_capabilities) : null;

      db.exec(`INSERT INTO channel_policies (
        id, channel_id, isolation_level, require_intent, allowed_task_types,
        default_requires_approval, auto_discussion_mode, required_capabilities,
        max_concurrent_discussions, message_rate_limit, updated_at, updated_by
      ) VALUES (
        ${db.esc(id)}, ${db.esc(channelId)},
        ${db.esc(policyData.isolation_level || 'standard')},
        ${db.esc(policyData.require_intent ? 1 : 0)},
        ${db.esc(allowedTaskTypes)},
        ${db.esc(policyData.default_requires_approval ? 1 : 0)},
        ${db.esc(policyData.auto_discussion_mode || null)},
        ${db.esc(requiredCapabilities)},
        ${db.esc(policyData.max_concurrent_discussions || 5)},
        ${db.esc(policyData.message_rate_limit || 60)},
        ${db.esc(now)}, ${db.esc(updatedBy)}
      )`);
    }

    invalidateCache(channelId);
    return getPolicy(channelId);
  }

  /**
   * 删除频道策略（重置为默认）。
   * @param {string} channelId
   */
  function deletePolicy(channelId) {
    db.exec(`DELETE FROM channel_policies WHERE channel_id = ${db.esc(channelId)}`);
    invalidateCache(channelId);
  }

  /**
   * 记录频道审计日志。
   * @param {object} options
   * @param {string} options.channelId
   * @param {string} options.action
   * @param {string} options.actorId
   * @param {string} options.actorName
   * @param {object|null} [options.details]
   */
  function logAudit({ channelId, action, actorId, actorName, details = null }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.exec(`INSERT INTO channel_audit_log (id, channel_id, action, actor_id, actor_name, details, created_at)
      VALUES (${db.esc(id)}, ${db.esc(channelId)}, ${db.esc(action)}, ${db.esc(actorId)}, ${db.esc(actorName)}, ${db.esc(details ? JSON.stringify(details) : null)}, ${db.esc(now)})`);
  }

  /**
   * 获取频道审计日志（分页）。
   * @param {string} channelId
   * @param {object} [options]
   * @param {number} [options.limit]
   * @param {number} [options.offset]
   * @param {string|null} [options.action]
   * @returns {Array<object>}
   */
  function getAuditLog(channelId, { limit = 50, offset = 0, action = null } = {}) {
    let sql = `SELECT * FROM channel_audit_log WHERE channel_id = ${db.esc(channelId)}`;
    if (action) sql += ` AND action = ${db.esc(action)}`;
    sql += ` ORDER BY created_at DESC LIMIT ${Math.min(limit, 100)} OFFSET ${offset}`;
    return db.all(sql).map((row) => ({
      ...row,
      details: tryParseJson(row.details),
    }));
  }

  /**
   * 按频道所需能力自动推荐匹配的 Agent。
   * @param {string} channelId
   * @param {object} [options]
   * @param {string[]} [options.capabilities] - 覆盖频道策略中的 required_capabilities
   * @param {string} [options.minProficiency]
   * @returns {Array<object>}
   */
  function autoAssemble(channelId, { capabilities, minProficiency = 'standard' } = {}) {
    const policy = getPolicy(channelId);
    const requiredCaps = capabilities || policy?.required_capabilities || [];
    if (!Array.isArray(requiredCaps) || requiredCaps.length === 0) return [];

    const profLevels = { basic: 1, standard: 2, expert: 3 };
    const minLevel = profLevels[minProficiency] || 2;

    // 查找拥有任一所需能力的 Agent
    const placeholders = requiredCaps.map((c) => db.esc(c)).join(', ');
    const rows = db.all(`SELECT ac.agent_id, ac.capability, ac.proficiency, a.name, a.status
      FROM agent_capabilities ac
      INNER JOIN agents a ON a.id = ac.agent_id
      WHERE ac.capability IN (${placeholders})
        AND a.status = 'active'
      ORDER BY ac.capability, ac.proficiency DESC`);

    // 按 Agent 聚合
    const agentMap = new Map();
    for (const row of rows) {
      const level = profLevels[row.proficiency] || 1;
      if (level < minLevel) continue;
      if (!agentMap.has(row.agent_id)) {
        agentMap.set(row.agent_id, { agentId: row.agent_id, name: row.name, capabilities: [], matchCount: 0 });
      }
      const entry = agentMap.get(row.agent_id);
      entry.capabilities.push({ capability: row.capability, proficiency: row.proficiency });
      entry.matchCount += 1;
    }

    // 排除已在频道中的成员
    const existingMembers = new Set(
      db.all(`SELECT agent_id FROM channel_members WHERE channel_id = ${db.esc(channelId)}`).map((r) => r.agent_id)
    );

    return [...agentMap.values()]
      .filter((a) => !existingMembers.has(a.agentId))
      .sort((a, b) => b.matchCount - a.matchCount);
  }

  return {
    getPolicy,
    getEffectivePolicy,
    invalidateCache,
    validateMessage,
    validateMemberCapabilities,
    checkConcurrentDiscussions,
    upsertPolicy,
    deletePolicy,
    logAudit,
    getAuditLog,
    autoAssemble,
  };
}
