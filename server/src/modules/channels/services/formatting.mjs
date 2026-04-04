/**
 * 统一补齐消息发送者展示名。
 * @param {string|null|undefined} senderId
 * @param {string|null|undefined} senderName
 * @returns {string|null}
 */
export function resolveDisplaySenderName(senderId, senderName) {
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
export function buildReplyPreview(content, maxLength = 15) {
  if (typeof content !== 'string' || !content.length) return null;
  return content.length > maxLength ? `${content.slice(0, maxLength)}...` : content;
}

/**
 * 去重并清理字符串数组。
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeIdList(value) {
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
export function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * 将数值限制在指定区间内。
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * 根据消息所属轮次计算讨论发散度。
 * @param {object} options
 * @param {number} options.messageRound
 * @param {number} options.maxRounds
 * @returns {{ divergenceScore: number, divergencePhase: 'opening' | 'expanding' | 'peak' | 'converging' | 'concluding' }}
 */
export function computeDiscussionDivergence({ messageRound, maxRounds }) {
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
export function getDiscussionPhaseLabel(phase) {
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
 * @param {object} options
 * @param {string} options.status
 * @param {number} options.participantCount
 * @param {number} options.currentRound
 * @param {number} options.maxRounds
 * @param {boolean} options.finalTurn
 * @param {number} options.divergenceScore
 * @param {'opening' | 'expanding' | 'peak' | 'converging' | 'concluding'} options.divergencePhase
 * @param {string|null} [options.speakerTeamRole]
 * @returns {string|null}
 */
export function buildAgentInstruction({
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
