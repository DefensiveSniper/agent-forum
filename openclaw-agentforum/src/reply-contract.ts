import type { ChannelPolicy, MessageIntent } from "./types.js";

const VALID_TASK_TYPES = new Set([
  "chat",
  "code_review",
  "approval_request",
  "task_assignment",
  "info_share",
  "question",
  "decision",
  "bug_report",
  "feature_request",
]);
const VALID_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const ALLOWED_REPLY_KEYS = new Set(["content", "intent"]);
const ALLOWED_INTENT_KEYS = new Set([
  "task_type",
  "priority",
  "requires_approval",
  "deadline",
  "tags",
  "custom",
]);

/** 结构化出站回复载荷 */
export interface StructuredAgentReply {
  content: string;
  intent: MessageIntent | null;
}

/**
 * 判断给定值是否为普通 JSON 对象。
 * @param value - 待判断值
 * @returns 是否为对象字面量
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 拉取指定频道的有效策略快照。
 * @param forumUrl - AgentForum 服务地址
 * @param channelId - 频道 ID
 * @param apiKey - Agent API Key
 * @returns 归一化后的频道策略
 */
export async function fetchChannelPolicy(
  forumUrl: string,
  channelId: string,
  apiKey: string,
): Promise<ChannelPolicy> {
  const res = await fetch(`${forumUrl}/api/v1/channels/${channelId}/policy`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`fetchChannelPolicy failed: HTTP ${res.status}: ${text}`);
  }

  const raw = text ? JSON.parse(text) : null;
  return normalizeChannelPolicy(raw);
}

/**
 * 将服务端返回的频道策略归一化为稳定结构。
 * @param raw - 服务端原始响应
 * @returns 稳定的频道策略对象
 */
export function normalizeChannelPolicy(raw: unknown): ChannelPolicy {
  const source = isPlainObject(raw) ? raw : {};
  return {
    isolation_level: source.isolation_level === "strict" ? "strict" : "standard",
    require_intent: Boolean(source.require_intent),
    allowed_task_types: Array.isArray(source.allowed_task_types)
      ? source.allowed_task_types.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : null,
    default_requires_approval: Boolean(source.default_requires_approval),
    required_capabilities: Array.isArray(source.required_capabilities)
      ? source.required_capabilities.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : null,
    max_concurrent_discussions: Number.isInteger(source.max_concurrent_discussions)
      ? Number(source.max_concurrent_discussions)
      : 5,
    message_rate_limit: Number.isInteger(source.message_rate_limit)
      ? Number(source.message_rate_limit)
      : 60,
  };
}

/**
 * 构造发给 OpenClaw 模型的结构化回复协议说明。
 * @param policy - 当前频道策略
 * @returns 协议说明文本
 */
export function buildStructuredReplyInstructions(policy: ChannelPolicy): string {
  const allowedTaskTypes = policy.allowed_task_types?.length
    ? policy.allowed_task_types.join(", ")
    : "chat, code_review, approval_request, task_assignment, info_share, question, decision, bug_report, feature_request, custom:*";
  const intentRule = policy.require_intent
    ? "本频道要求每条出站消息都带非空 intent。若只是普通确认、寒暄或同步已收到，也必须至少使用 task_type=\"chat\"。"
    : "仅当消息具备明确协作语义时才附带 intent；普通确认、寒暄、已收到、简单致谢等消息应返回 intent: null。";

  return [
    "[AgentForum Structured Reply Contract]",
    "你必须只输出一个 JSON 对象，不得输出 Markdown 代码块、解释或前后缀文本。",
    "JSON 结构固定为 {\"content\":\"...\",\"intent\":null|{...}}。",
    "content 必须是准备发回频道的中文正文，不要手动添加 @mention。",
    "intent 只允许包含 task_type、priority、requires_approval、deadline、tags、custom；只要 intent 非空，就必须包含 task_type。",
    "",
    "[Current Channel Policy]",
    `require_intent=${policy.require_intent ? "true" : "false"}`,
    `allowed_task_types=${allowedTaskTypes}`,
    `default_requires_approval=${policy.default_requires_approval ? "true" : "false"}`,
    "",
    "[Intent Rubric]",
    intentRule,
    '提问、索取判断、索取结论 -> task_type="question"',
    '要求对方执行动作、调查、实现、验证、跟进 -> task_type="task_assignment"',
    '要求审查代码、Patch、方案 -> task_type="code_review"',
    '请求批准、授权、放行 -> task_type="approval_request"，且只有确实在请求审批时才设置 requires_approval=true',
    '给出方案选择、拍板、裁定、最终结论 -> task_type="decision"',
    '同步调查结果、日志发现、事实结论、上下文信息 -> task_type="info_share"',
    '报告问题、异常、故障、回归 -> task_type="bug_report"',
    '提出新增能力或变更需求 -> task_type="feature_request"',
    "priority 仅在紧急度明显偏离普通值时才附带：urgent=立即处理且阻塞主流程，high=重要且应优先，low=明确不急；其余不要附带。",
    "若 allowed_task_types 有限制，你只能从允许集合中选择最贴近语义的 task_type，不要输出非法值。",
  ].join("\n");
}

/**
 * 校验并清理模型输出的 intent。
 * @param rawIntent - 原始 intent
 * @param policy - 当前频道策略
 * @returns 清理后的 intent
 */
function normalizeStructuredIntent(rawIntent: unknown, policy: ChannelPolicy): MessageIntent | null {
  if (rawIntent === null || rawIntent === undefined) {
    if (policy.require_intent) {
      throw new Error("当前频道要求返回非空 intent");
    }
    return null;
  }
  if (!isPlainObject(rawIntent)) {
    throw new Error("intent 必须是对象或 null");
  }

  const extraKeys = Object.keys(rawIntent).filter((key) => !ALLOWED_INTENT_KEYS.has(key));
  if (extraKeys.length > 0) {
    throw new Error(`intent 包含不支持的字段: ${extraKeys.join(", ")}`);
  }

  const intent: MessageIntent = {};
  if (rawIntent.task_type !== undefined) {
    if (typeof rawIntent.task_type !== "string" || rawIntent.task_type.trim().length === 0) {
      throw new Error("intent.task_type 必须是非空字符串");
    }
    if (!VALID_TASK_TYPES.has(rawIntent.task_type) && !rawIntent.task_type.startsWith("custom:")) {
      throw new Error(`intent.task_type 非法: ${rawIntent.task_type}`);
    }
    if (policy.allowed_task_types && !policy.allowed_task_types.includes(rawIntent.task_type)) {
      throw new Error(`intent.task_type 不在频道允许集合内: ${rawIntent.task_type}`);
    }
    intent.task_type = rawIntent.task_type;
  }

  if (rawIntent.priority !== undefined) {
    if (typeof rawIntent.priority !== "string" || !VALID_PRIORITIES.has(rawIntent.priority)) {
      throw new Error(`intent.priority 非法: ${String(rawIntent.priority)}`);
    }
    intent.priority = rawIntent.priority as MessageIntent["priority"];
  }

  if (rawIntent.requires_approval !== undefined) {
    if (typeof rawIntent.requires_approval !== "boolean") {
      throw new Error("intent.requires_approval 必须是布尔值");
    }
    intent.requires_approval = rawIntent.requires_approval;
  }

  if (rawIntent.deadline !== undefined) {
    if (rawIntent.deadline !== null && typeof rawIntent.deadline !== "string") {
      throw new Error("intent.deadline 必须是字符串或 null");
    }
    intent.deadline = rawIntent.deadline;
  }

  if (rawIntent.tags !== undefined) {
    if (!Array.isArray(rawIntent.tags) || rawIntent.tags.some((item) => typeof item !== "string")) {
      throw new Error("intent.tags 必须是字符串数组");
    }
    intent.tags = rawIntent.tags;
  }

  if (rawIntent.custom !== undefined) {
    if (!isPlainObject(rawIntent.custom)) {
      throw new Error("intent.custom 必须是对象");
    }
    intent.custom = rawIntent.custom;
  }

  if (!intent.task_type) {
    throw new Error(
      policy.require_intent
        ? "当前频道要求每条消息至少提供 intent.task_type"
        : "intent 非空时必须提供 task_type"
    );
  }

  if (Object.keys(intent).length === 0) {
    if (policy.require_intent) {
      throw new Error("当前频道要求返回非空 intent");
    }
    return null;
  }

  return intent;
}

/**
 * 解析 OpenClaw 模型输出的结构化回复协议。
 * @param rawOutput - 模型原始输出
 * @param policy - 当前频道策略
 * @returns 结构化回复对象
 */
export function parseStructuredReply(rawOutput: string, policy: ChannelPolicy): StructuredAgentReply {
  const trimmed = String(rawOutput || "").trim();
  if (!trimmed) {
    throw new Error("模型输出为空");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("模型输出不是合法 JSON");
  }

  if (!isPlainObject(parsed)) {
    throw new Error("模型输出必须是 JSON 对象");
  }

  const extraKeys = Object.keys(parsed).filter((key) => !ALLOWED_REPLY_KEYS.has(key));
  if (extraKeys.length > 0) {
    throw new Error(`输出对象包含不支持的字段: ${extraKeys.join(", ")}`);
  }

  if (typeof parsed.content !== "string" || parsed.content.trim().length === 0) {
    throw new Error("content 必须是非空字符串");
  }

  return {
    content: parsed.content.trim(),
    intent: normalizeStructuredIntent(parsed.intent, policy),
  };
}

/**
 * 构造一次性的协议修正提示。
 * @param errorMessage - 解析失败原因
 * @param previousOutput - 上一条原始输出
 * @returns 修正提示文本
 */
export function buildStructuredReplyRepairPrompt(errorMessage: string, previousOutput: string): string {
  return [
    "[AgentForum Structured Reply Repair]",
    `错误原因：${errorMessage}`,
    "请保持原本语义，重新只输出一个合法 JSON 对象，不要输出解释、标题、代码块或额外文本。",
    "上一条原始输出：",
    previousOutput,
  ].join("\n\n");
}
