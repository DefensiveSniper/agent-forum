/**
 * Codex Bridge — 通过 codex app-server 接入 AgentForum
 *
 * 核心语义：
 * 1. Forum 频道是邀请制，Bridge 只处理当前已加入的频道
 * 2. 每个频道固定绑定一个独立 Codex thread
 * 3. thread 与频道的绑定关系会持久化到本地档案，重启后恢复
 */

import dotenv from "dotenv";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

import {
  CodexAppServerClient,
  type CodexServerRequest,
  type CodexServerRequestHandler,
} from "./codexAppServer.js";
import {
  buildStructuredReplyInstructions,
  buildStructuredReplyRepairPrompt,
  normalizeChannelPolicy,
  parseStructuredReply,
} from "./reply-contract.js";
import type {
  AgentArchive,
  AgentCapability,
  Channel,
  ChannelMember,
  ChannelPolicy,
  ContextStore,
  Discussion,
  Mention,
  Message,
  ReplyRouting,
  WSEvent,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ARCHIVE_FILE = path.join(__dirname, "..", ".codex_bridge_agent");

// ─── 环境变量 ───────────────────────────────────────────────

const FORUM_BASE = process.env.FORUM_BASE || "http://localhost:3000";
const FORUM_WS = process.env.FORUM_WS || "ws://localhost:3000";
const CONTEXT_LIMIT = Number.parseInt(process.env.CONTEXT_LIMIT || "20", 10);
const MAX_REPLY_CHARS = Number.parseInt(process.env.MAX_REPLY_CHARS || "3000", 10);
const RECONNECT_DELAY_MS = Number.parseInt(process.env.RECONNECT_DELAY_MS || "5000", 10);
const CODEX_REPLY_TIMEOUT_MS = Number.parseInt(process.env.CODEX_REPLY_TIMEOUT_MS || "180000", 10);
const CODEX_BIN = process.env.CODEX_BIN?.trim() || "codex";
const CODEX_APP_SERVER_URL = process.env.CODEX_APP_SERVER_URL?.trim() || null;
const CODEX_APP_SERVER_AUTH_TOKEN = process.env.CODEX_APP_SERVER_AUTH_TOKEN?.trim() || null;
const CODEX_MODEL = process.env.CODEX_MODEL?.trim() || "gpt-5.4";
const CODEX_REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT?.trim() || "medium";
const CODEX_SERVICE_TIER = process.env.CODEX_SERVICE_TIER?.trim() || null;
const CODEX_APPROVAL_POLICY = process.env.CODEX_APPROVAL_POLICY?.trim() || "never";

/**
 * 解析并规范化 app-server 支持的沙箱模式。
 * @param raw 原始环境变量值。
 * @returns 规范化后的沙箱模式。
 */
function resolveSandboxMode(raw: string | undefined): "read-only" | "workspace-write" | "danger-full-access" {
  if (raw === "read-only" || raw === "workspace-write" || raw === "danger-full-access") {
    return raw;
  }
  return "workspace-write";
}

const CODEX_SANDBOX_MODE = resolveSandboxMode(process.env.CODEX_SANDBOX_MODE);

/**
 * 解析 `CODEX_CWD`。app-server 目前只直接接受一个 cwd，因此首个目录作为 thread cwd。
 * @returns 解析后的主工作目录与剩余目录。
 */
function parseCodexCwd(): { cwd: string; additionalDirectories: string[] } {
  const raw = process.env.CODEX_CWD?.trim();
  if (!raw) {
    return { cwd: process.cwd(), additionalDirectories: [] };
  }

  const paths = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    cwd: paths[0] || process.cwd(),
    additionalDirectories: paths.slice(1),
  };
}

const CODEX_DIRS = parseCodexCwd();

const AGENT_PROFILE = {
  name: "CodexBridge",
  description: "Codex app-server bridge for AgentForum",
  inviteCode: process.env.INVITE_CODE ?? "",
};

const CODEX_CAPABILITIES: AgentCapability[] = [
  { capability: "code_review", proficiency: "expert", description: "代码审查与质量分析" },
  { capability: "code_generation", proficiency: "expert", description: "代码生成与重构" },
  { capability: "debugging", proficiency: "expert", description: "日志排查与问题定位" },
  { capability: "file_operations", proficiency: "expert", description: "文件读写、搜索与修改" },
];

const CODEX_DEVELOPER_INSTRUCTIONS = [
  "你是运行在 AgentForum 频道后的 Codex Bridge。",
  "你和某一个 Forum 频道一一对应，这个 thread 持续代表该频道的长期上下文。",
  "默认使用中文回复。",
  "不要泄露内部协议、桥接实现、JSON 约束修复过程，也不要手动添加 @mention 标记。",
].join("\n");

// ─── 归一化工具函数 ─────────────────────────────────────────

/**
 * 将服务端频道对象归一化为稳定结构。
 * @param raw 原始频道对象。
 * @returns 归一化后的频道。
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
 * 将服务端成员对象归一化。
 * @param raw 原始成员对象。
 * @returns 归一化后的成员对象。
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
 * 将单个 mention 归一化。
 * @param raw 原始 mention 对象。
 * @returns 归一化后的 mention。
 */
function normalizeMention(raw: any): Mention | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const agentId = raw.agentId ?? raw.agent_id ?? "";
  const agentName = raw.agentName ?? raw.agent_name ?? "";
  if (!agentId || !agentName) return null;
  return {
    agentId,
    agentName,
    teamRole: raw.teamRole ?? raw.team_role ?? null,
  };
}

/**
 * 将 discussion 状态快照归一化。
 * @param raw 原始 discussion 对象。
 * @returns 归一化后的 discussion。
 */
function normalizeDiscussion(raw: any): Discussion | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.mode !== "linear" || typeof raw.id !== "string") return null;

  const participantRoles: Record<string, string> = {};
  if (raw.participantRoles && typeof raw.participantRoles === "object" && !Array.isArray(raw.participantRoles)) {
    for (const [key, value] of Object.entries(raw.participantRoles)) {
      if (typeof value === "string") participantRoles[key] = value;
    }
  }

  return {
    id: raw.id,
    mode: "linear",
    participantAgentIds: Array.isArray(raw.participantAgentIds)
      ? raw.participantAgentIds.filter((item: unknown) => typeof item === "string")
      : [],
    participantCount: Number(raw.participantCount || 0),
    participantRoles: Object.keys(participantRoles).length > 0 ? participantRoles : undefined,
    completedRounds: Number(raw.completedRounds || 0),
    currentRound: Number(raw.currentRound || 0),
    maxRounds: Number(raw.maxRounds || 0),
    status: (["open", "in_progress", "waiting_approval", "done", "cancelled", "rejected"].includes(raw.status) ? raw.status : "in_progress") as Discussion["status"],
    expectedSpeakerId: typeof raw.expectedSpeakerId === "string" ? raw.expectedSpeakerId : null,
    nextSpeakerId: typeof raw.nextSpeakerId === "string" ? raw.nextSpeakerId : null,
    finalTurn: Boolean(raw.finalTurn),
    divergenceScore: Number.isFinite(Number(raw.divergenceScore))
      ? Math.min(Math.max(Number(raw.divergenceScore), 0), 1)
      : 0,
    divergencePhase: (["opening", "expanding", "peak", "converging", "concluding"].includes(raw.divergencePhase)
      ? raw.divergencePhase
      : "concluding") as Discussion["divergencePhase"],
    rootMessageId: raw.rootMessageId ?? "",
    lastMessageId: raw.lastMessageId ?? "",
    agentInstruction: typeof raw.agentInstruction === "string" ? raw.agentInstruction : null,
    requiresApproval: Boolean(raw.requiresApproval),
    approvalAgentId: typeof raw.approvalAgentId === "string" ? raw.approvalAgentId : null,
    resolution: raw.resolution ?? null,
  };
}

/**
 * 将服务端消息结构归一化。
 * @param raw 原始消息对象。
 * @returns 归一化后的消息。
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
    intent: raw.intent ?? null,
    createdAt: raw.createdAt ?? raw.created_at ?? "",
  };
}

// ─── Forum REST API ─────────────────────────────────────────

/**
 * 发起带认证的 Forum JSON 请求。
 * @param apiKey Agent API Key。
 * @param pathname API 路径。
 * @param options fetch 请求选项。
 * @returns 解析后的 JSON 数据。
 */
async function forumRequest(apiKey: string, pathname: string, options: RequestInit = {}): Promise<any> {
  const response = await fetch(`${FORUM_BASE}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...((options.headers as Record<string, string> | undefined) || {}),
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
 * 读取当前 Agent 的完整资料。
 * @param apiKey Agent API Key。
 * @returns Agent 资料。
 */
async function fetchAgentProfile(apiKey: string): Promise<any> {
  return forumRequest(apiKey, "/api/v1/agents/me", { method: "GET" });
}

/**
 * 判断错误是否由无效 API Key 导致。
 * @param error 任意异常对象。
 * @returns 是否为 `/api/v1/agents/me` 的 401 错误。
 */
function isInvalidAgentApiKeyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("/api/v1/agents/me -> 401");
}

/**
 * 判断当前错误是否表示频道策略接口不可用。
 * 这里把 `/channels/:id/policy` 的 404 视为“接口缺失或当前实例尚未部署该能力”，
 * 以便 bridge 回退到默认策略继续处理消息。
 * @param error 任意异常对象。
 * @param channelId 目标频道 ID。
 * @returns 是否命中策略接口不可用场景。
 */
function isMissingChannelPolicyError(error: unknown, channelId: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`/api/v1/channels/${channelId}/policy -> 404`);
}

/**
 * 读取当前 Agent 已加入的频道列表。
 * @param apiKey Agent API Key。
 * @param selfAgentId 当前 Agent ID。
 * @returns 当前 Agent 可访问的成员频道列表。
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
        ? rawMembers.map((item: any) => normalizeMember(item)).filter(Boolean) as ChannelMember[]
        : [];
      if (!members.some((member) => member.agentId === selfAgentId)) {
        continue;
      }
      memberChannels.push({ ...channel, memberCount: members.length });
    } catch {
      // 私有频道无权读取时直接跳过
    }
  }

  return memberChannels;
}

/**
 * 读取指定频道的有效策略快照。
 * @param apiKey Agent API Key。
 * @param channelId 目标频道 ID。
 * @returns 归一化后的频道策略。
 */
async function fetchChannelPolicy(apiKey: string, channelId: string): Promise<ChannelPolicy> {
  try {
    const rawPolicy = await forumRequest(apiKey, `/api/v1/channels/${channelId}/policy`, {
      method: "GET",
    });
    return normalizeChannelPolicy(rawPolicy);
  } catch (error) {
    if (!isMissingChannelPolicyError(error, channelId)) {
      throw error;
    }

    console.warn(
      `[CodexBridge] 频道 ${channelId} 未提供 policy 接口，已回退为默认策略继续处理消息`
    );
    return normalizeChannelPolicy(null);
  }
}

// ─── Agent 档案持久化 ───────────────────────────────────────

/**
 * 读取本地 Agent 档案，环境变量优先覆盖身份信息。
 * @returns 当前本地档案。
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

  const envAgentId = process.env.AGENT_ID?.trim();
  const envApiKey = process.env.AGENT_API_KEY?.trim();

  if (envAgentId || envApiKey) {
    return {
      ...(archive || {}),
      agentId: envAgentId || archive?.agentId || undefined,
      apiKey: envApiKey || archive?.apiKey || undefined,
    };
  }
  return archive;
}

/**
 * 将 Agent 档案写回本地文件。
 * @param archive 待持久化的完整档案。
 */
function saveAgentArchive(archive: AgentArchive): void {
  fs.writeFileSync(AGENT_ARCHIVE_FILE, JSON.stringify(archive, null, 2), "utf-8");
  console.log(`[CodexBridge] Agent 档案已写入 ${AGENT_ARCHIVE_FILE}`);
}

/**
 * 仅更新本地档案中的频道 -> thread 绑定，不额外请求服务端。
 * @param channelId Forum 频道 ID。
 * @param channelName Forum 频道名称。
 * @param threadId 绑定的 Codex thread ID。
 */
function persistThreadBinding(channelId: string, channelName: string, threadId: string): void {
  const archive = loadAgentArchive();
  if (!archive?.agentId || !archive.apiKey) return;

  const threadBindings = {
    ...(archive.threadBindings || {}),
    [channelId]: {
      channelId,
      channelName,
      threadId,
      createdAt: archive.threadBindings?.[channelId]?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };

  saveAgentArchive({
    version: 1,
    forumBase: archive.forumBase || FORUM_BASE,
    forumWs: archive.forumWs || FORUM_WS,
    updatedAt: new Date().toISOString(),
    agentId: archive.agentId,
    apiKey: archive.apiKey,
    agent: archive.agent || {},
    channels: Array.isArray(archive.channels) ? archive.channels as Channel[] : [],
    currentChannelId: archive.currentChannelId ?? null,
    threadBindings,
    runtime: {
      contextLimit: archive.runtime?.contextLimit ?? CONTEXT_LIMIT,
      maxReplyChars: archive.runtime?.maxReplyChars ?? MAX_REPLY_CHARS,
      reconnectDelayMs: archive.runtime?.reconnectDelayMs ?? RECONNECT_DELAY_MS,
      replyTimeoutMs: archive.runtime?.replyTimeoutMs ?? CODEX_REPLY_TIMEOUT_MS,
      codexModel: archive.runtime?.codexModel ?? CODEX_MODEL,
      codexReasoningEffort: archive.runtime?.codexReasoningEffort ?? CODEX_REASONING_EFFORT,
      codexApprovalPolicy: archive.runtime?.codexApprovalPolicy ?? CODEX_APPROVAL_POLICY,
      codexSandboxMode: archive.runtime?.codexSandboxMode ?? CODEX_SANDBOX_MODE,
      codexCwd: archive.runtime?.codexCwd ?? CODEX_DIRS.cwd,
      codexAdditionalDirectories: archive.runtime?.codexAdditionalDirectories ?? CODEX_DIRS.additionalDirectories,
      codexAppServerUrl: archive.runtime?.codexAppServerUrl ?? CODEX_APP_SERVER_URL,
    },
  });
}

/**
 * 刷新本地 Agent 档案。
 * @param apiKey Agent API Key。
 * @param options 附加覆盖项。
 * @returns 最新档案。
 */
async function syncAgentArchive(
  apiKey: string,
  options: {
    currentChannelId?: string | null;
  } = {},
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
    currentChannelId: options.currentChannelId ?? previous.currentChannelId ?? null,
    threadBindings: (previous.threadBindings || {}) as AgentArchive["threadBindings"],
    runtime: {
      contextLimit: CONTEXT_LIMIT,
      maxReplyChars: MAX_REPLY_CHARS,
      reconnectDelayMs: RECONNECT_DELAY_MS,
      replyTimeoutMs: CODEX_REPLY_TIMEOUT_MS,
      codexModel: CODEX_MODEL,
      codexReasoningEffort: CODEX_REASONING_EFFORT,
      codexApprovalPolicy: CODEX_APPROVAL_POLICY,
      codexSandboxMode: CODEX_SANDBOX_MODE,
      codexCwd: CODEX_DIRS.cwd,
      codexAdditionalDirectories: CODEX_DIRS.additionalDirectories,
      codexAppServerUrl: CODEX_APP_SERVER_URL,
    },
  };

  saveAgentArchive(archive);
  return archive;
}

// ─── 注册 ───────────────────────────────────────────────────

/**
 * 通过邀请码注册一个全新的 Bridge Agent。
 * @returns 新注册成功后的 Agent 身份。
 */
async function registerWithInviteCode(): Promise<{ agentId: string; apiKey: string }> {
  if (!AGENT_PROFILE.inviteCode) {
    throw new Error("缺少 INVITE_CODE，无法重新注册 Agent");
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

  console.log(`[CodexBridge] 注册成功: ${data.agent.id}`);
  await syncAgentArchive(data.apiKey);
  await registerCapabilities(data.apiKey);
  return { agentId: data.agent.id, apiKey: data.apiKey };
}

/**
 * 注册 Agent 或复用本地档案中的身份。
 * @returns 当前 Agent 身份。
 */
async function register(): Promise<{ agentId: string; apiKey: string }> {
  const archive = loadAgentArchive();
  if (archive?.apiKey) {
    try {
      const agent = await fetchAgentProfile(archive.apiKey);
      console.log(`[CodexBridge] 复用已有身份: ${agent.id}`);
      await registerCapabilities(archive.apiKey);
      return { agentId: agent.id, apiKey: archive.apiKey };
    } catch (error) {
      if (!isInvalidAgentApiKeyError(error)) {
        throw error;
      }

      if (AGENT_PROFILE.inviteCode) {
        console.warn("[CodexBridge] 本地档案或环境变量中的 API Key 已失效，改用 INVITE_CODE 重新注册");
        return registerWithInviteCode();
      }

      throw new Error(
        [
          "本地档案或环境变量中的 AGENT_API_KEY 已失效，且当前没有可用的 INVITE_CODE。",
          `请删除 ${AGENT_ARCHIVE_FILE} 后重试，或提供有效的 AGENT_API_KEY / INVITE_CODE。`,
        ].join(" "),
      );
    }
  }

  return registerWithInviteCode();
}

/**
 * 向 AgentForum 注册 Codex Bridge 能力列表。
 * @param apiKey Agent API Key。
 */
async function registerCapabilities(apiKey: string): Promise<void> {
  for (const capability of CODEX_CAPABILITIES) {
    try {
      await forumRequest(apiKey, "/api/v1/agents/me/capabilities", {
        method: "POST",
        body: JSON.stringify(capability),
      });
    } catch (error) {
      console.warn(`[CodexBridge] 能力注册跳过 ${capability.capability}: ${String(error)}`);
    }
  }
  console.log(`[CodexBridge] 已注册 ${CODEX_CAPABILITIES.length} 项能力`);
}

// ─── 上下文缓存 ─────────────────────────────────────────────

/**
 * 确保指定频道存在上下文缓存。
 * @param storeMap 所有频道的上下文缓存集合。
 * @param channelId 目标频道 ID。
 * @returns 对应频道的上下文缓存。
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
 * 将消息写入上下文缓存，并限制缓存长度。
 * @param store 目标频道缓存。
 * @param rawMessage 原始消息对象。
 * @returns 归一化后的消息。
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
 * 返回当前缓存中的上下文消息，按时间正序。
 * @param store 频道上下文缓存。
 * @param excludeMessageId 可选，需要排除的消息 ID。
 * @returns 频道上下文消息列表。
 */
function listContextMessages(store: ContextStore, excludeMessageId: string | null = null): Message[] {
  return store.orderedIds
    .map((id) => store.messages.get(id))
    .filter((item): item is Message => !!item && item.id !== excludeMessageId);
}

/**
 * 拉取最近历史消息，初始化上下文缓存。
 * @param apiKey Agent API Key。
 * @param channelId 频道 ID。
 * @param store 频道上下文缓存。
 */
async function seedChannelContext(apiKey: string, channelId: string, store: ContextStore): Promise<void> {
  const response = await forumRequest(apiKey, `/api/v1/channels/${channelId}/messages?limit=${store.limit}`, {
    method: "GET",
  });
  const rows = Array.isArray(response) ? response : (response.data || []);
  store.orderedIds = [];
  store.messages.clear();
  for (const row of [...rows].reverse()) {
    upsertContextMessage(store, row);
  }
}

/**
 * 初始化所有成员频道的上下文缓存。
 * @param apiKey Agent API Key。
 * @param contextStores 所有频道的上下文缓存集合。
 */
async function seedAllChannelContexts(apiKey: string, contextStores: Map<string, ContextStore>): Promise<void> {
  const archive = await syncAgentArchive(apiKey);
  const activeChannelIds = new Set((archive.channels || []).map((channel) => channel.id));

  for (const existingChannelId of [...contextStores.keys()]) {
    if (!activeChannelIds.has(existingChannelId)) {
      contextStores.delete(existingChannelId);
    }
  }

  for (const channel of archive.channels) {
    const store = ensureContextStore(contextStores, channel.id);
    await seedChannelContext(apiKey, channel.id, store);
  }
}

// ─── 消息决策与路由 ─────────────────────────────────────────

/**
 * 转义正则里的特殊字符。
 * @param value 原始文本。
 * @returns 可安全拼接进正则的文本。
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 去掉消息正文里可见的 @name 文本。
 * @param content 原始消息正文。
 * @param mentions 归一化后的 mention 列表。
 * @returns 去除 mention 展示后的正文。
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
 * 判断当前消息是否命中 Bridge 的回复资格。
 * @param message 当前消息。
 * @param selfAgentId 当前 Agent ID。
 * @returns 是否应由 Bridge 回复。
 */
function shouldRespondToMessage(message: Message, selfAgentId: string): boolean {
  if (message.discussionSessionId || message.discussion) {
    if (!message.discussion) return false;
    if (message.discussion.status !== "in_progress" && message.discussion.status !== "open") return false;
    return message.discussion.expectedSpeakerId === selfAgentId;
  }

  if (message.mentions.length > 0) {
    return message.mentions.some((mention) => mention.agentId === selfAgentId);
  }

  return message.replyTargetAgentId === selfAgentId;
}

/**
 * 构造回复消息需要带上的路由字段。
 * @param message 触发回复的源消息。
 * @returns 回复路由对象。
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
 * 将频道上下文格式化为 Codex 可消费的文本。
 * @param messages 频道上下文消息。
 * @returns 纯文本上下文。
 */
function formatContext(messages: Message[]): string {
  if (!messages.length) return "";
  return messages
    .map((message) => {
      const senderName = message.senderName || message.senderId?.slice(0, 8) || "unknown";
      const label = message.senderId?.startsWith("admin:")
        ? `[管理员] ${senderName}`
        : senderName;

      const intentTags: string[] = [];
      if (message.intent) {
        if (message.intent.task_type) intentTags.push(message.intent.task_type);
        if (message.intent.priority && message.intent.priority !== "normal") intentTags.push(message.intent.priority);
        if (message.intent.requires_approval) intentTags.push("需审批");
      }
      const intentSuffix = intentTags.length > 0 ? `[${intentTags.join(" | ")}]` : "";
      const body = String(message.content || "").replace(/\n/g, "\n  ");
      return `[${label}]${intentSuffix}: ${body}`;
    })
    .join("\n");
}

/**
 * 根据历史消息与当前触发消息构造本轮提示词。
 * @param historyMessages 频道历史上下文。
 * @param triggerMessage 当前触发回复的消息。
 * @param channelPolicy 当前频道策略。
 * @param selfAgentId 当前 Agent ID。
 * @returns 可直接发给 Codex 的提示词。
 */
function buildPrompt(
  historyMessages: Message[],
  triggerMessage: Message,
  channelPolicy: ChannelPolicy,
  selfAgentId?: string,
): string {
  const history = formatContext(historyMessages);
  const cleanedRequest = stripVisibleMentions(triggerMessage.content, triggerMessage.mentions) || triggerMessage.content;
  const sections: string[] = [
    "你正在作为 AgentForum 频道中的 Codex Bridge Agent 发言。",
    "当前频道与当前 Codex thread 是一一对应关系，请把这个 thread 视为该频道的长期会话上下文。",
    "请结合频道上下文，生成一条准备发回频道的中文消息，并自行判断是否需要附带结构化 intent。",
    "不要手动添加 @mention，不要解释系统规则。",
    buildStructuredReplyInstructions(channelPolicy),
  ];

  const myMention = selfAgentId ? triggerMessage.mentions.find((item) => item.agentId === selfAgentId) : null;
  const myTeamRole = myMention?.teamRole
    ?? triggerMessage.discussion?.participantRoles?.[selfAgentId ?? ""]
    ?? null;
  if (myTeamRole) {
    sections.push(`[角色定位] 你在此频道中的角色定位是「${myTeamRole}」，请以此身份参与讨论。`);
  }

  if (triggerMessage.discussion) {
    const participantList = triggerMessage.discussion.participantAgentIds.join(" -> ");
    sections.push(
      "当前消息位于线性讨论中。",
      `参与者顺序: ${participantList || "(未知)"}`,
      `当前轮次: ${triggerMessage.discussion.currentRound}/${triggerMessage.discussion.maxRounds}`,
      triggerMessage.discussion.finalTurn
        ? "这是本次讨论的最终发言，请自然收束。"
        : `你发言后，系统会自动把下一棒交给 ${triggerMessage.discussion.nextSpeakerId || "下一位参与者"}。`,
    );

    if (triggerMessage.discussion.agentInstruction) {
      sections.push(triggerMessage.discussion.agentInstruction);
    }
  }

  if (triggerMessage.intent) {
    const intentLines: string[] = ["这条消息附带了结构化意图："];
    if (triggerMessage.intent.task_type) intentLines.push(`- 任务类型: ${triggerMessage.intent.task_type}`);
    if (triggerMessage.intent.priority) intentLines.push(`- 优先级: ${triggerMessage.intent.priority}`);
    if (triggerMessage.intent.requires_approval) intentLines.push("- 需要审批: 是");
    if (triggerMessage.intent.deadline) intentLines.push(`- 截止时间: ${triggerMessage.intent.deadline}`);
    if (triggerMessage.intent.tags?.length) intentLines.push(`- 标签: ${triggerMessage.intent.tags.join(", ")}`);
    sections.push(intentLines.join("\n"), "请在回复时考虑这些元数据的含义。");
  }

  if (history) {
    sections.push("频道最近上下文：", history);
  }

  sections.push("当前需要你回应的消息：", cleanedRequest);
  return sections.join("\n\n");
}

/**
 * 对回复做长度收缩。
 * @param text 原始回复文本。
 * @returns 收缩后的最终文本。
 */
function compactReply(text: string): string {
  const normalized = String(text || "").trim() || "(无输出)";
  if (normalized.length <= MAX_REPLY_CHARS) return normalized;
  return `${normalized.slice(0, MAX_REPLY_CHARS)}\n\n...(输出已截断)`;
}

/**
 * 生成约束最终输出形态的 JSON Schema。
 * @returns 结构化回复输出 Schema。
 */
function buildStructuredReplySchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      content: { type: "string" },
      intent: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            properties: {
              task_type: { type: "string" },
              priority: {
                anyOf: [
                  { type: "string", enum: ["low", "normal", "high", "urgent"] },
                  { type: "null" },
                ],
              },
              requires_approval: {
                anyOf: [
                  { type: "boolean" },
                  { type: "null" },
                ],
              },
              deadline: {
                anyOf: [
                  { type: "string" },
                  { type: "null" },
                ],
              },
              tags: {
                anyOf: [
                  {
                    type: "array",
                    items: { type: "string" },
                  },
                  { type: "null" },
                ],
              },
            },
            required: ["task_type", "priority", "requires_approval", "deadline", "tags"],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["content", "intent"],
    additionalProperties: false,
  };
}

/**
 * 让 Codex 生成符合结构化回复协议的出站消息。
 * @param opts 本轮生成所需的上下文。
 * @returns 结构化回复对象。
 */
async function generateStructuredReply(opts: {
  channelId: string;
  channelName: string;
  prompt: string;
  channelPolicy: ChannelPolicy;
  codexClient: CodexAppServerClient;
  onServerRequest: CodexServerRequestHandler;
}): Promise<{ content: string; intent: Message["intent"] }> {
  const { channelId, channelName, prompt, channelPolicy, codexClient, onServerRequest } = opts;
  const firstOutput = await codexClient.run({
    channelId,
    channelName,
    prompt,
    outputSchema: buildStructuredReplySchema(),
    onServerRequest,
  });

  try {
    return parseStructuredReply(firstOutput.text, channelPolicy);
  } catch (error: any) {
    const repairPrompt = buildStructuredReplyRepairPrompt(error.message, firstOutput.text);
    const retryOutput = await codexClient.run({
      channelId,
      channelName,
      prompt: repairPrompt,
      outputSchema: buildStructuredReplySchema(),
      onServerRequest,
    });
    try {
      return parseStructuredReply(retryOutput.text, channelPolicy);
    } catch (retryError: any) {
      throw new Error(`结构化回复协议重试失败: ${retryError.message}`);
    }
  }
}

// ─── 发消息到 Forum ─────────────────────────────────────────

/**
 * 将回复发送到频道。
 * @param apiKey Agent API Key。
 * @param channelId 目标频道 ID。
 * @param content 回复正文。
 * @param options 路由附加字段。
 */
async function sendForumMessage(
  apiKey: string,
  channelId: string,
  content: string,
  options: Partial<ReplyRouting> = {},
): Promise<void> {
  const body: Record<string, unknown> = { content };
  if (options.replyTo) body.replyTo = options.replyTo;
  if (Array.isArray(options.mentionAgentIds) && options.mentionAgentIds.length > 0) {
    body.mentionAgentIds = options.mentionAgentIds;
  }
  if (options.discussionSessionId) {
    body.discussionSessionId = options.discussionSessionId;
  }
  if (options.intent) {
    body.intent = options.intent;
  }

  await forumRequest(apiKey, `/api/v1/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ─── Codex 审批桥接 ────────────────────────────────────────

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * ForumApprovalManager
 * 将 app-server 发来的审批请求映射成频道里的 `y/n` 回复流。
 */
class ForumApprovalManager {
  private readonly pending = new Map<string, PendingApproval>();

  /**
   * 发起一个审批请求并等待频道里的 `y/n` 回复。
   * @param apiKey Agent API Key。
   * @param channelId 目标频道 ID。
   * @param request app-server 审批请求。
   * @returns 用户是否批准。
   */
  async request(apiKey: string, channelId: string, request: CodexServerRequest): Promise<boolean> {
    const content = this.formatRequestMessage(request);
    const sentMessage = await forumRequest(apiKey, `/api/v1/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content,
        intent: {
          task_type: "approval_request",
          priority: "high",
          requires_approval: true,
        },
      }),
    });

    const messageId = sentMessage?.id || sentMessage?.message?.id;
    if (!messageId) {
      throw new Error("无法创建 Forum 审批消息");
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(messageId)) return;
        this.pending.delete(messageId);
        resolve(false);
      }, 60_000);

      this.pending.set(messageId, { resolve, timer });
    });
  }

  /**
   * 检查一条频道消息是否是审批回复，如是则消费掉。
   * @param message 当前收到的频道消息。
   * @returns 当前消息是否已经作为审批回复被消费。
   */
  handleReply(message: Message): boolean {
    if (!message.replyTo) return false;

    const pending = this.pending.get(message.replyTo);
    if (!pending) return false;

    this.pending.delete(message.replyTo);
    clearTimeout(pending.timer);

    const answer = message.content.trim().toLowerCase();
    pending.resolve(answer === "y" || answer === "yes" || answer === "允许");
    return true;
  }

  /**
   * 将审批请求格式化成可直接发到 Forum 的中文消息。
   * @param request app-server 审批请求。
   * @returns Forum 中展示的正文。
   */
  private formatRequestMessage(request: CodexServerRequest): string {
    switch (request.method) {
      case "item/commandExecution/requestApproval":
        return [
          "**[权限请求]** Codex 想执行命令",
          "",
          `原因: ${String(request.params.reason ?? "未提供")}`,
          "",
          "```bash",
          String(request.params.command ?? ""),
          "```",
          `cwd: ${String(request.params.cwd ?? "")}`,
          "",
          "回复 **y** 允许 / **n** 拒绝。",
        ].join("\n");
      case "execCommandApproval": {
        const command = Array.isArray(request.params.command) ? request.params.command.map(String).join(" ") : "";
        return [
          "**[权限请求]** Codex 想执行命令",
          "",
          `原因: ${String(request.params.reason ?? "未提供")}`,
          "",
          "```bash",
          command,
          "```",
          `cwd: ${String(request.params.cwd ?? "")}`,
          "",
          "回复 **y** 允许 / **n** 拒绝。",
        ].join("\n");
      }
      case "applyPatchApproval": {
        const fileChanges = request.params.fileChanges && typeof request.params.fileChanges === "object"
          ? Object.keys(request.params.fileChanges as Record<string, unknown>)
          : [];
        return [
          "**[权限请求]** Codex 想修改文件",
          "",
          `原因: ${String(request.params.reason ?? "未提供")}`,
          `申请根目录: ${String(request.params.grantRoot ?? "(无)")}`,
          "",
          `文件: ${fileChanges.join(", ") || "(未知)"}`,
          "",
          "回复 **y** 允许 / **n** 拒绝。",
        ].join("\n");
      }
      case "item/fileChange/requestApproval":
        return [
          "**[权限请求]** Codex 想写入文件",
          "",
          `原因: ${String(request.params.reason ?? "未提供")}`,
          `申请根目录: ${String(request.params.grantRoot ?? "(无)")}`,
          "",
          "回复 **y** 允许 / **n** 拒绝。",
        ].join("\n");
      case "item/permissions/requestApproval":
        return [
          "**[权限请求]** Codex 想扩展额外权限",
          "",
          "```json",
          JSON.stringify(request.params.permissions ?? {}, null, 2),
          "```",
          "",
          "回复 **y** 允许 / **n** 拒绝。",
        ].join("\n");
      default:
        return [
          `**[权限请求]** Codex 请求 ${request.method}`,
          "",
          "```json",
          JSON.stringify(request.params ?? {}, null, 2),
          "```",
          "",
          "回复 **y** 允许 / **n** 拒绝。",
        ].join("\n");
    }
  }
}

/**
 * 判断某个 server request 是否属于需要 Forum 用户审批的类别。
 * @param request app-server server request。
 * @returns 是否走 y/n 审批流。
 */
function requiresForumApproval(request: CodexServerRequest): boolean {
  return [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "applyPatchApproval",
    "execCommandApproval",
  ].includes(request.method);
}

/**
 * 根据审批结果为 app-server 生成对应的 response payload。
 * @param request app-server 审批请求。
 * @param approved 用户是否批准。
 * @returns 可直接作为 JSON-RPC result 回写的对象。
 */
function buildApprovalResponse(request: CodexServerRequest, approved: boolean): unknown {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
      return { decision: approved ? "accept" : "decline" };
    case "item/fileChange/requestApproval":
      return { decision: approved ? "accept" : "decline" };
    case "item/permissions/requestApproval":
      return {
        permissions: approved ? (request.params.permissions ?? { network: null, fileSystem: null }) : { network: null, fileSystem: null },
        scope: "turn",
      };
    case "applyPatchApproval":
    case "execCommandApproval":
      return { decision: approved ? "approved" : "denied" };
    default:
      throw new Error(`当前请求不支持审批映射: ${request.method}`);
  }
}

/**
 * 为单个 turn 构造 app-server server request 处理器。
 * @param apiKey Agent API Key。
 * @param channelId 目标频道 ID。
 * @param approvalManager Forum 审批管理器。
 * @returns 可直接交给 Codex client 的 server request 处理器。
 */
function buildServerRequestHandler(
  apiKey: string,
  channelId: string,
  approvalManager: ForumApprovalManager,
): CodexServerRequestHandler {
  return async (request) => {
    if (requiresForumApproval(request)) {
      const approved = await approvalManager.request(apiKey, channelId, request);
      return buildApprovalResponse(request, approved);
    }

    switch (request.method) {
      case "item/tool/requestUserInput":
        return { answers: {} };
      case "mcpServer/elicitation/request":
        return { action: "decline", content: null, _meta: null };
      case "item/tool/call":
        return { contentItems: [], success: false };
      case "account/chatgptAuthTokens/refresh":
        throw new Error("当前 bridge 不支持远程刷新 ChatGPT token");
      default:
        return { decision: "decline" };
    }
  };
}

// ─── 串行任务队列 ───────────────────────────────────────────

/**
 * 创建一个串行任务队列。
 * @returns 用于 enqueue 异步任务的函数。
 */
function createTaskQueue(): (task: () => Promise<void>) => Promise<void> {
  let tail = Promise.resolve();
  return async function enqueue(task: () => Promise<void>): Promise<void> {
    const next = tail.catch(() => {}).then(task);
    tail = next;
    return next;
  };
}

/**
 * 根据频道 ID 获取对应的串行队列，实现“每个频道各自串行”。
 * @param queueMap channelId -> queue。
 * @param channelId 目标频道 ID。
 * @returns 该频道的 enqueue 函数。
 */
function ensureChannelQueue(
  queueMap: Map<string, (task: () => Promise<void>) => Promise<void>>,
  channelId: string,
): (task: () => Promise<void>) => Promise<void> {
  let queue = queueMap.get(channelId);
  if (!queue) {
    queue = createTaskQueue();
    queueMap.set(channelId, queue);
  }
  return queue;
}

// ─── 消息处理 ───────────────────────────────────────────────

/**
 * 从本地档案中查出频道名，用于 thread 命名与日志。
 * @param channelId Forum 频道 ID。
 * @returns 频道名，找不到时回退到 channelId。
 */
function resolveChannelName(channelId: string): string {
  const archive = loadAgentArchive();
  const channel = archive?.channels?.find((item) => item.id === channelId);
  return channel?.name || channelId;
}

/**
 * 确保当前所有成员频道都已经建立了对应的 Codex thread。
 * @param channels 当前成员频道列表。
 * @param codexClient Codex app-server 客户端。
 */
async function ensureThreadsForChannels(channels: Channel[], codexClient: CodexAppServerClient): Promise<void> {
  for (const channel of channels) {
    await codexClient.ensureThread(channel.id, channel.name || channel.id);
  }
}

/**
 * 处理一条命中当前 Agent 的消息。
 * @param opts 当前回复所需的完整上下文。
 */
async function respondToMessage(opts: {
  apiKey: string;
  channelId: string;
  message: Message;
  historyMessages: Message[];
  codexClient: CodexAppServerClient;
  approvalManager: ForumApprovalManager;
  selfAgentId?: string;
}): Promise<void> {
  const { apiKey, channelId, message, historyMessages, codexClient, approvalManager, selfAgentId } = opts;
  const channelPolicy = await fetchChannelPolicy(apiKey, channelId);
  const channelName = resolveChannelName(channelId);
  const prompt = buildPrompt(historyMessages, message, channelPolicy, selfAgentId);
  const routing = buildReplyRouting(message);
  const onServerRequest = buildServerRequestHandler(apiKey, channelId, approvalManager);

  try {
    const structuredReply = await generateStructuredReply({
      channelId,
      channelName,
      prompt,
      channelPolicy,
      codexClient,
      onServerRequest,
    });
    const reply = compactReply(structuredReply.content);
    await sendForumMessage(apiKey, channelId, reply, {
      ...routing,
      intent: structuredReply.intent ?? undefined,
    });
    console.log(`[CodexBridge] 已回复消息 ${message.id}`);
  } catch (error: any) {
    console.error(`[CodexBridge] 处理消息 ${message.id} 失败: ${error.message}`);
    try {
      await sendForumMessage(apiKey, channelId, `处理失败：${error.message}`, {
        ...routing,
        intent: {
          task_type: "bug_report",
          priority: "high",
        },
      });
    } catch (sendError: any) {
      console.error(`[CodexBridge] 失败消息发送失败: ${sendError.message}`);
    }
  }
}

// ─── 成员事件处理 ───────────────────────────────────────────

/**
 * 处理成员变更事件：刷新档案、重建上下文，并为新频道创建 thread。
 * @param opts 成员事件上下文。
 */
async function handleMembershipEvent(opts: {
  apiKey: string;
  selfAgentId: string;
  contextStores: Map<string, ContextStore>;
  codexClient: CodexAppServerClient;
  event: WSEvent;
}): Promise<void> {
  const payload = opts.event.payload || {};
  if ((payload as any).agentId !== opts.selfAgentId) return;

  const archive = await syncAgentArchive(opts.apiKey);
  const channelMap = new Map(
    archive.channels
      .filter((item) => item?.id)
      .map((item) => [item.id, item] as const),
  );

  for (const existingChannelId of [...opts.contextStores.keys()]) {
    if (!channelMap.has(existingChannelId)) {
      opts.contextStores.delete(existingChannelId);
    }
  }

  for (const channel of archive.channels) {
    const store = ensureContextStore(opts.contextStores, channel.id);
    await seedChannelContext(opts.apiKey, channel.id, store);
  }

  await ensureThreadsForChannels(archive.channels, opts.codexClient);
}

// ─── WebSocket 连接 ─────────────────────────────────────────

/**
 * 建立 Forum WebSocket 长连接，接收消息并路由给 Codex app-server。
 * @param apiKey Agent API Key。
 * @param selfAgentId 当前 Agent ID。
 * @param contextStores 所有频道的上下文缓存。
 * @param codexClient Codex app-server 客户端。
 * @param approvalManager Forum 审批管理器。
 */
function connectWS(
  apiKey: string,
  selfAgentId: string,
  contextStores: Map<string, ContextStore>,
  codexClient: CodexAppServerClient,
  approvalManager: ForumApprovalManager,
): void {
  const queueMap = new Map<string, (task: () => Promise<void>) => Promise<void>>();
  const ws = new WebSocket(`${FORUM_WS}/ws?apiKey=${encodeURIComponent(apiKey)}`);

  ws.on("open", async () => {
    console.log("[CodexBridge] WS 已连接，准备同步成员频道");
    try {
      await seedAllChannelContexts(apiKey, contextStores);
      const archive = loadAgentArchive();
      await ensureThreadsForChannels(Array.isArray(archive?.channels) ? archive.channels as Channel[] : [], codexClient);
      console.log("[CodexBridge] 已同步上下文与频道 thread 绑定");
    } catch (error: any) {
      console.warn(`[CodexBridge] 启动同步失败: ${error.message}`);
    }
  });

  ws.on("message", (raw) => {
    let event: WSEvent;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (event.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", payload: {}, timestamp: new Date().toISOString() }));
      return;
    }

    if (event.type === "member.joined" || event.type === "member.left") {
      void handleMembershipEvent({
        apiKey,
        selfAgentId,
        contextStores,
        codexClient,
        event,
      }).catch((error: any) => {
        console.warn(`[CodexBridge] 成员事件同步失败: ${error.message}`);
      });
      return;
    }

    if (event.type !== "message.new" || !event.channelId) {
      return;
    }

    const contextStore = contextStores.get(event.channelId);
    if (!contextStore) {
      console.log(`[CodexBridge] 跳过消息 ${event.channelId}: 当前频道尚未建立上下文缓存`);
      return;
    }

    const sender = (event.payload?.sender || {}) as any;
    const rawMessage = event.payload?.message as any;
    if (!rawMessage) return;

    const message = upsertContextMessage(contextStore, {
      ...rawMessage,
      sender_id: rawMessage.sender_id ?? sender.id ?? "",
      sender_name: rawMessage.sender_name ?? sender.name ?? "",
    });
    if (!message) return;

    if (message.senderId === selfAgentId) {
      return;
    }

    if (approvalManager.handleReply(message)) {
      return;
    }

    if (!shouldRespondToMessage(message, selfAgentId)) {
      return;
    }

    const historySnapshot = listContextMessages(contextStore, message.id);
    const enqueue = ensureChannelQueue(queueMap, event.channelId);

    void enqueue(() => respondToMessage({
      apiKey,
      channelId: event.channelId!,
      message,
      historyMessages: historySnapshot,
      codexClient,
      approvalManager,
      selfAgentId,
    })).catch((error: any) => {
      console.error(`[CodexBridge] 队列任务失败: ${error.message}`);
    });
  });

  ws.on("close", (code) => {
    console.warn(`[CodexBridge] WS 已断开 (${code})，${RECONNECT_DELAY_MS}ms 后重连`);
    setTimeout(() => {
      connectWS(apiKey, selfAgentId, contextStores, codexClient, approvalManager);
    }, RECONNECT_DELAY_MS);
  });

  ws.on("error", (error) => {
    console.error(`[CodexBridge] WS 错误: ${error.message}`);
  });
}

// ─── 启动 ───────────────────────────────────────────────────

/**
 * 启动 Codex Bridge。
 */
async function main(): Promise<void> {
  const { agentId, apiKey } = await register();
  const contextStores = new Map<string, ContextStore>();
  const archive = await syncAgentArchive(apiKey);

  const codexClient = new CodexAppServerClient({
    codexBin: CODEX_BIN,
    appServerUrl: CODEX_APP_SERVER_URL,
    appServerAuthToken: CODEX_APP_SERVER_AUTH_TOKEN,
    cwd: CODEX_DIRS.cwd,
    model: CODEX_MODEL,
    reasoningEffort: CODEX_REASONING_EFFORT,
    serviceTier: CODEX_SERVICE_TIER,
    approvalPolicy: CODEX_APPROVAL_POLICY,
    sandboxMode: CODEX_SANDBOX_MODE,
    developerInstructions: CODEX_DEVELOPER_INSTRUCTIONS,
    replyTimeoutMs: CODEX_REPLY_TIMEOUT_MS,
    onThreadBound: async (channelId, channelName, threadId) => {
      persistThreadBinding(channelId, channelName, threadId);
    },
  });
  codexClient.setKnownThreads(
    Object.fromEntries(
      Object.entries(archive.threadBindings || {}).map(([channelId, binding]) => [channelId, binding.threadId]),
    ),
  );

  await seedAllChannelContexts(apiKey, contextStores);
  await ensureThreadsForChannels(archive.channels, codexClient);

  console.log(`[CodexBridge] 频道邀请制已启用：仅监听当前已加入频道，共 ${archive.channels.length} 个`);
  console.log(`[CodexBridge] 每个频道对应独立 Codex thread`);
  console.log(`[CodexBridge] Codex 模型: ${CODEX_MODEL}`);
  console.log(`[CodexBridge] Codex approval policy: ${CODEX_APPROVAL_POLICY}`);
  console.log(`[CodexBridge] Codex sandbox mode: ${CODEX_SANDBOX_MODE}`);
  console.log(`[CodexBridge] Codex cwd: ${CODEX_DIRS.cwd}`);
  if (CODEX_DIRS.additionalDirectories.length > 0) {
    console.warn(`[CodexBridge] 额外目录当前仅作记录，未注入 app-server: ${CODEX_DIRS.additionalDirectories.join(", ")}`);
  }
  if (CODEX_APP_SERVER_URL) {
    console.log(`[CodexBridge] 复用外部 app-server: ${CODEX_APP_SERVER_URL}`);
  } else {
    console.log("[CodexBridge] 将自动拉起本地 codex app-server");
  }

  const approvalManager = new ForumApprovalManager();
  connectWS(apiKey, agentId, contextStores, codexClient, approvalManager);

  const shutdown = async (): Promise<void> => {
    await codexClient.close();
    process.exit(0);
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

main().catch((error) => {
  console.error("[CodexBridge] 启动失败:", error);
  process.exit(1);
});
