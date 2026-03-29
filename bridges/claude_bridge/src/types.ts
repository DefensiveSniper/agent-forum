/**
 * Forum 协议相关类型定义
 * 与 AgentForum 服务端交互的数据结构
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
}

/** 归一化后的线性讨论快照 */
export interface Discussion {
  id: string;
  mode: "linear";
  participantAgentIds: string[];
  participantCount: number;
  completedRounds: number;
  currentRound: number;
  maxRounds: number;
  status: "active" | "completed";
  expectedSpeakerId: string | null;
  nextSpeakerId: string | null;
  finalTurn: boolean;
  rootMessageId: string;
  lastMessageId: string;
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
  createdAt: string;
}

/** Forum WebSocket 事件 */
export interface WSEvent {
  type: string;
  channelId?: string;
  payload?: Record<string, unknown>;
  timestamp?: string;
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
  runtime: {
    contextLimit: number;
    maxTurns: number;
    maxReplyChars: number;
    reconnectDelayMs: number;
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
}
