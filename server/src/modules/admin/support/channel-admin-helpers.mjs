/**
 * 归一化管理员提交的邀请 Agent 列表。
 * 同时兼容单个 `agentId` 和批量 `agentIds` 两种写法。
 * @param {object} [body]
 * @returns {string[]}
 */
export function resolveInviteAgentIds(body = {}) {
  const rawIds = [];

  if (typeof body.agentId === 'string') rawIds.push(body.agentId);
  if (Array.isArray(body.agentIds)) rawIds.push(...body.agentIds);

  return [...new Set(
    rawIds
      .map((agentId) => typeof agentId === 'string' ? agentId.trim() : '')
      .filter(Boolean)
  )];
}

/**
 * 校验并解析频道人数上限。
 * @param {unknown} maxMembers
 * @returns {number|null}
 */
export function resolveMaxMembers(maxMembers) {
  if (maxMembers === undefined || maxMembers === null || maxMembers === '') return 100;

  const parsed = Number.parseInt(String(maxMembers), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * 按输入顺序读取已注册 Agent，并返回缺失 ID 列表。
 * @param {object} db
 * @param {string[]} agentIds
 * @returns {{ agents: Array<{ id: string, name: string, status: string }>, missingIds: string[] }}
 */
export function resolveRegisteredAgents(db, agentIds) {
  if (agentIds.length === 0) {
    return { agents: [], missingIds: [] };
  }

  const sql = `SELECT id, name, status FROM agents WHERE id IN (${agentIds.map((agentId) => db.esc(agentId)).join(', ')})`;
  const rows = db.all(sql);
  const rowMap = new Map(rows.map((row) => [row.id, row]));
  const agents = agentIds.map((agentId) => rowMap.get(agentId)).filter(Boolean);
  const missingIds = agentIds.filter((agentId) => !rowMap.has(agentId));

  return { agents, missingIds };
}

/**
 * 将 Agent 加入频道，并广播成员加入事件。
 * @param {object} options
 * @param {object} options.db
 * @param {object} options.ws
 * @param {string} options.channelId
 * @param {Array<{ id: string, name: string }>} options.agents
 * @param {string} options.invitedBy
 * @returns {Array<{ id: string, name: string }>}
 */
export function addAgentsToChannel({ db, ws, channelId, agents, invitedBy }) {
  if (agents.length === 0) return [];

  const now = new Date().toISOString();
  for (const agent of agents) {
    db.exec(`INSERT INTO channel_members (channel_id, agent_id, role, joined_at)
      VALUES (${db.esc(channelId)}, ${db.esc(agent.id)}, 'member', ${db.esc(now)})`);

    ws.broadcastChannel(channelId, {
      type: 'member.joined',
      payload: { channelId, agentId: agent.id, agentName: agent.name, invitedBy },
      timestamp: now,
      channelId,
    });
  }

  return agents.map((agent) => ({ id: agent.id, name: agent.name }));
}

/**
 * 彻底删除频道及其关联数据。
 * @param {object} db
 * @param {string} channelId
 */
export function deleteChannelCascade(db, channelId) {
  db.exec(`
    DELETE FROM messages WHERE channel_id = ${db.esc(channelId)};
    DELETE FROM channel_members WHERE channel_id = ${db.esc(channelId)};
    DELETE FROM subscriptions WHERE channel_id = ${db.esc(channelId)};
    DELETE FROM discussion_sessions WHERE channel_id = ${db.esc(channelId)};
    DELETE FROM channels WHERE id = ${db.esc(channelId)};
  `);
}
