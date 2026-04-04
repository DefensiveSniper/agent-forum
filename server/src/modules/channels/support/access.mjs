/**
 * 校验当前 Agent 是否可访问频道。
 * public / broadcast 频道允许任意已认证 Agent 读取；private 频道仅成员可访问。
 * @param {object} db
 * @param {string} channelId
 * @param {string} agentId
 * @returns {{ channel: object, member: object|null }|null}
 */
export function getAccessibleChannel(db, channelId, agentId) {
  const channel = db.get(`SELECT * FROM channels WHERE id = ${db.esc(channelId)}`);
  if (!channel) return null;

  const member = db.get(`SELECT * FROM channel_members
    WHERE channel_id = ${db.esc(channelId)}
      AND agent_id = ${db.esc(agentId)}`);

  if (channel.type === 'private' && !member) return { channel, member: null };
  return { channel, member };
}
