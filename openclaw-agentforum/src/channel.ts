/**
 * AgentForum ChannelPlugin 定义
 *
 * 对齐 openclaw-qqbot/src/channel.ts 结构，
 * 实现 ChannelPlugin<ResolvedAgentForumAccount> 接口。
 *
 * 关键设计差异（相比 QQBot）：
 * - 认证: 固定 API Key（无 OAuth）
 * - 消息: 统一 message.new（无多种 event type）
 * - 媒体: 暂不支持
 * - channelId 可选: 不指定则监听所有已加入频道，通过 @mention/reply 触发回复
 */

import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import {
  applyAccountNameToChannelSection,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk";

import type { ResolvedAgentForumAccount } from "./types.js";
import {
  DEFAULT_ACCOUNT_ID,
  listAgentForumAccountIds,
  resolveAgentForumAccount,
  resolveDefaultAgentForumAccountId,
  isAgentForumAccountConfigured,
} from "./config.js";
import { sendText } from "./outbound.js";
import { startGateway } from "./gateway.js";
import { agentforumOnboardingAdapter } from "./onboarding.js";
import { getAgentForumRuntime } from "./runtime.js";

/** 单条消息文本长度上限 */
export const TEXT_CHUNK_LIMIT = 5000;

/**
 * Markdown 感知的文本分块函数
 * 委托给 SDK 内置的 channel.text.chunkMarkdownText
 */
export function chunkText(text: string, limit: number): string[] {
  const runtime = getAgentForumRuntime();
  return runtime.channel.text.chunkMarkdownText(text, limit);
}

export const agentforumPlugin: ChannelPlugin<ResolvedAgentForumAccount> = {
  id: "agentforum",

  /** 插件元信息 */
  meta: {
    id: "agentforum",
    label: "AgentForum",
    selectionLabel: "AgentForum",
    docsPath: "/docs/channels/agentforum",
    blurb: "Connect to AgentForum multi-agent collaboration platform",
    order: 60,
  },

  /** 插件能力声明 */
  capabilities: {
    chatTypes: ["direct", "group"],
    media: false,
    reactions: false,
    threads: false,
    blockStreaming: true,
  },

  /** 配置变更监听 */
  reload: { configPrefixes: ["channels.agentforum"] },

  /** 交互式 onboarding 向导 */
  onboarding: agentforumOnboardingAdapter,

  // ============ 账户配置管理 ============
  config: {
    listAccountIds: (cfg) => listAgentForumAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveAgentForumAccount(cfg, accountId ?? undefined),
    defaultAccountId: (cfg) => resolveDefaultAgentForumAccountId(cfg),

    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "agentforum",
        accountId,
        enabled,
        allowTopLevel: true,
      }),

    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "agentforum",
        accountId,
        clearBaseFields: ["apiKey", "agentId", "channelId", "forumUrl", "name"],
      }),

    isConfigured: (account) => isAgentForumAccountConfigured(account),

    describeAccount: (account) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: isAgentForumAccountConfigured(account ?? {}),
      tokenSource: account?.apiKey ? "config" : "none",
    }),
  },

  // ============ 出站消息配置 ============
  outbound: {
    deliveryMode: "direct",
    chunker: (text: string, limit: number) => chunkText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: TEXT_CHUNK_LIMIT,

    /**
     * 发送文本消息
     * to 格式: agentforum:{accountId}:channel:{channelId}
     */
    sendText: async ({ to, text, accountId, replyToId, cfg }) => {
      const account = resolveAgentForumAccount(cfg, accountId ?? undefined);
      // 从路由地址中提取 channelId
      const channelId = to.split(":").pop() || account.channelId || "";
      if (!channelId) {
        return {
          channel: "agentforum",
          messageId: "",
          error: new Error("No channelId available for outbound sendText"),
        };
      }
      const result = await sendText(
        account.forumUrl,
        channelId,
        text,
        account.apiKey,
        replyToId ?? undefined
      );
      return {
        channel: "agentforum",
        messageId: result.id,
        error: result.error ? new Error(result.error) : undefined,
      };
    },

    /** AgentForum 暂不支持媒体 */
    sendMedia: async () => ({
      channel: "agentforum",
      messageId: "",
      error: new Error("AgentForum does not support media messages"),
    }),
  },

  // ============ Gateway 生命周期 ============
  gateway: {
    /**
     * 启动指定账户的 WebSocket Gateway
     * OpenClaw 框架在插件激活且账户已配置时调用
     */
    startAccount: async (ctx) => {
      const { account, abortSignal, cfg, log } = ctx;

      await startGateway({
        account,
        abortSignal,
        cfg,
        log,
        onReady: () => {
          log?.info(`[agentforum:${account.accountId}] Gateway ready`);
        },
        onError: (error: Error) => {
          log?.error(`[agentforum:${account.accountId}] Gateway error: ${error.message}`);
        },
      });
    },
  },

  // ============ 状态报告 ============
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null as number | null,
      lastError: null as string | null,
    },

    buildChannelSummary: ({ snapshot }) => ({
      configured: (snapshot.configured as boolean) ?? false,
      running: (snapshot.running as boolean) ?? false,
      connected: (snapshot.connected as boolean) ?? false,
      lastConnectedAt: (snapshot.lastConnectedAt as number | null) ?? null,
      lastError: (snapshot.lastError as string | null) ?? null,
    }),

    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: isAgentForumAccountConfigured(account ?? {}),
      running: (runtime?.running as boolean) ?? false,
      connected: (runtime?.connected as boolean) ?? false,
      lastConnectedAt: (runtime?.lastConnectedAt as number | null) ?? null,
      lastError: (runtime?.lastError as string | null) ?? null,
    }),
  },
};
