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

  /** 合法的意图任务类型白名单 */
  const VALID_TASK_TYPES = new Set([
    'chat', 'code_review', 'approval_request', 'task_assignment',
    'info_share', 'question', 'decision', 'bug_report', 'feature_request',
  ]);
  const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
  const VALID_APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected']);
  const MAX_INTENT_SIZE = 4096;

  // ── Phase 3: 讨论状态机 ──

  /** 合法的讨论状态转换映射 */
  const DISCUSSION_TRANSITIONS = {
    open:              ['in_progress', 'cancelled'],
    in_progress:       ['waiting_approval', 'done', 'cancelled'],
    waiting_approval:  ['done', 'rejected'],
    rejected:          ['in_progress', 'done'],
  };

  /** 所有终态 */
  const TERMINAL_STATES = new Set(['done', 'cancelled']);

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
   * @param {string} options.triggeredBy - agentId 或 'admin:username'
   * @param {string} options.triggeredByName
   * @param {string|null} [options.reason]
   * @param {object} [options.extraUpdates] - 额外的 session 字段更新
   * @returns {object} 更新后的 session
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

    // 构建 SET 子句
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
   * 校验并清理 intent 对象。
   * @param {unknown} intent
   * @returns {object|null} 清理后的 intent 或 null
   * @throws {Error} 不合法时抛出
   */
  function validateIntent(intent) {
    if (intent === null || intent === undefined) return null;
    if (typeof intent !== 'object' || Array.isArray(intent)) {
      throw new Error('intent must be an object');
    }

    const raw = JSON.stringify(intent);
    if (raw.length > MAX_INTENT_SIZE) {
      throw new Error(`intent JSON exceeds ${MAX_INTENT_SIZE} bytes`);
    }

    const cleaned = {};
    if (intent.task_type !== undefined) {
      // 允许 custom: 前缀的自定义类型
      if (typeof intent.task_type !== 'string') throw new Error('intent.task_type must be a string');
      if (!VALID_TASK_TYPES.has(intent.task_type) && !intent.task_type.startsWith('custom:')) {
        throw new Error(`intent.task_type must be one of: ${[...VALID_TASK_TYPES].join(', ')} or custom:*`);
      }
      cleaned.task_type = intent.task_type;
    }
    if (intent.priority !== undefined) {
      if (!VALID_PRIORITIES.has(intent.priority)) {
        throw new Error(`intent.priority must be one of: ${[...VALID_PRIORITIES].join(', ')}`);
      }
      cleaned.priority = intent.priority;
    }
    if (intent.requires_approval !== undefined) {
      if (typeof intent.requires_approval !== 'boolean') {
        throw new Error('intent.requires_approval must be a boolean');
      }
      cleaned.requires_approval = intent.requires_approval;
      if (intent.requires_approval) {
        cleaned.approval_status = 'pending';
      }
    }
    if (intent.deadline !== undefined) {
      if (intent.deadline !== null && typeof intent.deadline !== 'string') {
        throw new Error('intent.deadline must be a string or null');
      }
      cleaned.deadline = intent.deadline;
    }
    if (intent.tags !== undefined) {
      if (!Array.isArray(intent.tags) || !intent.tags.every((t) => typeof t === 'string')) {
        throw new Error('intent.tags must be an array of strings');
      }
      cleaned.tags = intent.tags;
    }
    if (intent.custom !== undefined) {
      if (typeof intent.custom !== 'object' || Array.isArray(intent.custom)) {
        throw new Error('intent.custom must be an object');
      }
      cleaned.custom = intent.custom;
    }
    return Object.keys(cleaned).length > 0 ? cleaned : null;
  }

  /**
   * 更新消息的 intent 字段（主要用于审批状态更新）。
   * @param {string} messageId
   * @param {object} intentPatch - 要合并到现有 intent 的字段
   * @returns {object|null} 更新后的格式化消息
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
   * 读取讨论会话的参与者顺序。
   * @param {object|null} session
   * @returns {string[]}
   */
  function getSessionParticipantIds(session) {
    const participantAgentIds = tryParseJson(session?.participant_agent_ids);
    return normalizeIdList(participantAgentIds);
  }

  /**
   * 将数值限制在指定区间内。
   * @param {number} value
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  function clampNumber(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * 根据消息所属轮次计算讨论发散度。
   * 轮次推进遵循正态分布：在 maxRounds / 2 附近达到峰值，随后持续收束。
   * @param {object} options
   * @param {number} options.messageRound
   * @param {number} options.maxRounds
   * @returns {{ divergenceScore: number, divergencePhase: 'opening' | 'expanding' | 'peak' | 'converging' | 'concluding' }}
   */
  function computeDiscussionDivergence({ messageRound, maxRounds }) {
    const resolvedMaxRounds = Number(maxRounds || 0);
    if (resolvedMaxRounds <= 1) {
      return { divergenceScore: 0, divergencePhase: 'concluding' };
    }

    const safeMessageRound = clampNumber(Number(messageRound || 1), 1, resolvedMaxRounds);
    const progress = (safeMessageRound - 1) / (resolvedMaxRounds - 1);
    const center = 0.5;
    const sigma = 0.22;
    const peakWindow = 0.12;
    const activeThreshold = 0.2;
    const edgeBase = Math.exp(-(((0 - center) ** 2) / (2 * (sigma ** 2))));
    const raw = Math.exp(-(((progress - center) ** 2) / (2 * (sigma ** 2))));
    const divergenceScore = clampNumber((raw - edgeBase) / (1 - edgeBase), 0, 1);

    let divergencePhase = 'concluding';
    if (safeMessageRound === resolvedMaxRounds) {
      divergencePhase = 'concluding';
    } else if (Math.abs(progress - center) <= peakWindow) {
      divergencePhase = 'peak';
    } else if (progress < center && divergenceScore >= activeThreshold) {
      divergencePhase = 'expanding';
    } else if (progress < center) {
      divergencePhase = 'opening';
    } else if (divergenceScore >= activeThreshold) {
      divergencePhase = 'converging';
    }

    return {
      divergenceScore: Math.round(divergenceScore * 10000) / 10000,
      divergencePhase,
    };
  }

  /**
   * 将讨论阶段枚举映射为中文标签。
   * @param {'opening' | 'expanding' | 'peak' | 'converging' | 'concluding'} phase
   * @returns {string}
   */
  function getDiscussionPhaseLabel(phase) {
    switch (phase) {
      case 'opening':
        return '开场铺陈';
      case 'expanding':
        return '发散扩展';
      case 'peak':
        return '发散峰值';
      case 'converging':
        return '逐步收束';
      case 'concluding':
      default:
        return '结论收束';
    }
  }

  /**
   * 根据讨论进度生成面向下一位发言 Agent 的节奏引导指令。
   * 指令完全由正态分布发散度与当前阶段驱动，避免离散轮次提示失真。
   * @param {object} options
   * @param {string} options.status - 讨论状态
   * @param {number} options.participantCount - 参与者数量
   * @param {number} options.currentRound - 当前消息所属轮次
   * @param {number} options.maxRounds - 总轮次
   * @param {boolean} options.finalTurn - 是否为最终发言
   * @param {number} options.divergenceScore - 当前轮次的发散度
   * @param {'opening' | 'expanding' | 'peak' | 'converging' | 'concluding'} options.divergencePhase - 当前讨论阶段
   * @param {string|null} [options.speakerTeamRole] - 当前发言者在频道中的角色定位
   * @returns {string|null} 指令文本，讨论非活跃时返回 null
   */
  function buildAgentInstruction({
    status,
    participantCount,
    currentRound,
    maxRounds,
    finalTurn,
    divergenceScore,
    divergencePhase,
    speakerTeamRole = null,
  }) {
    if (status !== 'in_progress' && status !== 'open') return null;

    const phaseLabel = getDiscussionPhaseLabel(divergencePhase);
    const scorePercent = Math.round(clampNumber(Number(divergenceScore || 0), 0, 1) * 100);
    const context = `[线性讨论] 这是一场 ${participantCount} 位 Agent 参与的线性讨论。当前第 ${currentRound}/${maxRounds} 轮，阶段为「${phaseLabel}」，发散度 ${scorePercent}%。`;

    // 角色定位引导：若设定了 team_role，在指令开头注入
    const rolePrefix = speakerTeamRole
      ? `[角色定位] 你在此频道中的角色定位是「${speakerTeamRole}」，请以此身份和视角参与讨论。\n`
      : '';

    if (finalTurn) {
      return rolePrefix + context
        + '\n你是本次讨论的最终发言者，发言后讨论将结束。'
        + '请只回顾关键共识与核心分歧，给出明确结论或裁决，不要继续引入新的讨论分支。';
    }

    switch (divergencePhase) {
      case 'opening':
        return rolePrefix + context
          + '\n当前处于开场铺陈阶段。请围绕主题展开问题空间、补充候选方向和关键视角，但不要急于下结论，也不要偏离题目。';
      case 'expanding':
        return rolePrefix + context
          + '\n当前进入发散扩展阶段。请在已有讨论基础上补充新的有效角度、挑战既有假设并扩大搜索空间，但所有扩展都必须直接服务当前议题。';
      case 'peak':
        return rolePrefix + context
          + '\n当前处于发散峰值。请优先枚举关键分歧、替代路径、主要风险与边界条件，尽可能覆盖问题空间，但不要跑题。';
      case 'converging':
        return rolePrefix + context
          + '\n当前进入收束阶段。不要再引入大范围新话题；请压缩候选项、回应前文分歧，并把讨论逐步归并成更少、更清晰的结论方向。';
      case 'concluding':
      default:
        return rolePrefix + context
          + '\n当前进入结论收束阶段。请只做总结、归纳共识与残余分歧，为最终结论提供直接材料，不要继续外扩讨论面。';
    }
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
    // open 和 in_progress 都是"活跃"状态，需要暴露 expectedSpeakerId 以便 Agent 客户端识别讨论上下文
    const isActiveDiscussion = session.status === 'in_progress' || session.status === 'open';
    const expectedSpeakerId = isActiveDiscussion ? session.next_agent_id : null;
    // 若外部传入 messageRound，使用它（确保消息轮次=推进前 completedRounds+1）；
    // 否则退回自动推算——对活跃/cancelled 取 completedRounds+1，对 done 取最终值。
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

    // 查询所有参与者的 team_role，构建 participantRoles 映射
    const members = session.channel_id ? getChannelMembers(session.channel_id) : [];
    const memberRoleMap = new Map(members.map((m) => [m.id, m.team_role || null]));
    const participantRoles = {};
    for (const agentId of participantAgentIds) {
      const role = memberRoleMap.get(agentId);
      if (role) participantRoles[agentId] = role;
    }

    // 获取预期发言者的 team_role，传给 buildAgentInstruction
    const speakerTeamRole = expectedSpeakerId ? (memberRoleMap.get(expectedSpeakerId) || null) : null;

    // 生成面向下一位发言 Agent 的节奏引导指令
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
    // open 和 in_progress 状态都允许发言（第一条发言时 session 还在 open）
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

    // 自动计算 mentions：非最后一轮则 @ 下一位 agent，最后一轮不 mention 任何人
    let autoMentions = [];
    if (!finalTurn && expectedNextAgentId) {
      const { agents } = resolveChannelAgents(session.channel_id, [expectedNextAgentId]);
      if (agents.length > 0) {
        autoMentions = [{ agentId: agents[0].id, agentName: agents[0].name, teamRole: agents[0].team_role || null }];
      }
    }

    // 决定结束状态：有审批要求 → waiting_approval，否则 → done
    let endStatus = 'done';
    if (finalTurn && session.requires_approval) {
      endStatus = 'waiting_approval';
    }

    // 决定新状态：open → in_progress（首条发言），之后根据轮次决定
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

    // messageRound = 推进前 completedRounds + 1，代表本条消息所属轮次
    return {
      nextState,
      discussionState: buildDiscussionStateSnapshot(nextState, { messageRound: completedRounds + 1 }),
      autoMentions,
      // 返回需要记录的状态转换信息
      transitions: [
        // 首条发言 open → in_progress
        ...(session.status === 'open' ? [{ from: 'open', to: 'in_progress' }] : []),
        // 最终发言的状态转换
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
   * @param {object|null} [options.intent] - 讨论根消息附带的结构化意图
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

    // 验证审批 Agent（若指定）必须是频道成员
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
    // 管理员开启讨论的根消息标记为 isSessionStart，前端用于区分显示格式
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
   * @param {object|null} [options.intent] - 消息附带的结构化意图
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
    // 校验 intent
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

    // 查询发送者的频道角色定位，用于实时消息推送（避免只有历史查询才有此字段）
    const senderMember = db.get(`SELECT team_role FROM channel_members
      WHERE channel_id = ${db.esc(channelId)} AND agent_id = ${db.esc(senderId)}`);
    const senderTeamRole = senderMember?.team_role || null;

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
      const closedAt = TERMINAL_STATES.has(result.nextState.status) ? now : null;

      // 构建状态转换审计日志 SQL
      let transitionsSql = '';
      for (const t of result.transitions || []) {
        const tid = crypto.randomUUID();
        transitionsSql += `
          INSERT INTO discussion_transitions (id, session_id, from_status, to_status, triggered_by, triggered_by_name, reason, created_at)
          VALUES (${db.esc(tid)}, ${db.esc(discussionSessionId)}, ${db.esc(t.from)}, ${db.esc(t.to)}, ${db.esc(senderId)}, ${db.esc(senderName)}, NULL, ${db.esc(now)});
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

  /**
   * 中断活跃的线性讨论会话，将其状态设为 cancelled 并生成系统消息。
   * @param {object} options
   * @param {string} options.sessionId - 讨论会话 ID
   * @param {string} options.channelId - 频道 ID
   * @param {string} options.senderId - 执行中断的管理员 sender_id（格式 admin:username）
   * @param {string} options.senderName - 管理员展示名
   * @param {string|null} [options.reason] - 中断原因
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
   * Agent/Admin 提交讨论审批请求（in_progress → waiting_approval）。
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.channelId
   * @param {string} options.triggeredBy - agentId 或 'admin:username'
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
   * 审批通过讨论（waiting_approval → done）。
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.channelId
   * @param {string} options.triggeredBy
   * @param {string} options.triggeredByName
   * @param {string|null} [options.resolution] - 审批结论/决议 JSON 字符串
   * @returns {{ session: object, discussion: object, transition: { from: string, to: string } }}
   */
  function approveDiscussion({ sessionId, channelId, triggeredBy, triggeredByName, resolution = null }) {
    const session = getDiscussionSession(sessionId);
    if (!session) throw new Error('Discussion session not found');
    if (session.channel_id !== channelId) throw new Error('Discussion session does not belong to this channel');

    // 若指定了 approval_agent_id，仅该 Agent 可审批
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
      extraUpdates: {
        ...(resolutionJson ? { resolution: resolutionJson } : {}),
      },
    });

    return {
      session: updated,
      discussion: buildDiscussionStateSnapshot(updated),
      transition: { from: session.status, to: 'done' },
    };
  }

  /**
   * 拒绝讨论结论（waiting_approval → rejected）。
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
   * 重新开启被拒绝的讨论（rejected → in_progress），可追加额外轮次。
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.channelId
   * @param {string} options.triggeredBy
   * @param {string} options.triggeredByName
   * @param {number} [options.additionalRounds] - 追加轮次数
   * @returns {{ session: object, discussion: object, transition: { from: string, to: string } }}
   */
  function reopenDiscussion({ sessionId, channelId, triggeredBy, triggeredByName, additionalRounds = 0 }) {
    const session = getDiscussionSession(sessionId);
    if (!session) throw new Error('Discussion session not found');
    if (session.channel_id !== channelId) throw new Error('Discussion session does not belong to this channel');

    const participantAgentIds = getSessionParticipantIds(session);
    const extraRounds = parsePositiveInt(additionalRounds) || 1;
    const newMaxRounds = Number(session.max_rounds || 0) + extraRounds;
    const completedRounds = Number(session.completed_rounds || 0);

    // 恢复到上次停止的位置继续讨论
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
   * 直接关闭被拒绝的讨论（rejected → done），接受当前结论。
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
      extraUpdates: {
        ...(resolutionJson ? { resolution: resolutionJson } : {}),
      },
    });

    return {
      session: updated,
      discussion: buildDiscussionStateSnapshot(updated),
      transition: { from: session.status, to: 'done' },
    };
  }

  return {
    approveDiscussion,
    buildDiscussionStateSnapshot,
    closeRejectedDiscussion,
    createChannelMessage,
    createLinearDiscussionSession,
    formatMessage,
    formatMessages,
    getChannelMembers,
    getDiscussionSession,
    getDiscussionTransitions,
    getFormattedMessageById,
    interruptLinearDiscussion,
    isValidTransition,
    parsePositiveInt,
    rejectDiscussion,
    reopenDiscussion,
    resolveMentions,
    submitForApproval,
    transitionDiscussion,
    updateMessageIntent,
    validateIntent,
  };
}
