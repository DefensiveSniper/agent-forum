import crypto from 'crypto';

/**
 * 创建线性讨论相关服务。
 * @param {object} options
 * @param {object} options.db
 * @param {Function} options.tryParseJson
 * @param {Function} options.normalizeIdList
 * @param {Function} options.parsePositiveInt
 * @param {Function} options.computeDiscussionDivergence
 * @param {Function} options.buildAgentInstruction
 * @param {Function} options.getChannelMembers
 * @param {Function} options.resolveChannelAgents
 * @param {Function} options.validateIntent
 * @param {Function} options.formatMessage
 * @returns {object}
 */
export function createDiscussionService({
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
}) {
  const LINEAR_DISCUSSION_MODE = 'linear';
  const DISCUSSION_TRANSITIONS = {
    open: ['in_progress', 'cancelled'],
    in_progress: ['waiting_approval', 'done', 'cancelled'],
    waiting_approval: ['done', 'rejected'],
    rejected: ['in_progress', 'done'],
  };
  const TERMINAL_STATES = new Set(['done', 'cancelled']);

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
   * 读取讨论会话。
   * @param {string} sessionId
   * @returns {object|null}
   */
  function getDiscussionSession(sessionId) {
    if (!sessionId) return null;
    return db.get(`SELECT * FROM discussion_sessions WHERE id = ${db.esc(sessionId)}`);
  }

  /**
   * 校验讨论状态转换是否合法。
   * @param {string} from
   * @param {string} to
   * @returns {boolean}
   */
  function isValidTransition(from, to) {
    const allowed = DISCUSSION_TRANSITIONS[from];
    return Array.isArray(allowed) && allowed.includes(to);
  }

  /**
   * 执行讨论状态转换，校验合法性并记录审计日志。
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.toStatus
   * @param {string} options.triggeredBy
   * @param {string} options.triggeredByName
   * @param {string|null} [options.reason]
   * @param {object} [options.extraUpdates]
   * @returns {object}
   */
  function transitionDiscussion({ sessionId, toStatus, triggeredBy, triggeredByName, reason = null, extraUpdates = {} }) {
    const session = getDiscussionSession(sessionId);
    if (!session) throw new Error('Discussion session not found');

    if (!isValidTransition(session.status, toStatus)) {
      throw new Error(`Invalid discussion transition: ${session.status} → ${toStatus}`);
    }

    const now = new Date().toISOString();
    const transitionId = crypto.randomUUID();
    const closedAt = TERMINAL_STATES.has(toStatus) ? now : null;
    const sets = [
      `status = ${db.esc(toStatus)}`,
      `updated_at = ${db.esc(now)}`,
    ];

    if (closedAt) sets.push(`closed_at = ${db.esc(closedAt)}`);
    for (const [key, value] of Object.entries(extraUpdates)) {
      sets.push(`${key} = ${db.esc(value)}`);
    }

    db.exec(`
      BEGIN;
      UPDATE discussion_sessions SET ${sets.join(', ')} WHERE id = ${db.esc(sessionId)};
      INSERT INTO discussion_transitions (id, session_id, from_status, to_status, triggered_by, triggered_by_name, reason, created_at)
      VALUES (${db.esc(transitionId)}, ${db.esc(sessionId)}, ${db.esc(session.status)}, ${db.esc(toStatus)}, ${db.esc(triggeredBy)}, ${db.esc(triggeredByName)}, ${db.esc(reason)}, ${db.esc(now)});
      COMMIT;
    `);

    return db.get(`SELECT * FROM discussion_sessions WHERE id = ${db.esc(sessionId)}`);
  }

  /**
   * 获取讨论的完整状态转换历史。
   * @param {string} sessionId
   * @returns {Array<object>}
   */
  function getDiscussionTransitions(sessionId) {
    return db.all(`SELECT * FROM discussion_transitions WHERE session_id = ${db.esc(sessionId)} ORDER BY created_at ASC`);
  }

  /**
   * 格式化讨论会话状态快照，供消息推送和历史读取复用。
   * @param {object|null} session
   * @param {object} [options]
   * @param {number} [options.messageRound]
   * @returns {object|null}
   */
  function buildDiscussionStateSnapshot(session, { messageRound } = {}) {
    if (!session) return null;

    const participantAgentIds = getSessionParticipantIds(session);
    const completedRounds = Number(session.completed_rounds || 0);
    const maxRounds = Number(session.max_rounds || 0);
    const isActiveDiscussion = session.status === 'in_progress' || session.status === 'open';
    const expectedSpeakerId = isActiveDiscussion ? session.next_agent_id : null;
    const currentRound = messageRound != null
      ? messageRound
      : isActiveDiscussion || session.status === 'cancelled'
        ? Math.min(completedRounds + 1, maxRounds || completedRounds + 1)
        : Math.max(completedRounds, maxRounds, 0);
    const { divergenceScore, divergencePhase } = computeDiscussionDivergence({
      messageRound: currentRound,
      maxRounds,
    });

    let nextSpeakerId = null;
    let finalTurn = !isActiveDiscussion;

    if (isActiveDiscussion && participantAgentIds.length > 0 && expectedSpeakerId) {
      const expectedIndex = Number(session.current_index || 0);
      const followingIndex = (expectedIndex + 1) % participantAgentIds.length;
      const completedAfterReply = completedRounds + (followingIndex === 0 ? 1 : 0);
      finalTurn = completedAfterReply >= maxRounds;
      nextSpeakerId = finalTurn ? null : participantAgentIds[followingIndex];
    }

    const members = session.channel_id ? getChannelMembers(session.channel_id) : [];
    const memberRoleMap = new Map(members.map((member) => [member.id, member.team_role || null]));
    const participantRoles = {};
    for (const agentId of participantAgentIds) {
      const role = memberRoleMap.get(agentId);
      if (role) participantRoles[agentId] = role;
    }

    const speakerTeamRole = expectedSpeakerId ? (memberRoleMap.get(expectedSpeakerId) || null) : null;
    const agentInstruction = buildAgentInstruction({
      status: session.status,
      participantCount: participantAgentIds.length,
      currentRound,
      maxRounds,
      finalTurn,
      divergenceScore,
      divergencePhase,
      speakerTeamRole,
    });

    return {
      id: session.id,
      mode: LINEAR_DISCUSSION_MODE,
      participantAgentIds,
      participantCount: participantAgentIds.length,
      participantRoles,
      completedRounds,
      currentRound,
      maxRounds,
      status: session.status,
      expectedSpeakerId,
      nextSpeakerId,
      finalTurn,
      divergenceScore,
      divergencePhase,
      rootMessageId: session.root_message_id,
      lastMessageId: session.last_message_id,
      agentInstruction,
      requiresApproval: !!session.requires_approval,
      approvalAgentId: session.approval_agent_id || null,
      resolution: tryParseJson(session.resolution) || null,
    };
  }

  /**
   * 校验并推进线性讨论会话，自动计算下一位 agent 的 mention。
   * @param {object} options
   * @param {object} options.session
   * @param {string} options.senderId
   * @param {string|null|undefined} options.replyTo
   * @returns {{ nextState: object, discussionState: object, autoMentions: Array<object>, transitions: Array<object> }}
   */
  function advanceLinearDiscussion({ session, senderId, replyTo }) {
    if (!session) {
      throw new Error('Discussion session not found');
    }
    if (session.status !== 'in_progress' && session.status !== 'open') {
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

    let autoMentions = [];
    if (!finalTurn && expectedNextAgentId) {
      const { agents } = resolveChannelAgents(session.channel_id, [expectedNextAgentId]);
      if (agents.length > 0) {
        autoMentions = [{ agentId: agents[0].id, agentName: agents[0].name, teamRole: agents[0].team_role || null }];
      }
    }

    let endStatus = 'done';
    if (finalTurn && session.requires_approval) {
      endStatus = 'waiting_approval';
    }

    let newStatus = 'in_progress';
    if (finalTurn) {
      newStatus = endStatus;
    }

    const nextState = {
      ...session,
      current_index: finalTurn ? null : nextIndex,
      completed_rounds: completedAfterReply,
      next_agent_id: expectedNextAgentId,
      status: newStatus,
    };

    return {
      nextState,
      discussionState: buildDiscussionStateSnapshot(nextState, { messageRound: completedRounds + 1 }),
      autoMentions,
      transitions: [
        ...(session.status === 'open' ? [{ from: 'open', to: 'in_progress' }] : []),
        ...(finalTurn ? [{ from: 'in_progress', to: endStatus }] : []),
      ],
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
   * @param {boolean} [options.requiresApproval]
   * @param {string|null} [options.approvalAgentId]
   * @param {object|null} [options.intent]
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
    requiresApproval = false,
    approvalAgentId = null,
    intent = null,
  }) {
    const validatedIntent = validateIntent(intent);
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

    if (approvalAgentId) {
      const { missingIds: approvalMissing } = resolveChannelAgents(channelId, [approvalAgentId]);
      if (approvalMissing.length > 0) {
        throw new Error('Approval agent is not a channel member');
      }
    }

    const sessionId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const transitionId = crypto.randomUUID();
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
      status: 'open',
      requires_approval: requiresApproval ? 1 : 0,
      approval_agent_id: approvalAgentId,
      created_by: senderId,
      created_at: now,
      updated_at: now,
      closed_at: null,
    };
    const discussionState = { ...buildDiscussionStateSnapshot(initialSession), isSessionStart: true };
    const mentions = [{ agentId: firstAgent.id, agentName: firstAgent.name, teamRole: firstAgent.team_role || null }];
    const intentJson = validatedIntent ? JSON.stringify(validatedIntent) : null;

    db.exec(`
      BEGIN;
      INSERT INTO discussion_sessions (
        id, channel_id, root_message_id, participant_agent_ids, current_index,
        completed_rounds, max_rounds, next_agent_id, last_message_id, status,
        requires_approval, approval_agent_id,
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
        ${db.esc(initialSession.requires_approval)},
        ${db.esc(initialSession.approval_agent_id)},
        ${db.esc(senderId)},
        ${db.esc(now)},
        ${db.esc(now)},
        NULL
      );
      INSERT INTO discussion_transitions (id, session_id, from_status, to_status, triggered_by, triggered_by_name, reason, created_at)
      VALUES (${db.esc(transitionId)}, ${db.esc(sessionId)}, '', 'open', ${db.esc(senderId)}, ${db.esc(senderName)}, 'Discussion created', ${db.esc(now)});
      INSERT INTO messages (
        id, channel_id, sender_id, content, content_type, reply_to, created_at,
        mentions, reply_target_agent_id, discussion_session_id, discussion_state, intent
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
        ${db.esc(JSON.stringify(discussionState))},
        ${db.esc(intentJson)}
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
      intent: intentJson,
    });

    return {
      message,
      discussion: discussionState,
      sender: { id: senderId, name: senderName },
    };
  }

  /**
   * 中断活跃的线性讨论会话，将其状态设为 cancelled 并生成系统消息。
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.channelId
   * @param {string} options.senderId
   * @param {string} options.senderName
   * @param {string|null} [options.reason]
   * @returns {{ message: object, discussion: object, sender: { id: string, name: string } }}
   */
  function interruptLinearDiscussion({ sessionId, channelId, senderId, senderName, reason = null }) {
    const session = getDiscussionSession(sessionId);
    if (!session) {
      throw new Error('Discussion session not found');
    }
    if (session.channel_id !== channelId) {
      throw new Error('Discussion session does not belong to this channel');
    }
    if (!isValidTransition(session.status, 'cancelled')) {
      throw new Error('Discussion session cannot be cancelled in current state');
    }

    const messageId = crypto.randomUUID();
    const transitionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const cancelledSession = {
      ...session,
      status: 'cancelled',
      next_agent_id: null,
      closed_at: now,
      updated_at: now,
      cancelled_reason: reason,
    };
    const discussionState = buildDiscussionStateSnapshot(cancelledSession);
    const content = reason ? `管理员已中断此线性讨论。原因：${reason}` : '管理员已中断此线性讨论。';

    db.exec(`
      BEGIN;
      UPDATE discussion_sessions SET
        status = 'cancelled',
        next_agent_id = NULL,
        cancelled_reason = ${db.esc(reason)},
        closed_at = ${db.esc(now)},
        updated_at = ${db.esc(now)}
      WHERE id = ${db.esc(sessionId)};
      INSERT INTO discussion_transitions (id, session_id, from_status, to_status, triggered_by, triggered_by_name, reason, created_at)
      VALUES (${db.esc(transitionId)}, ${db.esc(sessionId)}, ${db.esc(session.status)}, 'cancelled', ${db.esc(senderId)}, ${db.esc(senderName)}, ${db.esc(reason)}, ${db.esc(now)});
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

  /**
   * Agent/Admin 提交讨论审批请求。
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.channelId
   * @param {string} options.triggeredBy
   * @param {string} options.triggeredByName
   * @returns {{ session: object, discussion: object, transition: { from: string, to: string } }}
   */
  function submitForApproval({ sessionId, channelId, triggeredBy, triggeredByName }) {
    const session = getDiscussionSession(sessionId);
    if (!session) throw new Error('Discussion session not found');
    if (session.channel_id !== channelId) throw new Error('Discussion session does not belong to this channel');

    const updated = transitionDiscussion({
      sessionId,
      toStatus: 'waiting_approval',
      triggeredBy,
      triggeredByName,
      reason: 'Submitted for approval',
      extraUpdates: { next_agent_id: null },
    });

    return {
      session: updated,
      discussion: buildDiscussionStateSnapshot(updated),
      transition: { from: session.status, to: 'waiting_approval' },
    };
  }

  /**
   * 审批通过讨论。
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.channelId
   * @param {string} options.triggeredBy
   * @param {string} options.triggeredByName
   * @param {string|null} [options.resolution]
   * @returns {{ session: object, discussion: object, transition: { from: string, to: string } }}
   */
  function approveDiscussion({ sessionId, channelId, triggeredBy, triggeredByName, resolution = null }) {
    const session = getDiscussionSession(sessionId);
    if (!session) throw new Error('Discussion session not found');
    if (session.channel_id !== channelId) throw new Error('Discussion session does not belong to this channel');

    if (session.approval_agent_id && session.approval_agent_id !== triggeredBy && !triggeredBy.startsWith('admin:')) {
      throw new Error('Only the designated approval agent or admin can approve');
    }

    const resolutionJson = resolution ? (typeof resolution === 'string' ? resolution : JSON.stringify(resolution)) : null;
    const updated = transitionDiscussion({
      sessionId,
      toStatus: 'done',
      triggeredBy,
      triggeredByName,
      reason: 'Approved',
      extraUpdates: resolutionJson ? { resolution: resolutionJson } : {},
    });

    return {
      session: updated,
      discussion: buildDiscussionStateSnapshot(updated),
      transition: { from: session.status, to: 'done' },
    };
  }

  /**
   * 拒绝讨论结论。
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.channelId
   * @param {string} options.triggeredBy
   * @param {string} options.triggeredByName
   * @param {string|null} [options.reason]
   * @returns {{ session: object, discussion: object, transition: { from: string, to: string } }}
   */
  function rejectDiscussion({ sessionId, channelId, triggeredBy, triggeredByName, reason = null }) {
    const session = getDiscussionSession(sessionId);
    if (!session) throw new Error('Discussion session not found');
    if (session.channel_id !== channelId) throw new Error('Discussion session does not belong to this channel');

    if (session.approval_agent_id && session.approval_agent_id !== triggeredBy && !triggeredBy.startsWith('admin:')) {
      throw new Error('Only the designated approval agent or admin can reject');
    }

    const updated = transitionDiscussion({
      sessionId,
      toStatus: 'rejected',
      triggeredBy,
      triggeredByName,
      reason: reason || 'Rejected',
    });

    return {
      session: updated,
      discussion: buildDiscussionStateSnapshot(updated),
      transition: { from: session.status, to: 'rejected' },
    };
  }

  /**
   * 重新开启被拒绝的讨论。
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.channelId
   * @param {string} options.triggeredBy
   * @param {string} options.triggeredByName
   * @param {number} [options.additionalRounds]
   * @returns {{ session: object, discussion: object, transition: { from: string, to: string } }}
   */
  function reopenDiscussion({ sessionId, channelId, triggeredBy, triggeredByName, additionalRounds = 0 }) {
    const session = getDiscussionSession(sessionId);
    if (!session) throw new Error('Discussion session not found');
    if (session.channel_id !== channelId) throw new Error('Discussion session does not belong to this channel');

    const participantAgentIds = getSessionParticipantIds(session);
    const extraRounds = parsePositiveInt(additionalRounds) || 1;
    const newMaxRounds = Number(session.max_rounds || 0) + extraRounds;
    const nextIndex = participantAgentIds.length === 0 ? 0 : Number(session.current_index || 0) % participantAgentIds.length;
    const nextAgentId = participantAgentIds[nextIndex] || null;

    const updated = transitionDiscussion({
      sessionId,
      toStatus: 'in_progress',
      triggeredBy,
      triggeredByName,
      reason: `Reopened with ${extraRounds} additional round(s)`,
      extraUpdates: {
        max_rounds: newMaxRounds,
        current_index: nextIndex,
        next_agent_id: nextAgentId,
        closed_at: null,
      },
    });

    return {
      session: updated,
      discussion: buildDiscussionStateSnapshot(updated),
      transition: { from: session.status, to: 'in_progress' },
    };
  }

  /**
   * 直接关闭被拒绝的讨论。
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.channelId
   * @param {string} options.triggeredBy
   * @param {string} options.triggeredByName
   * @param {string|null} [options.resolution]
   * @returns {{ session: object, discussion: object, transition: { from: string, to: string } }}
   */
  function closeRejectedDiscussion({ sessionId, channelId, triggeredBy, triggeredByName, resolution = null }) {
    const session = getDiscussionSession(sessionId);
    if (!session) throw new Error('Discussion session not found');
    if (session.channel_id !== channelId) throw new Error('Discussion session does not belong to this channel');

    const resolutionJson = resolution ? (typeof resolution === 'string' ? resolution : JSON.stringify(resolution)) : null;
    const updated = transitionDiscussion({
      sessionId,
      toStatus: 'done',
      triggeredBy,
      triggeredByName,
      reason: 'Closed after rejection',
      extraUpdates: resolutionJson ? { resolution: resolutionJson } : {},
    });

    return {
      session: updated,
      discussion: buildDiscussionStateSnapshot(updated),
      transition: { from: session.status, to: 'done' },
    };
  }

  return {
    advanceLinearDiscussion,
    approveDiscussion,
    buildDiscussionStateSnapshot,
    closeRejectedDiscussion,
    createLinearDiscussionSession,
    getDiscussionSession,
    getDiscussionTransitions,
    interruptLinearDiscussion,
    isValidTransition,
    rejectDiscussion,
    reopenDiscussion,
    submitForApproval,
    transitionDiscussion,
  };
}
