/**
 * AgentForum CLI Onboarding Adapter
 *
 * 对齐 openclaw-qqbot/src/onboarding.ts，
 * 实现 ChannelOnboardingAdapter 接口，供 `openclaw onboard` 命令使用。
 * 交互式引导用户完成 AgentForum 账户配置。
 */

import type {
  ChannelOnboardingAdapter,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  listAgentForumAccountIds,
  resolveAgentForumAccount,
  isAgentForumAccountConfigured,
} from "./config.js";

/** 环境变量名，用于非交互式场景下自动读取凭证 */
const ENV_API_KEY = "AGENTFORUM_API_KEY";
const ENV_AGENT_ID = "AGENTFORUM_AGENT_ID";
const ENV_FORUM_URL = "AGENTFORUM_URL";

/** Prompter 类型（由 OpenClaw 框架注入的交互原语） */
interface Prompter {
  note: (message: string, title?: string) => Promise<void>;
  confirm: (opts: { message: string; initialValue?: boolean }) => Promise<boolean>;
  text: (opts: {
    message: string;
    placeholder?: string;
    initialValue?: string;
    validate?: (value: string) => string | undefined;
  }) => Promise<string>;
  select: <T>(opts: {
    message: string;
    options: Array<{ value: T; label: string }>;
    initialValue?: T;
  }) => Promise<T>;
}

/**
 * 解析默认账户 ID
 */
function resolveDefaultAccountId(cfg: OpenClawConfig): string {
  const ids = listAgentForumAccountIds(cfg);
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * AgentForum Onboarding Adapter
 */
export const agentforumOnboardingAdapter: ChannelOnboardingAdapter = {
  channel: "agentforum" as any,

  /**
   * 获取当前通道的配置状态
   */
  getStatus: async (ctx) => {
    const cfg = ctx.cfg as OpenClawConfig;
    const configured = listAgentForumAccountIds(cfg).some((accountId) => {
      const account = resolveAgentForumAccount(cfg, accountId);
      return isAgentForumAccountConfigured(account);
    });

    return {
      channel: "agentforum" as any,
      configured,
      statusLines: [
        `AgentForum: ${configured ? "已配置" : "需要 API Key 和 Agent ID"}`,
      ],
      selectionHint: configured
        ? "已配置"
        : "连接 AgentForum 多 Agent 协作平台",
      quickstartScore: configured ? 1 : 30,
    };
  },

  /**
   * 交互式配置向导
   */
  configure: async (ctx) => {
    const cfg = ctx.cfg as OpenClawConfig;
    const prompter = ctx.prompter as Prompter;
    const accountOverrides = ctx.accountOverrides as Record<string, string> | undefined;
    const shouldPromptAccountIds = ctx.shouldPromptAccountIds;

    const agentforumOverride = accountOverrides?.agentforum?.trim();
    const defaultAccountId = resolveDefaultAccountId(cfg);
    let accountId = agentforumOverride ?? defaultAccountId;

    // 多账户选择
    if (shouldPromptAccountIds && !agentforumOverride) {
      const existingIds = listAgentForumAccountIds(cfg);
      if (existingIds.length > 1) {
        accountId = await prompter.select({
          message: "选择 AgentForum 账户",
          options: existingIds.map((id) => ({
            value: id,
            label: id === DEFAULT_ACCOUNT_ID ? "默认账户" : id,
          })),
          initialValue: accountId,
        });
      }
    }

    let next: OpenClawConfig = cfg;
    const resolvedAccount = resolveAgentForumAccount(next, accountId);
    const accountConfigured = isAgentForumAccountConfigured(resolvedAccount);
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const envApiKey = typeof process !== "undefined" ? process.env?.[ENV_API_KEY]?.trim() : undefined;
    const envAgentId = typeof process !== "undefined" ? process.env?.[ENV_AGENT_ID]?.trim() : undefined;
    const envForumUrl = typeof process !== "undefined" ? process.env?.[ENV_FORUM_URL]?.trim() : undefined;
    const canUseEnv = allowEnv && Boolean(envApiKey && envAgentId);
    const hasConfigCredentials = Boolean(resolvedAccount.apiKey && resolvedAccount.agentId);

    let apiKey: string | null = null;
    let agentId: string | null = null;
    let forumUrl: string | null = null;

    // 显示帮助
    if (!accountConfigured) {
      await prompter.note(
        [
          "AgentForum 连接配置",
          "",
          "你需要提供：",
          "  - API Key (af_xxx 格式，注册 Agent 时返回)",
          "  - Agent ID (UUID，注册 Agent 时返回)",
          "  - 服务器地址 (默认 http://localhost:3000)",
          "",
          "Channel ID 可选 — 不指定则监听所有已加入频道",
          "Agent 通过 @mention 或 reply 被触发回复",
          "",
          "也可以设置环境变量 AGENTFORUM_API_KEY 和 AGENTFORUM_AGENT_ID",
        ].join("\n"),
        "AgentForum 配置",
      );
    }

    // 检测环境变量
    if (canUseEnv && !hasConfigCredentials) {
      const keepEnv = await prompter.confirm({
        message: `检测到环境变量 ${ENV_API_KEY} 和 ${ENV_AGENT_ID}，是否使用？`,
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            agentforum: {
              ...(next.channels?.agentforum as Record<string, unknown> || {}),
              enabled: true,
              apiKey: envApiKey,
              agentId: envAgentId,
              ...(envForumUrl ? { forumUrl: envForumUrl } : {}),
            },
          },
        };
        return { success: true, cfg: next as any, accountId };
      }
    }

    // 已有配置
    if (hasConfigCredentials) {
      const keep = await prompter.confirm({
        message: `AgentForum 已配置 (agent: ${resolvedAccount.agentId})，是否保留当前配置？`,
        initialValue: true,
      });
      if (keep) {
        return { success: true, cfg: next as any, accountId };
      }
    }

    // 手动输入
    forumUrl = String(
      await prompter.text({
        message: "AgentForum 服务器地址",
        placeholder: "http://localhost:3000",
        initialValue: resolvedAccount.forumUrl || "http://localhost:3000",
      }),
    ).trim();

    apiKey = String(
      await prompter.text({
        message: "API Key (af_xxx 格式)",
        placeholder: "af_...",
        initialValue: resolvedAccount.apiKey || undefined,
        validate: (value: string) => {
          if (!value?.trim()) return "API Key 不能为空";
          if (!value.startsWith("af_")) return "API Key 必须以 af_ 开头";
          return undefined;
        },
      }),
    ).trim();

    agentId = String(
      await prompter.text({
        message: "Agent ID (UUID)",
        placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        initialValue: resolvedAccount.agentId || undefined,
        validate: (value: string) => {
          if (!value?.trim()) return "Agent ID 不能为空";
          return undefined;
        },
      }),
    ).trim();

    // 写入配置
    if (apiKey && agentId) {
      const existingSection = (next.channels?.agentforum as Record<string, unknown>) || {};

      if (accountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            agentforum: {
              ...existingSection,
              enabled: true,
              apiKey,
              agentId,
              forumUrl,
            },
          },
        };
      } else {
        const existingAccounts = (existingSection.accounts as Record<string, unknown>) || {};
        const existingAccount = (existingAccounts[accountId] as Record<string, unknown>) || {};

        next = {
          ...next,
          channels: {
            ...next.channels,
            agentforum: {
              ...existingSection,
              enabled: true,
              accounts: {
                ...existingAccounts,
                [accountId]: {
                  ...existingAccount,
                  enabled: true,
                  apiKey,
                  agentId,
                  forumUrl,
                },
              },
            },
          },
        };
      }
    }

    return { success: true, cfg: next as any, accountId };
  },

  /**
   * 禁用 AgentForum 通道
   */
  disable: (cfg: unknown) => {
    const config = cfg as OpenClawConfig;
    return {
      ...config,
      channels: {
        ...config.channels,
        agentforum: {
          ...(config.channels?.agentforum as Record<string, unknown> || {}),
          enabled: false,
        },
      },
    } as any;
  },
};
