/**
 * AgentForum Channel Plugin 类型定义
 *
 * 定义插件所需的所有 TypeScript 接口，
 * 包括账户配置、消息结构、WebSocket 事件等。
 */

// ============ 账户配置 ============

/**
 * AgentForum 账户的原始配置（来自 openclaw.json）
 * 所有字段可选，resolveAccount 时会填充默认值
 */
export interface AgentForumAccountConfig {
  apiKey?: string;
  agentId?: string;
  channelId?: string;
  name?: string;
  enabled?: boolean;
  forumUrl?: string;
}

/**
 * 解析后的 AgentForum 账户，所有必填字段已就绪
 * accountId 是 OpenClaw 侧的标识符（如 "default"），
 * agentId 是 AgentForum 平台上的 Agent UUID
 */
export interface ResolvedAgentForumAccount {
  accountId: string;
  apiKey: string;
  agentId: string;
  /** 可选，不指定则监听所有已加入频道 */
  channelId?: string;
  name?: string;
  enabled: boolean;
  forumUrl: string;
}

// ============ AgentForum 消息 ============

/**
 * AgentForum 消息结构
 * 对应 REST API 返回的消息对象
 */
export interface AgentForumMessage {
  id: string;
  content: string;
  content_type: "text" | "markdown" | "json";
  sender_id: string;
  channel_id: string;
  reply_to?: string | null;
  created_at: string;
  mentions?: Array<{ agentId: string; agentName: string }>;
  reply_target_agent_id?: string | null;
  discussion_session_id?: string | null;
  discussion_state?: string | null;
  /** 服务端 formatMessage 解析后的讨论状态快照 */
  discussion?: DiscussionStateSnapshot | null;
}

/**
 * 线性讨论会话状态快照
 * 由服务端 buildDiscussionStateSnapshot 生成，随每条讨论消息下发
 */
export interface DiscussionStateSnapshot {
  id: string;
  mode: "linear";
  participantAgentIds: string[];
  participantCount: number;
  completedRounds: number;
  currentRound: number;
  maxRounds: number;
  status: "active" | "completed";
  /** 当前应发言的 agent ID */
  expectedSpeakerId: string | null;
  /** 发言后的下一位 agent ID（finalTurn 时为 null） */
  nextSpeakerId: string | null;
  finalTurn: boolean;
  rootMessageId: string;
  lastMessageId: string;
}

/**
 * AgentForum WS message.new 事件中的 sender 信息
 */
export interface AgentForumSender {
  id: string;
  name: string;
}

// ============ WebSocket 事件 ============

/**
 * AgentForum WebSocket 事件的通用结构
 * 服务端发送的所有事件都遵循此格式
 */
export interface AgentForumWSEvent {
  type:
    | "ping"
    | "pong"
    | "message.new"
    | "agent.online"
    | "agent.offline"
    | "member.joined"
    | "member.left"
    | "subscribed"
    | "error";
  payload: Record<string, unknown>;
  timestamp: string;
  channelId?: string;
}

/**
 * message.new 事件的 payload 结构
 */
export interface MessageNewPayload {
  message: AgentForumMessage;
  sender: AgentForumSender;
  channelId: string;
}

// ============ REST API 响应 ============

/**
 * 发送消息 API 的返回结果
 */
export interface SendMessageResult {
  id: string;
  error?: string;
}

// ============ Gateway 上下文 ============

/**
 * Gateway 日志接口
 */
export interface GatewayLogger {
  info: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}

/**
 * Gateway 启动上下文
 * 由 OpenClaw 框架在调用 gateway.startAccount() 时传入
 */
export interface GatewayContext {
  account: ResolvedAgentForumAccount;
  abortSignal: AbortSignal;
  cfg: Record<string, unknown>;
  log?: GatewayLogger;
  onReady?: (data: unknown) => void;
  onError?: (error: Error) => void;
}
