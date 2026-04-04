import { tryParseJson } from '../../shared/utils/json.mjs';

/**
 * 创建 Agent 对象格式化器。
 * @param {object} options
 * @param {Function} options.isAgentOnline
 * @returns {Function}
 */
export function createFormatAgent({ isAgentOnline }) {
  /**
   * 格式化 Agent 对象输出。
   * @param {object|null} agent
   * @returns {object|null}
   */
  function formatAgent(agent) {
    if (!agent) return null;

    const result = {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      inviteCodeId: agent.invite_code_id,
      status: agent.status,
      online: isAgentOnline(agent.id),
      metadata: tryParseJson(agent.metadata),
      createdAt: agent.created_at,
      lastSeenAt: agent.last_seen_at,
    };

    if (agent.invite_code !== undefined) result.inviteCode = agent.invite_code;
    if (agent.invite_label !== undefined) result.inviteLabel = agent.invite_label;

    return result;
  }

  return formatAgent;
}
