import crypto from 'crypto';
import { eq, and, getTableColumns } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { agents, channelMembers, messages, discussionSessions } from './schema.mjs';

/**
 * 创建频道消息与线性讨论服务。
 * @param {object} options
 * @param {object} options.db
 * @param {Function} options.tryParseJson
 * @returns {object}
 */
export function createChannelMessagingService({ db, tryParseJson }) {
  const { orm } = db;
  const LINEAR_DISCUSSION_MODE = 'linear';

  const rm = alias(messages, 'rm');
  const ra = alias(agents, 'ra');

  /**
   * 统一补齐消息发送者展示名。
   * @param {string|null|undefined} senderId
   * @param {string|null|undefined} senderName
   * @returns {string|null}
   */
  function resolveDisplaySenderName(senderId, senderName) {
    if (senderName) return senderName;
    if (typeof senderId === 'string' && senderId.startsWith('admin:')) {
      return `[Admin] ${senderId.slice('admin:'.length)}`;
    }
    return null;
  }

  /**
   * 生成回复消息的固定预览文案。
   * @param {string|null|undefined} content
   * @param {number} [maxLength=15]
   * @returns {string|null}
   */
  function buildReplyPreview(content, maxLength = 15) {
    if (typeof content !== 'string' || !content.length) return null;
    return content.length > maxLength ? `${content.slice(0, maxLength)}...` : content;
  }

  /**
   * 去重并清理字符串数组。
   * @param {unknown} value
   * @returns {string[]}
   */
  function normalizeIdList(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean))];
  }

  /**
   * 解析整数输入并校验正整数约束。
   * @param {unknown} value
   * @returns {number|null}
   */
  function parsePositiveInt(value) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    return parsed;
  }

  /**
   * 读取频道内全部成员。
   * @param {string} channelId
   * @returns {Promise<Array<{ id: string, name: string, status: string }>>}
   */
  async function getChannelMembers(channelId) {
    return orm.select({ id: agents.id, name: agents.name, status: agents.status })
      .from(channelMembers)
      .innerJoin(agents, eq(agents.id, channelMembers.agent_id))
      .where(eq(channelMembers.channel_id, channelId))
      .orderBy(channelMembers.joined_at, agents.created_at);
  }

  /**
   * 将 Agent ID 解析为频道内成员，并保留输入顺序。
   * @param {string} channelId
   * @param {string[]} agentIds
   * @returns {Promise<{ agents: Array<object>, missingIds: string[] }>}
   */
  async function resolveChannelAgents(channelId, agentIds) {
    const uniqueIds = normalizeIdList(agentIds);
    if (uniqueIds.length === 0) return { agents: [], missingIds: [] };

    const members = await getChannelMembers(channelId);
    const memberMap = new Map(members.map((member) => [member.id, member]));
    return {
      agents: uniqueIds.map((id) => memberMap.get(id)).filter(Boolean),
      missingIds: uniqueIds.filter((id) => !memberMap.has(id)),
    };
  }

  /**
   * 读取讨论会话的参与者顺序。
   * @param {object|null} session
   * @returns {string[]}
   */
  function getSessionParticipantIds(session) {
    const participantAgentIds = tryParseJson(session?.participant_agent_ids);
    return normalizeIdList(participantAgentIds);
  }

  /**
   * 格式化讨论会话状态快照。
   * @param {object|null} session
   * @returns {object|null}
   */
  function buildDiscussionStateSnapshot(session) {
    if (!session) return null;

    const participantAgentIds = getSessionParticipantIds(session);
    const completedRounds = Number(session.completed_rounds || 0);
    const maxRounds = Number(session.max_rounds || 0);
    const expectedSpeakerId = session.status === 'active' ? session.next_agent_id : null;
    const currentRound = session.status === 'active'
      ? Math.min(completedRounds + 1, maxRounds || completedRounds + 1)
      : Math.max(completedRounds, maxRounds, 0);

    let nextSpeakerId = null;
    let finalTurn = session.status !== 'active';

    if (session.status === 'active' && participantAgentIds.length > 0 && expectedSpeakerId) {
      const expectedIndex = Number(session.current_index || 0);
      const followingIndex = (expectedIndex + 1) % participantAgentIds.length;
      const completedAfterReply = completedRounds + (followingIndex === 0 ? 1 : 0);
      finalTurn = completedAfterReply >= maxRounds;
      nextSpeakerId = finalTurn ? null : participantAgentIds[followingIndex];
    }

    return {
      id: session.id,
      mode: LINEAR_DISCUSSION_MODE,
      participantAgentIds,
      participantCount: participantAgentIds.length,
      completedRounds,
      currentRound,
      maxRounds,
      status: session.status,
      expectedSpeakerId,
      nextSpeakerId,
      finalTurn,
      rootMessageId: session.root_message_id,
      lastMessageId: session.last_message_id,
    };
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

    return {
      ...rest,
      sender_name: resolveDisplaySenderName(message.sender_id, message.sender_name),
      mentions: Array.isArray(mentions) ? mentions : [],
      reply_target_agent_id: message.reply_target_agent_id || null,
      reply_sender_name: resolveDisplaySenderName(replySenderId, replySenderName),
      reply_preview: buildReplyPreview(replyContent),
      discussion_session_id: message.discussion_session_id || null,
      discussion: tryParseJson(message.discussion_state) || null,
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
   * @returns {Promise<object|null>}
   */
  async function getFormattedMessageById(messageId) {
    const [row] = await orm.select({
      ...getTableColumns(messages),
      sender_name: agents.name,
      reply_sender_id: rm.sender_id,
      reply_sender_name: ra.name,
      reply_content: rm.content,
    }).from(messages)
      .leftJoin(agents, eq(agents.id, messages.sender_id))
      .leftJoin(rm, eq(rm.id, messages.reply_to))
      .leftJoin(ra, eq(ra.id, rm.sender_id))
      .where(eq(messages.id, messageId));
    return formatMessage(row);
  }

  /**
   * 解析并校验消息中的 mentions。
   * @param {string} channelId
   * @param {string[]} mentionAgentIds
   * @returns {Promise<{ mentions: Array<object>, missingIds: string[] }>}
   */
  async function resolveMentions(channelId, mentionAgentIds) {
    const { agents: resolvedAgents, missingIds } = await resolveChannelAgents(channelId, mentionAgentIds);
    return {
      mentions: resolvedAgents.map((agent) => ({ agentId: agent.id, agentName: agent.name })),
      missingIds,
    };
  }

  /**
   * 读取并验证被回复消息，返回其发送者 ID。
   * @param {string} channelId
   * @param {string|null|undefined} replyTo
   * @returns {Promise<{ message: object|null, replyTargetAgentId: string|null }>}
   */
  async function resolveReplyTarget(channelId, replyTo) {
    if (!replyTo) return { message: null, replyTargetAgentId: null };

    const [replyMessage] = await orm.select({
      id: messages.id,
      sender_id: messages.sender_id,
      content: messages.content,
      sender_name: agents.name,
    }).from(messages)
      .leftJoin(agents, eq(agents.id, messages.sender_id))
      .where(and(eq(messages.id, replyTo), eq(messages.channel_id, channelId)));

    return {
      message: replyMessage || null,
      replyTargetAgentId: replyMessage?.sender_id || null,
    };
  }

  /**
   * 读取讨论会话。
   * @param {string} sessionId
   * @returns {Promise<object|undefined>}
   */
  async function getDiscussionSession(sessionId) {
    if (!sessionId) return undefined;
    const [session] = await orm.select().from(discussionSessions).where(eq(discussionSessions.id, sessionId));
    return session;
  }

  /**
   * 校验并推进线性讨论会话。
   * @param {object} options
   * @returns {Promise<{ nextState: object, discussionState: object, autoMentions: Array<object> }>}
   */
  async function advanceLinearDiscussion({ session, senderId, replyTo }) {
    if (!session) throw new Error('Discussion session not found');
    if (session.status !== 'active') throw new Error('Discussion session is not active');
    if (session.next_agent_id !== senderId) throw new Error('Only the expected agent can reply in this discussion session');
    if (session.last_message_id !== replyTo) throw new Error('Discussion replies must reply to the latest session message');

    const participantAgentIds = getSessionParticipantIds(session);
    const currentIndex = Number(session.current_index || 0);
    const completedRounds = Number(session.completed_rounds || 0);
    const maxRounds = Number(session.max_rounds || 0);
    const nextIndex = participantAgentIds.length === 0 ? 0 : (currentIndex + 1) % participantAgentIds.length;
    const completedAfterReply = completedRounds + (nextIndex === 0 ? 1 : 0);
    const finalTurn = completedAfterReply >= maxRounds;
    const expectedNextAgentId = finalTurn ? null : participantAgentIds[nextIndex];

    let autoMentions = [];
    if (!finalTurn && expectedNextAgentId) {
      const { agents: resolvedAgents } = await resolveChannelAgents(session.channel_id, [expectedNextAgentId]);
      if (resolvedAgents.length > 0) {
        autoMentions = [{ agentId: resolvedAgents[0].id, agentName: resolvedAgents[0].name }];
      }
    }

    const nextState = {
      ...session,
      current_index: finalTurn ? null : nextIndex,
      completed_rounds: completedAfterReply,
      next_agent_id: expectedNextAgentId,
      status: finalTurn ? 'completed' : 'active',
    };

    return { nextState, discussionState: buildDiscussionStateSnapshot(nextState), autoMentions };
  }

  /**
   * 创建新的线性讨论会话，并生成根消息。
   * @param {object} options
   * @returns {Promise<{ message: object, discussion: object, sender: { id: string, name: string } }>}
   */
  async function createLinearDiscussionSession({
    channelId, senderId, senderName, content, participantAgentIds, maxRounds, isAgentOnline,
  }) {
    const normalizedParticipantIds = normalizeIdList(participantAgentIds);
    if (normalizedParticipantIds.length < 1) throw new Error('Linear discussion requires at least 1 participant agent');

    const resolvedRounds = parsePositiveInt(maxRounds);
    if (!resolvedRounds) throw new Error('maxRounds must be a positive integer');

    const { agents: resolvedAgents, missingIds } = await resolveChannelAgents(channelId, normalizedParticipantIds);
    if (missingIds.length > 0) throw new Error(`Some participant agents are not channel members: ${missingIds.join(', ')}`);

    const offlineAgents = typeof isAgentOnline === 'function'
      ? resolvedAgents.filter((agent) => !isAgentOnline(agent.id))
      : [];
    if (offlineAgents.length > 0) throw new Error(`Some participant agents are offline: ${offlineAgents.map((a) => a.name).join(', ')}`);

    const sessionId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const now = new Date().toISOString();
    const firstAgent = resolvedAgents[0];
    const initialSession = {
      id: sessionId,
      channel_id: channelId,
      root_message_id: messageId,
      participant_agent_ids: JSON.stringify(resolvedAgents.map((a) => a.id)),
      current_index: 0,
      completed_rounds: 0,
      max_rounds: resolvedRounds,
      next_agent_id: firstAgent.id,
      last_message_id: messageId,
      status: 'active',
      created_by: senderId,
      created_at: now,
      updated_at: now,
      closed_at: null,
    };
    const discussionState = buildDiscussionStateSnapshot(initialSession);
    const mentions = [{ agentId: firstAgent.id, agentName: firstAgent.name }];

    await orm.transaction(async (tx) => {
      await tx.insert(discussionSessions).values(initialSession);
      await tx.insert(messages).values({
        id: messageId,
        channel_id: channelId,
        sender_id: senderId,
        content,
        content_type: 'text',
        reply_to: null,
        created_at: now,
        mentions: JSON.stringify(mentions),
        reply_target_agent_id: null,
        discussion_session_id: sessionId,
        discussion_state: JSON.stringify(discussionState),
      });
    });

    const message = formatMessage({
      id: messageId,
      channel_id: channelId,
      sender_id: senderId,
      sender_name: senderName,
      content,
      content_type: 'text',
      reply_to: null,
      created_at: now,
      mentions: JSON.stringify(mentions),
      reply_target_agent_id: null,
      discussion_session_id: sessionId,
      discussion_state: JSON.stringify(discussionState),
    });

    return { message, discussion: discussionState, sender: { id: senderId, name: senderName } };
  }

  /**
   * 创建普通频道消息，必要时推进线性讨论会话。
   * @param {object} options
   * @returns {Promise<{ message: object, sender: { id: string, name: string }, discussion: object|null }>}
   */
  async function createChannelMessage({
    channelId, senderId, senderName, content,
    contentType = 'text', replyTo = null, mentionAgentIds = [], discussionSessionId = null,
  }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    let { mentions, missingIds } = await resolveMentions(channelId, mentionAgentIds);
    if (missingIds.length > 0) throw new Error(`Some mention agents are not channel members: ${missingIds.join(', ')}`);

    const { message: replyMessage, replyTargetAgentId } = await resolveReplyTarget(channelId, replyTo);
    if (replyTo && !replyMessage) throw new Error('replyTo message not found in this channel');

    let discussionState = null;
    let session = null;
    if (discussionSessionId) {
      session = await getDiscussionSession(discussionSessionId);
      const result = await advanceLinearDiscussion({ session, senderId, replyTo });
      mentions = result.autoMentions;

      const persistedNextState = { ...result.nextState, last_message_id: id };
      discussionState = buildDiscussionStateSnapshot(persistedNextState);
      const closedAt = result.nextState.status === 'completed' ? now : null;

      await orm.transaction(async (tx) => {
        await tx.insert(messages).values({
          id,
          channel_id: channelId,
          sender_id: senderId,
          content,
          content_type: contentType || 'text',
          reply_to: replyTo || null,
          created_at: now,
          mentions: JSON.stringify(mentions),
          reply_target_agent_id: replyTargetAgentId,
          discussion_session_id: discussionSessionId,
          discussion_state: discussionState ? JSON.stringify(discussionState) : null,
        });

        await tx.update(discussionSessions).set({
          current_index: result.nextState.current_index,
          completed_rounds: result.nextState.completed_rounds,
          next_agent_id: result.nextState.next_agent_id || null,
          last_message_id: id,
          status: result.nextState.status,
          updated_at: now,
          closed_at: closedAt,
        }).where(eq(discussionSessions.id, discussionSessionId));
      });
    } else {
      await orm.insert(messages).values({
        id,
        channel_id: channelId,
        sender_id: senderId,
        content,
        content_type: contentType || 'text',
        reply_to: replyTo || null,
        created_at: now,
        mentions: JSON.stringify(mentions),
        reply_target_agent_id: replyTargetAgentId,
        discussion_session_id: null,
        discussion_state: null,
      });
    }

    const message = formatMessage({
      id,
      channel_id: channelId,
      sender_id: senderId,
      sender_name: senderName,
      content,
      content_type: contentType || 'text',
      reply_to: replyTo || null,
      created_at: now,
      mentions: JSON.stringify(mentions),
      reply_target_agent_id: replyTargetAgentId,
      reply_sender_id: replyMessage?.sender_id || null,
      reply_sender_name: replyMessage?.sender_name || null,
      reply_content: replyMessage?.content || null,
      discussion_session_id: discussionSessionId || null,
      discussion_state: discussionState ? JSON.stringify(discussionState) : null,
    });

    return { message, sender: { id: senderId, name: senderName }, discussion: discussionState };
  }

  return {
    buildDiscussionStateSnapshot,
    createChannelMessage,
    createLinearDiscussionSession,
    formatMessage,
    formatMessages,
    getChannelMembers,
    getDiscussionSession,
    getFormattedMessageById,
    parsePositiveInt,
    resolveMentions,
  };
}
