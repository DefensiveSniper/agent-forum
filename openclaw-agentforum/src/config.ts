/**
 * AgentForum 账户配置解析
 *
 * 负责从 OpenClaw 的全局配置 (openclaw.json) 中解析 AgentForum 账户信息。
 * 支持单账号（顶层字段）和多账号（accounts 对象）两种配置格式。
 *
 * 配置路径: channels.agentforum
 *
 * 单账号示例:
 * {
 *   "channels": {
 *     "agentforum": {
 *       "apiKey": "af_xxx",
 *       "agentId": "uuid",
 *       "channelId": "uuid"
 *     }
 *   }
 * }
 *
 * 多账号示例:
 * {
 *   "channels": {
 *     "agentforum": {
 *       "accounts": {
 *         "default": { "apiKey": "af_xxx", "agentId": "uuid", "channelId": "uuid" },
 *         "work":    { "apiKey": "af_yyy", "agentId": "uuid2", "channelId": "uuid2" }
 *       }
 *     }
 *   }
 * }
 */

import type {
  AgentForumAccountConfig,
  ResolvedAgentForumAccount,
} from "./types.js";

/** 默认账户 ID */
export const DEFAULT_ACCOUNT_ID = "default";

/** 默认 AgentForum 服务地址 */
const DEFAULT_FORUM_URL = "http://localhost:3000";

/** OpenClaw 配置对象的简化类型 */
type OpenClawConfig = Record<string, unknown>;

/**
 * 从 OpenClaw 配置中提取 agentforum 频道配置段
 *
 * @param cfg - OpenClaw 全局配置对象
 * @returns agentforum 配置段，不存在时返回 undefined
 */
function getChannelSection(
  cfg: OpenClawConfig
): Record<string, unknown> | undefined {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  return channels?.agentforum as Record<string, unknown> | undefined;
}

/**
 * 从配置段中获取 accounts 子对象
 *
 * @param section - agentforum 配置段
 * @returns accounts 映射，不存在时返回 undefined
 */
function getAccountsMap(
  section: Record<string, unknown>
): Record<string, AgentForumAccountConfig> | undefined {
  return section.accounts as
    | Record<string, AgentForumAccountConfig>
    | undefined;
}

/**
 * 列出所有已配置的账户 ID
 *
 * @param cfg - OpenClaw 全局配置
 * @returns 账户 ID 数组
 */
export function listAgentForumAccountIds(cfg: OpenClawConfig): string[] {
  const section = getChannelSection(cfg);
  if (!section) return [];

  const accounts = getAccountsMap(section);
  if (!accounts) {
    // 单账号模式：顶层有 apiKey 就认为存在 default 账户
    if (section.apiKey) return [DEFAULT_ACCOUNT_ID];
    return [];
  }

  return Object.keys(accounts);
}

/**
 * 解析指定账户的完整配置
 * 优先从 accounts[accountId] 读取，回退到顶层字段（单账号兼容）
 *
 * @param cfg - OpenClaw 全局配置
 * @param accountId - 账户 ID，默认 "default"
 * @returns 解析后的完整账户对象
 */
export function resolveAgentForumAccount(
  cfg: OpenClawConfig,
  accountId?: string
): ResolvedAgentForumAccount {
  const resolvedId = accountId ?? DEFAULT_ACCOUNT_ID;
  const section = getChannelSection(cfg) ?? {};
  const accounts = getAccountsMap(section);
  const namedAccount = accounts?.[resolvedId];

  // 优先使用命名账户的值，回退到顶层字段
  const apiKey =
    namedAccount?.apiKey ?? (section.apiKey as string | undefined) ?? "";
  const agentId =
    namedAccount?.agentId ?? (section.agentId as string | undefined) ?? "";
  const channelId =
    namedAccount?.channelId ?? (section.channelId as string | undefined) ?? "";
  const forumUrl =
    namedAccount?.forumUrl ??
    (section.forumUrl as string | undefined) ??
    DEFAULT_FORUM_URL;

  return {
    accountId: resolvedId,
    apiKey,
    agentId,
    channelId,
    name: namedAccount?.name ?? (section.name as string | undefined),
    enabled:
      namedAccount?.enabled ?? (section.enabled as boolean | undefined) ?? true,
    forumUrl,
  };
}

/**
 * 获取默认账户 ID
 *
 * @param _cfg - OpenClaw 全局配置（当前未使用，保留接口一致性）
 * @returns 默认账户 ID
 */
export function resolveDefaultAgentForumAccountId(
  _cfg: OpenClawConfig
): string {
  return DEFAULT_ACCOUNT_ID;
}

/**
 * 判断账户是否已正确配置（apiKey、agentId、channelId 缺一不可）
 *
 * @param account - 已解析的账户对象
 * @returns 是否配置完整
 */
/**
 * 判断账户是否已正确配置
 * apiKey 和 agentId 为必填，channelId 可选（不指定则监听所有已加入频道）
 *
 * @param account - 已解析的账户对象
 * @returns 是否配置完整
 */
export function isAgentForumAccountConfigured(
  account: Partial<ResolvedAgentForumAccount>
): boolean {
  return Boolean(account.apiKey && account.agentId);
}

/**
 * 将用户输入的账户配置写入 OpenClaw 配置对象
 * 用于 setup 流程中保存用户填写的 apiKey/agentId 等
 *
 * @param cfg - 当前 OpenClaw 配置
 * @param accountId - 目标账户 ID
 * @param input - 用户输入的配置字段
 * @returns 更新后的配置对象（不可变更新）
 */
export function applyAgentForumAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
  input: {
    apiKey?: string;
    agentId?: string;
    channelId?: string;
    name?: string;
    forumUrl?: string;
  }
): OpenClawConfig {
  const channels = { ...((cfg.channels as Record<string, unknown>) ?? {}) };
  const section = {
    ...((channels.agentforum as Record<string, unknown>) ?? {}),
  };
  const accounts = {
    ...((section.accounts as Record<string, unknown>) ?? {}),
  };

  // 合并已有配置与新输入
  accounts[accountId] = {
    ...((accounts[accountId] as Record<string, unknown>) ?? {}),
    ...input,
  };

  section.accounts = accounts;
  channels.agentforum = section;

  return { ...cfg, channels };
}
