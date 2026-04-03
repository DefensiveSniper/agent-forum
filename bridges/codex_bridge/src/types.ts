/**
 * Forum 协议相关类型定义。
 * 与 AgentForum 服务端交互的数据结构。
 */

/** 归一化后的频道结构 */
export interface Channel {
  id: string;
  name: string;
  description: string | null;
  type: string;
  createdBy: string | null;
  maxMembers: number;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  memberCount: number | null;
}

/** 归一化后的频道成员结构 */
export interface ChannelMember {
  agentId: string;
  agentName: string;
  role: string;
  joinedAt: string;
}

/** 归一化后的 mention 结构 */
export interface Mention {
  agentId: string;
  agentName: string;
  teamRole?: string | null;
}

/** 归一化后的线性讨论快照 */
export interface Discussion {
  id: string;
  mode: "linear";
  participantAgentIds: string[];
  participantCount: number;
  participantRoles?: Record<string, string>;
  completedRounds: number;
  currentRound: number;
  maxRounds: number;
  status:
    | "open"
    | "in_progress"
    | "waiting_approval"
    | "done"
    | "cancelled"
    | "rejected";
  expectedSpeakerId: string | null;
  nextSpeakerId: string | null;
  finalTurn: boolean;
  divergenceScore: number;
  divergencePhase: "opening" | "expanding" | "peak" | "converging" | "concluding";
  rootMessageId: string;
  lastMessageId: string;
  agentInstruction?: string | null;
  requiresApproval?: boolean;
  approvalAgentId?: string | null;
  resolution?: unknown;
}

/** Agent 能力定义 */
export interface AgentCapability {
  capability: string;
  proficiency: "basic" | "standard" | "expert";
  description: string | null;
}

/** 消息结构化意图字段 */
export interface MessageIntent {
  task_type?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  requires_approval?: boolean;
  approval_status?: "pending" | "approved" | "rejected" | null;
  approved_by?: string | null;
  deadline?: string | null;
  tags?: string[];
  custom?: Record<string, unknown>;
}

/** 频道沙箱策略 */
export interface ChannelPolicy {
  isolation_level: "standard" | "strict";
  require_intent: boolean;
  allowed_task_types: string[] | null;
  default_requires_approval: boolean;
  required_capabilities: string[] | null;
  max_concurrent_discussions: number;
  message_rate_limit: number;
}

/** 归一化后的消息结构 */
export interface Message {
  id: string;
  channelId: string;
  senderId: string;
  senderName: string;
  content: string;
  contentType: string;
  replyTo: string | null;
  replyTargetAgentId: string | null;
  mentions: Mention[];
  discussionSessionId: string | null;
  discussion: Discussion | null;
  intent: MessageIntent | null;
  createdAt: string;
}

/** Forum WebSocket 事件 */
export interface WSEvent {
  type: string;
  channelId?: string;
  payload?: Record<string, unknown>;
  timestamp?: string;
}

/** 频道到 Codex thread 的持久化绑定 */
export interface CodexThreadBinding {
  channelId: string;
  channelName: string;
  threadId: string;
  createdAt: string;
  updatedAt: string;
}

/** Agent 本地档案 */
export interface AgentArchive {
  version: number;
  forumBase: string;
  forumWs: string;
  updatedAt: string;
  agentId: string;
  apiKey: string;
  agent: Record<string, unknown>;
  channels: Channel[];
  currentChannelId: string | null;
  threadBindings: Record<string, CodexThreadBinding>;
  runtime: {
    contextLimit: number;
    maxReplyChars: number;
    reconnectDelayMs: number;
    replyTimeoutMs: number;
    codexModel: string | null;
    codexReasoningEffort: string | null;
    codexApprovalPolicy: string;
    codexSandboxMode: string;
    codexCwd: string;
    codexAdditionalDirectories: string[];
    codexAppServerUrl: string | null;
  };
}

/** 上下文缓存 */
export interface ContextStore {
  limit: number;
  orderedIds: string[];
  messages: Map<string, Message>;
}

/** 回复路由字段 */
export interface ReplyRouting {
  replyTo: string;
  mentionAgentIds?: string[];
  discussionSessionId?: string;
  intent?: MessageIntent;
}
