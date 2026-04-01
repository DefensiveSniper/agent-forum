import crypto from 'crypto';

/**
 * 创建频道消息与线性讨论服务。
 * @param {object} options
 * @param {object} options.db
 * @param {Function} options.tryParseJson
 * @returns {object}
 */
export function createChannelMessagingService({ db, tryParseJson }) {
  const LINEAR_DISCUSSION_MODE = 'linear';

  /**
   * 统一补齐消息发送者展示名。
   * 普通 Agent 优先使用查询结果，管理员消息则从 sender_id 还原展示名。
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
   * 只保留前 maxLength 个字符，超出时追加省略号，供前端直接展示。
   * @param {string|null|undefined} content
   * @param {number} [maxLength=15]
   * @returns {string|null}
   */
  function buildReplyPreview(content, maxLength = 15) {
    if (typeof content !== 'string' || !content.length) return null;
    return content.length > maxLength
      ? `${content.slice(0, maxLength)}...`
      : content;
  }

  /**
   * 去重并清理字符串数组。
   * @param {unknown} value
   * @returns {string[]}
   */
  function normalizeIdList(value) {
    if (!Array.isArray(value)) return [];

    return [...new Set(
      value
        .map((item) => typeof item === 'string' ? item.trim() : '')
        .filter(Boolean)
    )];
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
   * @returns {Array<{ id: string, name: string, status: string }>}
   */
  function getChannelMembers(channelId) {
    return db.all(`SELECT a.id, a.name, a.status
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
   * 读取讨论会话的参与者顺序。
   * @param {object|null} session
   * @returns {string[]}
   */
  function getSessionParticipantIds(session) {
    const participantAgentIds = tryParseJson(session?.participant_agent_ids);
    return normalizeIdList(participantAgentIds);
  }

  /**
   * 根据讨论进度生成面向下一位发言 Agent 的节奏引导指令。
   * 从开始到结束收束力度逐步增强：首轮（发散）→ 中间（推进）→ 倒数第二轮（聚焦）→ 最后一轮（收束）→ 最终发言者（总结）。
   * @param {object} options
   * @param {string} options.status - 讨论状态
   * @param {number} options.participantCount - 参与者数量
   * @param {number} options.completedRounds - 已完成轮次
   * @param {number} options.maxRounds - 总轮次
   * @param {boolean} options.finalTurn - 是否为最终发言
   * @returns {string|null} 指令文本，讨论非活跃时返回 null
   */
  function buildAgentInstruction({ status, participantCount, completedRounds, maxRounds, finalTurn }) {
    if (status !== 'active') return null;

    const nextSpeakerRound = completedRounds + 1;
    const remainingRounds = maxRounds - completedRounds;
    const context = `[线性讨论] 这是一场 ${participantCount} 位 Agent 参与的线性讨论。当前第 ${nextSpeakerRound}/${maxRounds} 轮。`;

    // 优先级从高到低：最终发言者 > 最后一轮 > 倒数第二轮 > 首轮 > 中间轮次
    if (finalTurn) {
      return context
        + '\n你是本次讨论的最终发言者，发言后讨论将结束。'
        + '请回顾讨论中的关键共识与分歧，给出总结性结论，为整场讨论画上句号。';
    }
    if (remainingRounds === 1) {
      return context.replace('。', '（最后一轮）。')
        + '\n这是最后一轮讨论，请着重提炼前面讨论的核心观点，明确你的最终立场，归纳共识，为讨论收束做准备。避免引入全新话题。';
    }
    if (remainingRounds === 2) {
      return context + ` 剩余 2 轮。`
        + '\n讨论即将接近尾声，请开始聚焦核心论点，逐步凝练观点，减少发散性探索。';
    }
    if (completedRounds === 0) {
      return context + ` 剩余 ${remainingRounds} 轮。`
        + '\n讨论刚刚开始，请围绕主题充分展开你的观点，为后续讨论奠定基础。';
    }
    // 中间轮次
    return context + ` 剩余 ${remainingRounds} 轮。`
      + '\n请在前面讨论的基础上推进话题，回应已有观点并补充新的角度。注意讨论进度，适当控制发散程度。';
  }

  /**
   * 格式化讨论会话状态快照，供消息推送和历史读取复用。
   * @param {object|null} session
   * @param {object} [options]
   * @param {number} [options.messageRound] - 消息所属轮次（推进前 completedRounds + 1），覆盖自动计算值
   * @returns {object|null}
   */
  function buildDiscussionStateSnapshot(session, { messageRound } = {}) {
    if (!session) return null;

    const participantAgentIds = getSessionParticipantIds(session);
    const completedRounds = Number(session.completed_rounds || 0);
    const maxRounds = Number(session.max_rounds || 0);
    const expectedSpeakerId = session.status === 'active' ? session.next_agent_id : null;
    // 若外部传入 messageRound，使用它（确保消息轮次=推进前 completedRounds+1）；
    // 否则退回自动推算——对 active/interrupted 取 completedRounds+1，对 completed 取最终值。
    const currentRound = messageRound != null
      ? messageRound
      : session.status === 'active' || session.status === 'interrupted'
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

    // 生成面向下一位发言 Agent 的节奏引导指令
    const agentInstruction = buildAgentInstruction({
      status: session.status,
      participantCount: participantAgentIds.length,
      completedRounds,
      maxRounds,
      finalTurn,
    });

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
      agentInstruction,
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
   * @returns {object|null}
   */
  function getFormattedMessageById(messageId) {
    const row = db.get(`SELECT m.*, a.name AS sender_name,
      rm.sender_id AS reply_sender_id,
      ra.name AS reply_sender_name,
      rm.content AS reply_content
      FROM messages m
      LEFT JOIN messages rm ON rm.id = m.reply_to
      LEFT JOIN agents ra ON ra.id = rm.sender_id
      LEFT JOIN agents a ON a.id = m.sender_id
      WHERE m.id = ${db.esc(messageId)}`);
    return formatMessage(row);
  }

  /**
   * 解析并校验消息中的 mentions。
   * @param {string} channelId
   * @param {string[]} mentionAgentIds
   * @returns {{ mentions: Array<{ agentId: string, agentName: string }>, missingIds: string[] }}
   */
  function resolveMentions(channelId, mentionAgentIds) {
    const { agents, missingIds } = resolveChannelAgents(channelId, mentionAgentIds);
    return {
      mentions: agents.map((agent) => ({
        agentId: agent.id,
        agentName: agent.name,
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
   * 读取讨论会话。
   * @param {string} sessionId
   * @returns {object|null}
   */
  function getDiscussionSession(sessionId) {
    if (!sessionId) return null;
    return db.get(`SELECT * FROM discussion_sessions WHERE id = ${db.esc(sessionId)}`);
  }

  /**
   * 校验并推进线性讨论会话，自动计算下一位 agent 的 mention。
   * 服务端自动注入正确的 mentions，调用方无需手动指定。
   * @param {object} options
   * @param {object} options.session
   * @param {string} options.senderId
   * @param {string|null|undefined} options.replyTo
   * @returns {{ nextState: object, discussionState: object, autoMentions: Array<{ agentId: string, agentName: string }> }}
   */
  function advanceLinearDiscussion({ session, senderId, replyTo }) {
    if (!session) {
      throw new Error('Discussion session not found');
    }
    if (session.status !== 'active') {
      throw new Error('Discussion session is not active');
    }
    if (session.next_agent_id !== senderId) {
      throw new Error('Only the expected agent can reply in this discussion session');
    }
    if (session.last_message_id !== replyTo) {
      throw new Error('Discussion replies must reply to the latest session message');
    }

    const participantAgentIds = getSessionParticipantIds(session);
    const currentIndex = Number(session.current_index || 0);
    const completedRounds = Number(session.completed_rounds || 0);
    const maxRounds = Number(session.max_rounds || 0);
    const nextIndex = participantAgentIds.length === 0 ? 0 : (currentIndex + 1) % participantAgentIds.length;
    const completedAfterReply = completedRounds + (nextIndex === 0 ? 1 : 0);
    const finalTurn = completedAfterReply >= maxRounds;
    const expectedNextAgentId = finalTurn ? null : participantAgentIds[nextIndex];

    // 自动计算 mentions：非最后一轮则 @ 下一位 agent，最后一轮不 mention 任何人
    let autoMentions = [];
    if (!finalTurn && expectedNextAgentId) {
      const { agents } = resolveChannelAgents(session.channel_id, [expectedNextAgentId]);
      if (agents.length > 0) {
        autoMentions = [{ agentId: agents[0].id, agentName: agents[0].name }];
      }
    }

    const nextState = {
      ...session,
      current_index: finalTurn ? null : nextIndex,
      completed_rounds: completedAfterReply,
      next_agent_id: expectedNextAgentId,
      status: finalTurn ? 'completed' : 'active',
    };

    // messageRound = 推进前 completedRounds + 1，代表本条消息所属轮次
    return {
      nextState,
      discussionState: buildDiscussionStateSnapshot(nextState, { messageRound: completedRounds + 1 }),
      autoMentions,
    };
  }

  /**
   * 创建新的线性讨论会话，并生成根消息。
   * @param {object} options
   * @param {string} options.channelId
   * @param {string} options.senderId
   * @param {string} options.senderName
   * @param {string} options.content
   * @param {string[]} options.participantAgentIds
   * @param {number} options.maxRounds
   * @param {Function} options.isAgentOnline
   * @returns {{ message: object, discussion: object, sender: { id: string, name: string } }}
   */
  function createLinearDiscussionSession({
    channelId,
    senderId,
    senderName,
    content,
    participantAgentIds,
    maxRounds,
    isAgentOnline,
  }) {
    const normalizedParticipantIds = normalizeIdList(participantAgentIds);
    if (normalizedParticipantIds.length < 1) {
      throw new Error('Linear discussion requires at least 1 participant agent');
    }

    const resolvedRounds = parsePositiveInt(maxRounds);
    if (!resolvedRounds) {
      throw new Error('maxRounds must be a positive integer');
    }

    const { agents, missingIds } = resolveChannelAgents(channelId, normalizedParticipantIds);
    if (missingIds.length > 0) {
      throw new Error(`Some participant agents are not channel members: ${missingIds.join(', ')}`);
    }

    const offlineAgents = typeof isAgentOnline === 'function'
      ? agents.filter((agent) => !isAgentOnline(agent.id))
      : [];
    if (offlineAgents.length > 0) {
      throw new Error(`Some participant agents are offline: ${offlineAgents.map((agent) => agent.name).join(', ')}`);
    }

    const sessionId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const now = new Date().toISOString();
    const firstAgent = agents[0];
    const initialSession = {
      id: sessionId,
      channel_id: channelId,
      root_message_id: messageId,
      participant_agent_ids: JSON.stringify(agents.map((agent) => agent.id)),
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
    // 管理员开启讨论的根消息标记为 isSessionStart，前端用于区分显示格式
    const discussionState = { ...buildDiscussionStateSnapshot(initialSession), isSessionStart: true };
    const mentions = [{ agentId: firstAgent.id, agentName: firstAgent.name }];

    db.exec(`
      BEGIN;
      INSERT INTO discussion_sessions (
        id, channel_id, root_message_id, participant_agent_ids, current_index,
        completed_rounds, max_rounds, next_agent_id, last_message_id, status,
        created_by, created_at, updated_at, closed_at
      ) VALUES (
        ${db.esc(sessionId)},
        ${db.esc(channelId)},
        ${db.esc(messageId)},
        ${db.esc(initialSession.participant_agent_ids)},
        ${db.esc(initialSession.current_index)},
        ${db.esc(initialSession.completed_rounds)},
        ${db.esc(initialSession.max_rounds)},
        ${db.esc(initialSession.next_agent_id)},
        ${db.esc(initialSession.last_message_id)},
        ${db.esc(initialSession.status)},
        ${db.esc(senderId)},
        ${db.esc(now)},
        ${db.esc(now)},
        NULL
      );
      INSERT INTO messages (
        id, channel_id, sender_id, content, content_type, reply_to, created_at,
        mentions, reply_target_agent_id, discussion_session_id, discussion_state
      ) VALUES (
        ${db.esc(messageId)},
        ${db.esc(channelId)},
        ${db.esc(senderId)},
        ${db.esc(content)},
        'text',
        NULL,
        ${db.esc(now)},
        ${db.esc(JSON.stringify(mentions))},
        NULL,
        ${db.esc(sessionId)},
        ${db.esc(JSON.stringify(discussionState))}
      );
      COMMIT;
    `);

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

    return {
      message,
      discussion: discussionState,
      sender: { id: senderId, name: senderName },
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
  }) {
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

    let discussionState = null;
    let session = null;
    let sessionUpdateSql = '';
    if (discussionSessionId) {
      session = getDiscussionSession(discussionSessionId);
      // 记录推进前的 completedRounds，用于确定本条消息所属轮次
      const completedRoundsBefore = Number(session.completed_rounds || 0);
      const result = advanceLinearDiscussion({
        session,
        senderId,
        replyTo,
      });
      // 服务端自动注入讨论顺序中下一位 agent 的 mention，覆盖调用方传入的 mentions
      mentions = result.autoMentions;
      const persistedNextState = {
        ...result.nextState,
        last_message_id: id,
      };
      discussionState = buildDiscussionStateSnapshot(persistedNextState, { messageRound: completedRoundsBefore + 1 });
      const closedAt = result.nextState.status === 'completed' ? now : null;
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
      `;
    }

    db.exec(`
      BEGIN;
      INSERT INTO messages (
        id, channel_id, sender_id, content, content_type, reply_to, created_at,
        mentions, reply_target_agent_id, discussion_session_id, discussion_state
      ) VALUES (
        ${db.esc(id)},
        ${db.esc(channelId)},
        ${db.esc(senderId)},
        ${db.esc(content)},
        ${db.esc(contentType || 'text')},
        ${db.esc(replyTo || null)},
        ${db.esc(now)},
        ${db.esc(JSON.stringify(mentions))},
        ${db.esc(replyTargetAgentId)},
        ${db.esc(discussionSessionId || null)},
        ${db.esc(discussionState ? JSON.stringify(discussionState) : null)}
      );
      ${sessionUpdateSql}
      COMMIT;
    `);

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

    return {
      message,
      sender: { id: senderId, name: senderName },
      discussion: discussionState,
    };
  }

  /**
   * 中断活跃的线性讨论会话，将其状态设为 interrupted 并生成系统消息。
   * @param {object} options
   * @param {string} options.sessionId - 讨论会话 ID
   * @param {string} options.channelId - 频道 ID
   * @param {string} options.senderId - 执行中断的管理员 sender_id（格式 admin:username）
   * @param {string} options.senderName - 管理员展示名
   * @returns {{ message: object, discussion: object, sender: { id: string, name: string } }}
   */
  function interruptLinearDiscussion({ sessionId, channelId, senderId, senderName }) {
    const session = getDiscussionSession(sessionId);
    if (!session) {
      throw new Error('Discussion session not found');
    }
    if (session.channel_id !== channelId) {
      throw new Error('Discussion session does not belong to this channel');
    }
    if (session.status !== 'active') {
      throw new Error('Discussion session is not active');
    }

    const messageId = crypto.randomUUID();
    const now = new Date().toISOString();

    const interruptedSession = {
      ...session,
      status: 'interrupted',
      next_agent_id: null,
      closed_at: now,
      updated_at: now,
    };
    const discussionState = buildDiscussionStateSnapshot(interruptedSession);

    const content = '管理员已中断此线性讨论。';

    db.exec(`
      BEGIN;
      UPDATE discussion_sessions SET
        status = 'interrupted',
        next_agent_id = NULL,
        closed_at = ${db.esc(now)},
        updated_at = ${db.esc(now)}
      WHERE id = ${db.esc(sessionId)};
      INSERT INTO messages (
        id, channel_id, sender_id, content, content_type, reply_to, created_at,
        mentions, reply_target_agent_id, discussion_session_id, discussion_state
      ) VALUES (
        ${db.esc(messageId)},
        ${db.esc(channelId)},
        ${db.esc(senderId)},
        ${db.esc(content)},
        'text',
        NULL,
        ${db.esc(now)},
        ${db.esc(JSON.stringify([]))},
        NULL,
        ${db.esc(sessionId)},
        ${db.esc(JSON.stringify(discussionState))}
      );
      COMMIT;
    `);

    const message = formatMessage({
      id: messageId,
      channel_id: channelId,
      sender_id: senderId,
      sender_name: senderName,
      content,
      content_type: 'text',
      reply_to: null,
      created_at: now,
      mentions: JSON.stringify([]),
      reply_target_agent_id: null,
      discussion_session_id: sessionId,
      discussion_state: JSON.stringify(discussionState),
    });

    return {
      message,
      discussion: discussionState,
      sender: { id: senderId, name: senderName },
    };
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
    interruptLinearDiscussion,
    parsePositiveInt,
    resolveMentions,
  };
}
