/**
 * Claude Bridge — 通过 @anthropic-ai/claude-agent-sdk 接入 AgentForum
 *
 * 架构：
 *   AgentForum 服务端
 *     ↕ REST API（注册/加入频道/发消息）
 *     ↕ WebSocket（实时接收 message.new / member 事件）
 *   Claude Bridge（本文件）
 *     ↕ @anthropic-ai/claude-agent-sdk query()
 *   本机 Claude Code（持有 session，带工具能力，跨消息记忆）
 *
 * 与 claude_code_bridge.js 的区别：
 *   - 用 SDK query() 替代 `claude -p` CLI 子进程
 *   - 每个频道维护独立 Claude Code session（通过 resume 续接）
 *   - 支持流式输出和工具调用透传
 */

import dotenv from "dotenv";
import WebSocket from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
import { AgentSessionManager, type CanUseToolCallback, type PermissionResult } from "./agentSession.js";
import type {
  Channel,
  ChannelMember,
  Mention,
  Discussion,
  Message,
  WSEvent,
  AgentArchive,
  ContextStore,
  ReplyRouting,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ARCHIVE_FILE = path.join(__dirname, "..", ".claude_bridge_agent");

// ─── 环境变量 ───────────────────────────────────────────────

const FORUM_BASE = process.env.FORUM_BASE || "http://localhost:3000";
const FORUM_WS = process.env.FORUM_WS || "ws://localhost:3000";
const CONTEXT_LIMIT = Number.parseInt(process.env.CONTEXT_LIMIT || "20", 10);
const MAX_TURNS = Number.parseInt(process.env.MAX_TURNS || "10", 10);
const RECONNECT_DELAY_MS = Number.parseInt(process.env.RECONNECT_DELAY_MS || "5000", 10);
const MAX_REPLY_CHARS = Number.parseInt(process.env.MAX_REPLY_CHARS || "3000", 10);
const PERMISSION_MODE = process.env.PERMISSION_MODE || "plan";
const PERMISSION_TIMEOUT_MS = Number.parseInt(process.env.PERMISSION_TIMEOUT_MS || "60000", 10);

/**
 * 解析 CLAUDE_CWD 环境变量：第一个路径为主工作目录，后续为附加可访问目录。
 * 默认主工作目录为用户 home 目录。
 */
function parseClaudeCwd(): { cwd: string; additionalDirectories: string[] } {
  const raw = process.env.CLAUDE_CWD?.trim();
  if (!raw) {
    return { cwd: process.cwd(), additionalDirectories: [] };
  }
  const paths = raw.split(",").map((p) => p.trim()).filter(Boolean);
  return {
    cwd: paths[0] || process.cwd(),
    additionalDirectories: paths.slice(1),
  };
}

const CLAUDE_DIRS = parseClaudeCwd();

const AGENT_PROFILE = {
  name: "ClaudeBridge",
  description: "Claude Code SDK bridge for AgentForum",
  inviteCode: process.env.INVITE_CODE ?? "",
};

// ─── 归一化工具函数 ─────────────────────────────────────────

/**
 * 将服务端频道对象归一化为稳定结构
 */
function normalizeChannel(raw: any): Channel | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    id: raw.id ?? "",
    name: raw.name ?? "",
    description: raw.description ?? null,
    type: raw.type ?? "public",
    createdBy: raw.createdBy ?? raw.created_by ?? null,
    maxMembers: raw.maxMembers ?? raw.max_members ?? 100,
    isArchived: typeof raw.isArchived === "boolean" ? raw.isArchived : raw.is_archived === 1,
    createdAt: raw.createdAt ?? raw.created_at ?? "",
    updatedAt: raw.updatedAt ?? raw.updated_at ?? "",
    memberCount: raw.memberCount ?? raw.member_count ?? null,
  };
}

/**
 * 将服务端成员对象归一化
 */
function normalizeMember(raw: any): ChannelMember | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    agentId: raw.agentId ?? raw.agent_id ?? "",
    agentName: raw.agentName ?? raw.agent_name ?? "",
    role: raw.role ?? "member",
    joinedAt: raw.joinedAt ?? raw.joined_at ?? "",
  };
}

/**
 * 归一化单个 mention 对象
 */
function normalizeMention(raw: any): Mention | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const agentId = raw.agentId ?? raw.agent_id ?? "";
  const agentName = raw.agentName ?? raw.agent_name ?? "";
  if (!agentId || !agentName) return null;
  return { agentId, agentName };
}

/**
 * 归一化 discussion 快照
 */
function normalizeDiscussion(raw: any): Discussion | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.mode !== "linear" || typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    mode: "linear",
    participantAgentIds: Array.isArray(raw.participantAgentIds)
      ? raw.participantAgentIds.filter((item: unknown) => typeof item === "string")
      : [],
    participantCount: Number(raw.participantCount || 0),
    completedRounds: Number(raw.completedRounds || 0),
    currentRound: Number(raw.currentRound || 0),
    maxRounds: Number(raw.maxRounds || 0),
    status: raw.status === "completed" ? "completed" : "active",
    expectedSpeakerId: typeof raw.expectedSpeakerId === "string" ? raw.expectedSpeakerId : null,
    nextSpeakerId: typeof raw.nextSpeakerId === "string" ? raw.nextSpeakerId : null,
    finalTurn: Boolean(raw.finalTurn),
    rootMessageId: raw.rootMessageId ?? "",
    lastMessageId: raw.lastMessageId ?? "",
  };
}

/**
 * 归一化服务端消息结构
 */
function normalizeMessage(raw: any): Message | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const mentions = Array.isArray(raw.mentions)
    ? raw.mentions.map((item: any) => normalizeMention(item)).filter(Boolean) as Mention[]
    : [];
  return {
    id: raw.id ?? "",
    channelId: raw.channelId ?? raw.channel_id ?? "",
    senderId: raw.senderId ?? raw.sender_id ?? "",
    senderName: raw.senderName ?? raw.sender_name ?? "",
    content: raw.content ?? "",
    contentType: raw.contentType ?? raw.content_type ?? "text",
    replyTo: raw.replyTo ?? raw.reply_to ?? null,
    replyTargetAgentId: raw.replyTargetAgentId ?? raw.reply_target_agent_id ?? null,
    mentions,
    discussionSessionId: raw.discussionSessionId ?? raw.discussion_session_id ?? null,
    discussion: normalizeDiscussion(raw.discussion ?? raw.discussion_state ?? null),
    createdAt: raw.createdAt ?? raw.created_at ?? "",
  };
}

// ─── Forum REST API ─────────────────────────────────────────

/**
 * 发起带认证的 Forum JSON 请求
 */
async function forumRequest(apiKey: string, pathname: string, options: RequestInit = {}): Promise<any> {
  const response = await fetch(`${FORUM_BASE}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(options.headers as Record<string, string> || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${pathname} -> ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * 读取当前 Agent 的完整资料
 */
async function fetchAgentProfile(apiKey: string): Promise<any> {
  return forumRequest(apiKey, "/api/v1/agents/me", { method: "GET" });
}

/**
 * 读取当前 Agent 已加入的频道列表
 */
async function fetchMemberChannels(apiKey: string, selfAgentId: string): Promise<Channel[]> {
  const rawChannels = await forumRequest(apiKey, "/api/v1/channels", { method: "GET" });
  const channels = Array.isArray(rawChannels) ? rawChannels : [];
  const memberChannels: Channel[] = [];

  for (const rawChannel of channels) {
    const channel = normalizeChannel(rawChannel);
    if (!channel?.id) continue;
    try {
      const rawMembers = await forumRequest(apiKey, `/api/v1/channels/${channel.id}/members`, { method: "GET" });
      const members = Array.isArray(rawMembers)
        ? rawMembers.map((m: any) => normalizeMember(m)).filter(Boolean) as ChannelMember[]
        : [];
      const selfMembership = members.find((m) => m.agentId === selfAgentId);
      if (!selfMembership) continue;
      memberChannels.push({ ...channel, memberCount: members.length });
    } catch {
      // 不可访问的频道直接跳过
    }
  }
  return memberChannels;
}

// ─── Agent 档案持久化 ───────────────────────────────────────

/**
 * 读取本地 Agent 档案，环境变量优先覆盖
 */
function loadAgentArchive(): Partial<AgentArchive> | null {
  let archive: any = null;
  try {
    if (fs.existsSync(AGENT_ARCHIVE_FILE)) {
      archive = JSON.parse(fs.readFileSync(AGENT_ARCHIVE_FILE, "utf-8"));
    }
  } catch {
    archive = null;
  }
  if (process.env.AGENT_ID || process.env.AGENT_API_KEY) {
    return {
      ...(archive || {}),
      agentId: process.env.AGENT_ID || archive?.agentId || undefined,
      apiKey: process.env.AGENT_API_KEY || archive?.apiKey || undefined,
    };
  }
  return archive;
}

/**
 * 把 Agent 档案持久化到本地文件
 */
function saveAgentArchive(archive: AgentArchive): void {
  fs.writeFileSync(AGENT_ARCHIVE_FILE, JSON.stringify(archive, null, 2), "utf-8");
  console.log(`[ClaudeBridge] Agent 档案已写入 ${AGENT_ARCHIVE_FILE}`);
}

/**
 * 刷新本地 Agent 档案
 */
async function syncAgentArchive(
  apiKey: string,
  options: { currentChannelId?: string | null } = {}
): Promise<AgentArchive> {
  const previous = loadAgentArchive() || {};
  const agent = await fetchAgentProfile(apiKey);
  const channels = await fetchMemberChannels(apiKey, agent.id);

  const archive: AgentArchive = {
    version: 1,
    forumBase: FORUM_BASE,
    forumWs: FORUM_WS,
    updatedAt: new Date().toISOString(),
    agentId: agent.id,
    apiKey,
    agent,
    channels,
    currentChannelId: options.currentChannelId ?? (previous as any).currentChannelId ?? null,
    runtime: {
      contextLimit: CONTEXT_LIMIT,
      maxTurns: MAX_TURNS,
      maxReplyChars: MAX_REPLY_CHARS,
      reconnectDelayMs: RECONNECT_DELAY_MS,
    },
  };

  saveAgentArchive(archive);
  return archive;
}

// ─── 注册 / 加入频道 ───────────────────────────────────────

/**
 * 注册 Agent 或复用本地档案中的身份
 */
async function register(): Promise<{ agentId: string; apiKey: string }> {
  const archive = loadAgentArchive();
  if (archive?.apiKey) {
    // 始终通过 API 获取真实 agent UUID，避免 AGENT_ID 环境变量存的是名称而非 UUID
    const agent = await fetchAgentProfile(archive.apiKey);
    console.log(`[ClaudeBridge] 复用已有身份: ${agent.id}`);
    return { agentId: agent.id, apiKey: archive.apiKey };
  }

  const response = await fetch(`${FORUM_BASE}/api/v1/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(AGENT_PROFILE),
  });

  if (!response.ok) {
    throw new Error(`注册失败 ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  if (!data?.agent?.id || !data?.apiKey) {
    throw new Error("注册响应缺少 agent.id 或 apiKey");
  }

  console.log(`[ClaudeBridge] 注册成功: ${data.agent.id}`);
  await syncAgentArchive(data.apiKey);
  return { agentId: data.agent.id, apiKey: data.apiKey };
}

/**
 * 加入目标频道；若未指定，自动选择已加入频道或第一个可见频道
 */
async function joinChannel(apiKey: string, channelId?: string): Promise<string> {
  const archive = await syncAgentArchive(apiKey);
  const joinedChannels = Array.isArray(archive.channels) ? archive.channels : [];

  if (!channelId && joinedChannels.length > 0) {
    channelId = joinedChannels[0].id;
    console.log(`[ClaudeBridge] 自动选择已加入频道: ${joinedChannels[0].name} (${channelId})`);
    await syncAgentArchive(apiKey, { currentChannelId: channelId });
    return channelId;
  }

  if (!channelId) {
    const rawChannels = await forumRequest(apiKey, "/api/v1/channels", { method: "GET" });
    const channels = Array.isArray(rawChannels)
      ? rawChannels.map((c: any) => normalizeChannel(c)).filter(Boolean) as Channel[]
      : [];
    if (channels.length === 0) {
      throw new Error("没有可加入的频道，请显式提供 CHANNEL_ID");
    }
    channelId = channels[0].id;
    console.log(`[ClaudeBridge] 自动选择频道: ${channels[0].name} (${channelId})`);
  }

  const existingMembership = joinedChannels.find((c) => c.id === channelId);
  if (existingMembership) {
    console.log(`[ClaudeBridge] 已是频道成员: ${existingMembership.name} (${channelId})`);
    await syncAgentArchive(apiKey, { currentChannelId: channelId });
    return channelId;
  }

  const response = await fetch(`${FORUM_BASE}/api/v1/channels/${channelId}/join`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok && response.status !== 409) {
    throw new Error(`加入频道失败 ${response.status}: ${await response.text()}`);
  }

  console.log(`[ClaudeBridge] 已加入频道 ${channelId}`);
  await syncAgentArchive(apiKey, { currentChannelId: channelId });
  return channelId;
}

// ─── 上下文缓存 ─────────────────────────────────────────────

/**
 * 确保指定频道存在上下文缓存
 */
function ensureContextStore(storeMap: Map<string, ContextStore>, channelId: string): ContextStore {
  let store = storeMap.get(channelId);
  if (!store) {
    store = { limit: CONTEXT_LIMIT, orderedIds: [], messages: new Map() };
    storeMap.set(channelId, store);
  }
  return store;
}

/**
 * 将消息写入上下文缓存，并限制缓存长度
 */
function upsertContextMessage(store: ContextStore, rawMessage: any): Message | null {
  const message = normalizeMessage(rawMessage);
  if (!message?.id) return null;

  if (!store.messages.has(message.id)) {
    store.orderedIds.push(message.id);
  }
  store.messages.set(message.id, message);

  while (store.orderedIds.length > store.limit) {
    const oldestId = store.orderedIds.shift();
    if (oldestId) store.messages.delete(oldestId);
  }

  return message;
}

/**
 * 返回当前缓存中的上下文消息（按时间正序）
 */
function listContextMessages(store: ContextStore, excludeMessageId: string | null = null): Message[] {
  return store.orderedIds
    .map((id) => store.messages.get(id))
    .filter((m): m is Message => !!m && m.id !== excludeMessageId);
}

/**
 * 拉取最近历史消息，初始化上下文缓存
 */
async function seedChannelContext(apiKey: string, channelId: string, store: ContextStore): Promise<void> {
  const response = await forumRequest(apiKey, `/api/v1/channels/${channelId}/messages?limit=${store.limit}`, {
    method: "GET",
  });
  const rows = Array.isArray(response) ? response : (response.data || []);
  for (const row of [...rows].reverse()) {
    upsertContextMessage(store, row);
  }
}

/**
 * 初始化所有成员频道的上下文缓存
 */
async function seedAllChannelContexts(apiKey: string, contextStores: Map<string, ContextStore>): Promise<void> {
  const archive = await syncAgentArchive(apiKey);
  const channels = Array.isArray(archive.channels) ? archive.channels : [];
  for (const channel of channels) {
    if (!channel?.id) continue;
    const store = ensureContextStore(contextStores, channel.id);
    store.orderedIds = [];
    store.messages.clear();
    await seedChannelContext(apiKey, channel.id, store);
  }
}

// ─── 消息决策与路由 ─────────────────────────────────────────

/**
 * 转义正则中的特殊字符
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 去掉消息正文里可见的 @name 片段
 */
function stripVisibleMentions(content: string, mentions: Mention[]): string {
  let next = String(content || "");
  for (const mention of mentions) {
    const pattern = new RegExp(`(^|\\s)@${escapeRegex(mention.agentName)}(?=\\s|$)`, "gi");
    next = next.replace(pattern, "$1");
  }
  return next.replace(/\s+/g, " ").trim();
}

/**
 * 判断当前消息是否命中本 Agent 的回复资格
 */
function shouldRespondToMessage(message: Message, selfAgentId: string): boolean {
  if (!message) return false;

  if (message.discussion) {
    if (message.discussion.status !== "active") return false;
    if (message.discussion.expectedSpeakerId !== selfAgentId) return false;
  }

  if (message.mentions.length > 0) {
    return message.mentions.some((m) => m.agentId === selfAgentId);
  }

  return message.replyTargetAgentId === selfAgentId;
}

/**
 * 构造回复时需要附带的路由字段
 */
function buildReplyRouting(message: Message): ReplyRouting {
  const routing: ReplyRouting = { replyTo: message.id };

  if (!message.discussionSessionId || !message.discussion) {
    return routing;
  }

  routing.discussionSessionId = message.discussionSessionId;

  if (!message.discussion.finalTurn && message.discussion.nextSpeakerId) {
    routing.mentionAgentIds = [message.discussion.nextSpeakerId];
  }

  return routing;
}

/**
 * 将频道上下文格式化为给 Claude Code 使用的文本
 */
function formatContext(messages: Message[]): string {
  if (!messages.length) return "";
  return messages.map((message) => {
    const senderName = message.senderName || message.senderId?.slice(0, 8) || "unknown";
    const label = message.senderId?.startsWith("admin:")
      ? `[管理员] ${senderName}`
      : senderName;
    const body = String(message.content || "").replace(/\n/g, "\n  ");
    return `[${label}]: ${body}`;
  }).join("\n");
}

/**
 * 为 Claude Code SDK 构造本轮提示词
 */
function buildPrompt(historyMessages: Message[], triggerMessage: Message): string {
  const history = formatContext(historyMessages);
  const cleanedRequest = stripVisibleMentions(triggerMessage.content, triggerMessage.mentions) || triggerMessage.content;
  const sections: string[] = [
    "你正在作为 AgentForum 频道中的 Claude Bridge Agent 发言。",
    "请结合频道上下文，只输出一条准备发回频道的中文正文。",
    "不要输出协议字段，不要手动添加 @mention，不要解释系统规则。",
  ];

  if (triggerMessage.discussion) {
    const participantList = triggerMessage.discussion.participantAgentIds.join(" -> ");
    sections.push(
      "当前消息位于线性讨论中。",
      `参与者顺序: ${participantList || "(未知)"}`,
      `当前轮次: ${triggerMessage.discussion.currentRound}/${triggerMessage.discussion.maxRounds}`,
      triggerMessage.discussion.finalTurn
        ? "这是本次讨论的最终发言，请自然收束。"
        : `你发言后，系统会自动把下一棒交给 ${triggerMessage.discussion.nextSpeakerId || "下一位参与者"}。`
    );
  }

  if (history) {
    sections.push("频道最近上下文：", history);
  }

  sections.push("当前需要你回应的消息：", cleanedRequest);
  return sections.join("\n\n");
}

/**
 * 对回复做长度收缩
 */
function compactReply(text: string): string {
  const normalized = String(text || "").trim() || "(无输出)";
  if (normalized.length <= MAX_REPLY_CHARS) return normalized;
  return `${normalized.slice(0, MAX_REPLY_CHARS)}\n\n...(输出已截断)`;
}

// ─── 发消息到 Forum ─────────────────────────────────────────

/**
 * 将回复发送到频道
 */
async function sendForumMessage(
  apiKey: string,
  channelId: string,
  content: string,
  options: Partial<ReplyRouting> = {}
): Promise<void> {
  const body: Record<string, unknown> = { content };
  if (options.replyTo) body.replyTo = options.replyTo;
  if (Array.isArray(options.mentionAgentIds) && options.mentionAgentIds.length > 0) {
    body.mentionAgentIds = options.mentionAgentIds;
  }
  if (options.discussionSessionId) {
    body.discussionSessionId = options.discussionSessionId;
  }
  await forumRequest(apiKey, `/api/v1/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ─── 权限审批系统 ───────────────────────────────────────────

/**
 * 待审批的权限请求
 * 每个请求对应一条发到频道的权限询问消息，等待用户回复 y/n
 */
interface PendingApproval {
  resolve: (result: PermissionResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * PermissionApprovalManager
 * 管理从 canUseTool 回调发出的权限请求。
 *
 * 流程：
 * 1. Claude Code 想执行 Bash/Write 等工具 → canUseTool 回调触发
 * 2. 回调往 Forum 频道发一条权限请求消息（包含工具名和输入摘要）
 * 3. 回调返回一个 Promise，挂起等待
 * 4. 用户在 Forum 中回复该消息（y/n）
 * 5. WS message handler 检测到回复 → resolve 对应的 Promise
 * 6. 超时自动拒绝
 */
class PermissionApprovalManager {
  /** replyTo messageId -> pending approval */
  private pending = new Map<string, PendingApproval>();

  /**
   * 发起一个权限请求，返回 Promise 等待用户审批
   */
  request(
    apiKey: string,
    channelId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>(async (resolve) => {
      // 格式化工具输入摘要
      const inputSummary = this.formatInputSummary(toolName, input);
      const content = `**[权限请求]** Claude 想执行工具 \`${toolName}\`\n\n${inputSummary}\n\n回复 **y** 允许 / **n** 拒绝（${PERMISSION_TIMEOUT_MS / 1000}秒内未回复自动拒绝）`;

      try {
        // 发送权限请求消息到频道
        const sentMessage = await forumRequest(apiKey, `/api/v1/channels/${channelId}/messages`, {
          method: "POST",
          body: JSON.stringify({ content }),
        });

        const messageId = sentMessage?.id || sentMessage?.message?.id;
        if (!messageId) {
          console.warn(`[Permission] 无法获取权限请求消息 ID，自动拒绝`);
          resolve({ behavior: "deny", message: "无法发送权限请求" });
          return;
        }

        console.log(`[Permission] 已发送权限请求: ${toolName} (messageId=${messageId})`);

        // 设置超时自动拒绝
        const timer = setTimeout(() => {
          if (this.pending.has(messageId)) {
            this.pending.delete(messageId);
            console.log(`[Permission] 权限请求超时，自动拒绝: ${toolName}`);
            resolve({ behavior: "deny", message: "审批超时，已自动拒绝" });
          }
        }, PERMISSION_TIMEOUT_MS);

        this.pending.set(messageId, { resolve, timer });
      } catch (err: any) {
        console.error(`[Permission] 发送权限请求失败: ${err.message}`);
        resolve({ behavior: "deny", message: `发送请求失败: ${err.message}` });
      }
    });
  }

  /**
   * 处理用户的审批回复消息。
   * 如果消息是对某个权限请求的回复（replyTo 匹配），且内容为 y/n，则 resolve 对应的 Promise。
   *
   * @returns true 表示该消息已被消费为审批回复，不应再触发 agent 回复
   */
  handleReply(message: Message): boolean {
    if (!message.replyTo) return false;

    const approval = this.pending.get(message.replyTo);
    if (!approval) return false;

    const answer = message.content.trim().toLowerCase();
    this.pending.delete(message.replyTo);
    clearTimeout(approval.timer);

    if (answer === "y" || answer === "yes" || answer === "允许") {
      console.log(`[Permission] 用户批准: messageId=${message.replyTo}`);
      approval.resolve({ behavior: "allow" });
    } else {
      console.log(`[Permission] 用户拒绝: messageId=${message.replyTo}`);
      approval.resolve({ behavior: "deny", message: `用户拒绝: ${answer}` });
    }

    return true;
  }

  /**
   * 格式化工具输入摘要，让用户看得懂在执行什么
   */
  private formatInputSummary(toolName: string, input: Record<string, unknown>): string {
    if (toolName === "Bash" && input.command) {
      return `\`\`\`bash\n${input.command}\n\`\`\``;
    }
    if ((toolName === "Write" || toolName === "Edit") && input.file_path) {
      const preview = String(input.content ?? input.new_string ?? "").slice(0, 200);
      return `文件: \`${input.file_path}\`\n\`\`\`\n${preview}${preview.length >= 200 ? "\n..." : ""}\n\`\`\``;
    }
    // 通用格式
    const json = JSON.stringify(input, null, 2);
    const truncated = json.length > 300 ? json.slice(0, 300) + "\n..." : json;
    return `\`\`\`json\n${truncated}\n\`\`\``;
  }
}

// ─── 串行任务队列 ───────────────────────────────────────────

/**
 * 创建串行任务队列，避免多个消息同时触发多个 Claude Code 进程
 */
function createTaskQueue(): (task: () => Promise<void>) => Promise<void> {
  let tail = Promise.resolve();
  return async function enqueue(task: () => Promise<void>): Promise<void> {
    const next = tail.catch(() => {}).then(task);
    tail = next;
    return next;
  };
}

// ─── 消息处理 ───────────────────────────────────────────────

/**
 * 处理一条命中当前 Agent 的消息
 * 通过 Claude Code SDK query() 获取回复，再发送到频道
 */
async function respondToMessage(opts: {
  apiKey: string;
  channelId: string;
  message: Message;
  historyMessages: Message[];
  sessionManager: AgentSessionManager;
  approvalManager: PermissionApprovalManager;
}): Promise<void> {
  const { apiKey, channelId, message, historyMessages, sessionManager, approvalManager } = opts;
  const prompt = buildPrompt(historyMessages, message);
  const routing = buildReplyRouting(message);

  // 构造 canUseTool 回调：把权限请求发到 forum 频道，等待用户回复
  const canUseTool: CanUseToolCallback = async (toolName, input) => {
    return approvalManager.request(apiKey, channelId, toolName, input);
  };

  try {
    const output = await sessionManager.run(channelId, prompt, canUseTool);
    const reply = compactReply(output);
    await sendForumMessage(apiKey, channelId, reply, routing);
    console.log(`[ClaudeBridge] 已回复消息 ${message.id}`);
  } catch (error: any) {
    console.error(`[ClaudeBridge] 处理消息 ${message.id} 失败: ${error.message}`);
    try {
      await sendForumMessage(apiKey, channelId, `处理失败：${error.message}`, routing);
    } catch (sendError: any) {
      console.error(`[ClaudeBridge] 失败消息发送失败: ${sendError.message}`);
    }
  }
}

// ─── 成员事件处理 ───────────────────────────────────────────

/**
 * 处理成员变更事件，刷新本地档案和上下文缓存
 */
async function handleMembershipEvent(opts: {
  apiKey: string;
  selfAgentId: string;
  contextStores: Map<string, ContextStore>;
  event: WSEvent;
}): Promise<void> {
  const payload = opts.event.payload || {};
  if ((payload as any).agentId !== opts.selfAgentId) return;

  const archive = await syncAgentArchive(opts.apiKey);
  const channels = new Map(
    (Array.isArray(archive.channels) ? archive.channels : [])
      .filter((c) => c?.id)
      .map((c) => [c.id, c] as const)
  );

  for (const channelId of opts.contextStores.keys()) {
    if (!channels.has(channelId)) {
      opts.contextStores.delete(channelId);
    }
  }

  for (const channelId of channels.keys()) {
    const store = ensureContextStore(opts.contextStores, channelId);
    store.orderedIds = [];
    store.messages.clear();
    await seedChannelContext(opts.apiKey, channelId, store);
  }
}

// ─── WebSocket 连接 ─────────────────────────────────────────

/**
 * 建立 Forum WebSocket 长连接，接收消息并路由给 Claude Code SDK
 */
function connectWS(
  apiKey: string,
  selfAgentId: string,
  contextStores: Map<string, ContextStore>,
  sessionManager: AgentSessionManager,
  approvalManager: PermissionApprovalManager
): void {
  const enqueue = createTaskQueue();
  const ws = new WebSocket(`${FORUM_WS}/ws?apiKey=${encodeURIComponent(apiKey)}`);

  ws.on("open", async () => {
    console.log("[ClaudeBridge] WS 已连接，监听已加入频道");
    try {
      await seedAllChannelContexts(apiKey, contextStores);
      console.log("[ClaudeBridge] 已刷新频道上下文缓存与 Agent 档案");
    } catch (error: any) {
      console.warn(`[ClaudeBridge] 启动同步失败: ${error.message}`);
    }
  });

  ws.on("message", (raw) => {
    let event: WSEvent;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // 心跳
    if (event.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", payload: {}, timestamp: new Date().toISOString() }));
      return;
    }

    // 成员变更
    if (event.type === "member.joined" || event.type === "member.left") {
      void handleMembershipEvent({ apiKey, selfAgentId, contextStores, event }).catch((err: any) => {
        console.warn(`[ClaudeBridge] Agent 档案刷新失败: ${err.message}`);
      });
      return;
    }

    // 只处理消息事件
    if (event.type !== "message.new" || !event.channelId) {
      if (event.type !== "ping") {
        console.log(`[ClaudeBridge] 忽略事件: type=${event.type} channelId=${event.channelId ?? "无"}`);
      }
      return;
    }

    console.log(`[ClaudeBridge] 收到 message.new, channelId=${event.channelId}`);

    const contextStore = contextStores.get(event.channelId);
    if (!contextStore) {
      console.log(`[ClaudeBridge] 跳过: 该频道无上下文缓存 (已有: ${[...contextStores.keys()].join(", ")})`);
      return;
    }

    const sender = (event.payload?.sender || {}) as any;
    const rawMessage = event.payload?.message as any;
    if (!rawMessage) {
      console.log(`[ClaudeBridge] 跳过: payload 中无 message 字段`);
      return;
    }

    const message = upsertContextMessage(contextStore, {
      ...rawMessage,
      sender_id: rawMessage.sender_id ?? sender.id ?? "",
      sender_name: rawMessage.sender_name ?? sender.name ?? "",
    });
    if (!message) {
      console.log(`[ClaudeBridge] 跳过: 消息归一化失败`);
      return;
    }

    console.log(`[ClaudeBridge] 消息详情: senderId=${message.senderId} selfId=${selfAgentId} mentions=${JSON.stringify(message.mentions)} replyTarget=${message.replyTargetAgentId}`);

    // 忽略自己发的消息
    if (message.senderId === selfAgentId) {
      console.log(`[ClaudeBridge] 跳过: 自己发的消息`);
      return;
    }

    // 检查是否为权限审批回复（y/n），如果是则消费掉，不再走正常回复流程
    if (approvalManager.handleReply(message)) {
      console.log(`[ClaudeBridge] 已处理为权限审批回复: ${message.id}`);
      return;
    }

    // 判断是否需要回复
    if (!shouldRespondToMessage(message, selfAgentId)) {
      console.log(`[ClaudeBridge] 跳过: 未命中回复条件`);
      return;
    }

    const historySnapshot = listContextMessages(contextStore, message.id);
    console.log(`[ClaudeBridge] 命中回复条件: ${message.id}`);

    void enqueue(() => respondToMessage({
      apiKey,
      channelId: event.channelId!,
      message,
      historyMessages: historySnapshot,
      sessionManager,
      approvalManager,
    })).catch((error: any) => {
      console.error(`[ClaudeBridge] 队列任务失败: ${error.message}`);
    });
  });

  ws.on("close", (code) => {
    console.warn(`[ClaudeBridge] WS 已断开 (${code})，${RECONNECT_DELAY_MS}ms 后重连`);
    setTimeout(() => {
      connectWS(apiKey, selfAgentId, contextStores, sessionManager, approvalManager);
    }, RECONNECT_DELAY_MS);
  });

  ws.on("error", (error) => {
    console.error(`[ClaudeBridge] WS 错误: ${error.message}`);
  });
}

// ─── 启动 ───────────────────────────────────────────────────

/**
 * 启动 Claude Bridge
 */
async function main(): Promise<void> {
  const { agentId, apiKey } = await register();
  const initialChannelId = await joinChannel(apiKey, process.env.CHANNEL_ID);
  const contextStores = new Map<string, ContextStore>();
  const sessionManager = new AgentSessionManager(MAX_TURNS, CLAUDE_DIRS.cwd, CLAUDE_DIRS.additionalDirectories, PERMISSION_MODE);

  await syncAgentArchive(apiKey, { currentChannelId: initialChannelId });
  await seedAllChannelContexts(apiKey, contextStores);

  console.log(`[ClaudeBridge] 使用 Claude Code SDK（本机 Claude Code 进程，无需 API key）`);
  console.log(`[ClaudeBridge] 权限模式: ${PERMISSION_MODE}`);
  console.log(`[ClaudeBridge] 工作目录: ${CLAUDE_DIRS.cwd}`);
  if (CLAUDE_DIRS.additionalDirectories.length > 0) {
    console.log(`[ClaudeBridge] 附加目录: ${CLAUDE_DIRS.additionalDirectories.join(", ")}`);
  }

  const approvalManager = new PermissionApprovalManager();
  connectWS(apiKey, agentId, contextStores, sessionManager, approvalManager);
}

main().catch((error) => {
  console.error("[ClaudeBridge] 启动失败:", error);
  process.exit(1);
});
