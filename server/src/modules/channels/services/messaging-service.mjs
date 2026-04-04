import crypto from 'crypto';
import { validateIntent } from './intent.mjs';
import {
  buildAgentInstruction,
  buildReplyPreview,
  computeDiscussionDivergence,
  normalizeIdList,
  parsePositiveInt,
  resolveDisplaySenderName,
} from './formatting.mjs';
import { createDiscussionService } from './discussion.mjs';

/**
 * 创建频道消息与线性讨论服务。
 * @param {object} options
 * @param {object} options.db
 * @param {Function} options.tryParseJson
 * @returns {object}
 */
export function createChannelMessagingService({ db, tryParseJson }) {
  /**
   * 读取频道内全部成员。
   * @param {string} channelId
   * @returns {Array<{ id: string, name: string, status: string, team_role: string|null }>}
   */
  function getChannelMembers(channelId) {
    return db.all(`SELECT a.id, a.name, a.status, cm.team_role
      FROM channel_members cm
      INNER JOIN agents a ON a.id = cm.agent_id
      WHERE cm.channel_id = ${db.esc(channelId)}
      ORDER BY cm.joined_at ASC, a.created_at ASC`);
  }

  /**
   * 将 Agent ID 解析为频道内成员，并保留输入顺序。
   * @param {string} channelId
   * @param {string[]} agentIds
   * @returns {{ agents: Array<{ id: string, name: string, status: string }>, missingIds: string[] }}
   */
  function resolveChannelAgents(channelId, agentIds) {
    const uniqueIds = normalizeIdList(agentIds);
    if (uniqueIds.length === 0) {
      return { agents: [], missingIds: [] };
    }

    const members = getChannelMembers(channelId);
    const memberMap = new Map(members.map((member) => [member.id, member]));
    const agents = uniqueIds.map((agentId) => memberMap.get(agentId)).filter(Boolean);
    const missingIds = uniqueIds.filter((agentId) => !memberMap.has(agentId));
    return { agents, missingIds };
  }

  /**
   * 从数据库消息记录中解析 mentions 和讨论快照。
   * @param {object|null} message
   * @returns {object|null}
   */
  function formatMessage(message) {
    if (!message) return null;

    const {
      reply_content: replyContent,
      reply_sender_id: replySenderId,
      reply_sender_name: replySenderName,
      ...rest
    } = message;
    const mentions = tryParseJson(message.mentions);
    const isDiscussionMessage = Boolean(message.discussion_session_id);

    return {
      ...rest,
      sender_name: resolveDisplaySenderName(message.sender_id, message.sender_name),
      sender_team_role: message.sender_team_role || null,
      mentions: Array.isArray(mentions) ? mentions : [],
      reply_target_agent_id: isDiscussionMessage ? null : (message.reply_target_agent_id || null),
      reply_sender_name: resolveDisplaySenderName(replySenderId, replySenderName),
      reply_preview: buildReplyPreview(replyContent),
      discussion_session_id: message.discussion_session_id || null,
      discussion: tryParseJson(message.discussion_state) || null,
      intent: tryParseJson(message.intent) || null,
    };
  }

  /**
   * 批量格式化消息记录。
   * @param {Array<object>} rows
   * @returns {Array<object>}
   */
  function formatMessages(rows) {
    return rows.map((row) => formatMessage(row));
  }

  /**
   * 读取单条消息并格式化。
   * @param {string} messageId
   * @returns {object|null}
   */
  function getFormattedMessageById(messageId) {
    const row = db.get(`SELECT m.*, a.name AS sender_name,
      cm_sender.team_role AS sender_team_role,
      rm.sender_id AS reply_sender_id,
      ra.name AS reply_sender_name,
      rm.content AS reply_content
      FROM messages m
      LEFT JOIN messages rm ON rm.id = m.reply_to
      LEFT JOIN agents ra ON ra.id = rm.sender_id
      LEFT JOIN agents a ON a.id = m.sender_id
      LEFT JOIN channel_members cm_sender ON cm_sender.channel_id = m.channel_id AND cm_sender.agent_id = m.sender_id
      WHERE m.id = ${db.esc(messageId)}`);
    return formatMessage(row);
  }

  const discussion = createDiscussionService({
    db,
    tryParseJson,
    normalizeIdList,
    parsePositiveInt,
    computeDiscussionDivergence,
    buildAgentInstruction,
    getChannelMembers,
    resolveChannelAgents,
    validateIntent,
    formatMessage,
  });

  /**
   * 更新消息的 intent 字段（主要用于审批状态更新）。
   * @param {string} messageId
   * @param {object} intentPatch
   * @returns {object|null}
   */
  function updateMessageIntent(messageId, intentPatch) {
    const row = db.get(`SELECT id, intent FROM messages WHERE id = ${db.esc(messageId)}`);
    if (!row) return null;

    const current = tryParseJson(row.intent) || {};
    const merged = { ...current, ...intentPatch };
    db.exec(`UPDATE messages SET intent = ${db.esc(JSON.stringify(merged))} WHERE id = ${db.esc(messageId)}`);

    return getFormattedMessageById(messageId);
  }

  /**
   * 解析并校验消息中的 mentions。
   * @param {string} channelId
   * @param {string[]} mentionAgentIds
   * @returns {{ mentions: Array<{ agentId: string, agentName: string, teamRole: string|null }>, missingIds: string[] }}
   */
  function resolveMentions(channelId, mentionAgentIds) {
    const { agents, missingIds } = resolveChannelAgents(channelId, mentionAgentIds);
    return {
      mentions: agents.map((agent) => ({
        agentId: agent.id,
        agentName: agent.name,
        teamRole: agent.team_role || null,
      })),
      missingIds,
    };
  }

  /**
   * 读取并验证被回复消息，返回其发送者 ID。
   * @param {string} channelId
   * @param {string|null|undefined} replyTo
   * @returns {{ message: object|null, replyTargetAgentId: string|null }}
   */
  function resolveReplyTarget(channelId, replyTo) {
    if (!replyTo) {
      return { message: null, replyTargetAgentId: null };
    }

    const replyMessage = db.get(`SELECT m.id, m.sender_id, m.content, a.name AS sender_name
      FROM messages m
      LEFT JOIN agents a ON a.id = m.sender_id
      WHERE m.id = ${db.esc(replyTo)}
        AND m.channel_id = ${db.esc(channelId)}`);

    return {
      message: replyMessage,
      replyTargetAgentId: replyMessage?.sender_id || null,
    };
  }

  /**
   * 创建普通频道消息，必要时推进线性讨论会话。
   * @param {object} options
   * @param {string} options.channelId
   * @param {string} options.senderId
   * @param {string} options.senderName
   * @param {string} options.content
   * @param {string} [options.contentType]
   * @param {string|null} [options.replyTo]
   * @param {string[]} [options.mentionAgentIds]
   * @param {string|null} [options.discussionSessionId]
   * @param {object|null} [options.intent]
   * @returns {{ message: object, sender: { id: string, name: string }, discussion: object|null }}
   */
  function createChannelMessage({
    channelId,
    senderId,
    senderName,
    content,
    contentType = 'text',
    replyTo = null,
    mentionAgentIds = [],
    discussionSessionId = null,
    intent = null,
  }) {
    const validatedIntent = validateIntent(intent);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    let { mentions, missingIds } = resolveMentions(channelId, mentionAgentIds);
    if (missingIds.length > 0) {
      throw new Error(`Some mention agents are not channel members: ${missingIds.join(', ')}`);
    }

    const { message: replyMessage, replyTargetAgentId } = resolveReplyTarget(channelId, replyTo);
    if (replyTo && !replyMessage) {
      throw new Error('replyTo message not found in this channel');
    }

    const senderMember = db.get(`SELECT team_role FROM channel_members
      WHERE channel_id = ${db.esc(channelId)} AND agent_id = ${db.esc(senderId)}`);
    const senderTeamRole = senderMember?.team_role || null;

    let discussionState = null;
    let sessionUpdateSql = '';
    if (discussionSessionId) {
      const session = discussion.getDiscussionSession(discussionSessionId);
      const completedRoundsBefore = Number(session.completed_rounds || 0);
      const result = discussion.advanceLinearDiscussion({
        session,
        senderId,
        replyTo,
      });

      mentions = result.autoMentions;
      const persistedNextState = {
        ...result.nextState,
        last_message_id: id,
      };
      discussionState = discussion.buildDiscussionStateSnapshot(persistedNextState, { messageRound: completedRoundsBefore + 1 });
      const closedAt = result.nextState.status === 'done' || result.nextState.status === 'cancelled' ? now : null;

      let transitionsSql = '';
      for (const transition of result.transitions || []) {
        const transitionId = crypto.randomUUID();
        transitionsSql += `
          INSERT INTO discussion_transitions (id, session_id, from_status, to_status, triggered_by, triggered_by_name, reason, created_at)
          VALUES (${db.esc(transitionId)}, ${db.esc(discussionSessionId)}, ${db.esc(transition.from)}, ${db.esc(transition.to)}, ${db.esc(senderId)}, ${db.esc(senderName)}, NULL, ${db.esc(now)});
        `;
      }

      sessionUpdateSql = `
        UPDATE discussion_sessions SET
          current_index = ${db.esc(result.nextState.current_index)},
          completed_rounds = ${db.esc(result.nextState.completed_rounds)},
          next_agent_id = ${db.esc(result.nextState.next_agent_id || null)},
          last_message_id = ${db.esc(id)},
          status = ${db.esc(result.nextState.status)},
          updated_at = ${db.esc(now)},
          closed_at = ${db.esc(closedAt)}
        WHERE id = ${db.esc(discussionSessionId)};
        ${transitionsSql}
      `;
    }

    const intentJson = validatedIntent ? JSON.stringify(validatedIntent) : null;
    const persistedReplyTargetAgentId = discussionSessionId ? null : replyTargetAgentId;

    db.exec(`
      BEGIN;
      INSERT INTO messages (
        id, channel_id, sender_id, content, content_type, reply_to, created_at,
        mentions, reply_target_agent_id, discussion_session_id, discussion_state, intent
      ) VALUES (
        ${db.esc(id)},
        ${db.esc(channelId)},
        ${db.esc(senderId)},
        ${db.esc(content)},
        ${db.esc(contentType || 'text')},
        ${db.esc(replyTo || null)},
        ${db.esc(now)},
        ${db.esc(JSON.stringify(mentions))},
        ${db.esc(persistedReplyTargetAgentId)},
        ${db.esc(discussionSessionId || null)},
        ${db.esc(discussionState ? JSON.stringify(discussionState) : null)},
        ${db.esc(intentJson)}
      );
      ${sessionUpdateSql}
      COMMIT;
    `);

    const message = formatMessage({
      id,
      channel_id: channelId,
      sender_id: senderId,
      sender_name: senderName,
      sender_team_role: senderTeamRole,
      content,
      content_type: contentType || 'text',
      reply_to: replyTo || null,
      created_at: now,
      mentions: JSON.stringify(mentions),
      reply_target_agent_id: persistedReplyTargetAgentId,
      reply_sender_id: replyMessage?.sender_id || null,
      reply_sender_name: replyMessage?.sender_name || null,
      reply_content: replyMessage?.content || null,
      discussion_session_id: discussionSessionId || null,
      discussion_state: discussionState ? JSON.stringify(discussionState) : null,
      intent: intentJson,
    });

    return {
      message,
      sender: { id: senderId, name: senderName },
      discussion: discussionState,
    };
  }

  return {
    approveDiscussion: discussion.approveDiscussion,
    buildDiscussionStateSnapshot: discussion.buildDiscussionStateSnapshot,
    closeRejectedDiscussion: discussion.closeRejectedDiscussion,
    createChannelMessage,
    createLinearDiscussionSession: discussion.createLinearDiscussionSession,
    formatMessage,
    formatMessages,
    getChannelMembers,
    getDiscussionSession: discussion.getDiscussionSession,
    getDiscussionTransitions: discussion.getDiscussionTransitions,
    getFormattedMessageById,
    interruptLinearDiscussion: discussion.interruptLinearDiscussion,
    isValidTransition: discussion.isValidTransition,
    parsePositiveInt,
    rejectDiscussion: discussion.rejectDiscussion,
    reopenDiscussion: discussion.reopenDiscussion,
    resolveMentions,
    submitForApproval: discussion.submitForApproval,
    transitionDiscussion: discussion.transitionDiscussion,
    updateMessageIntent,
    validateIntent,
  };
}
