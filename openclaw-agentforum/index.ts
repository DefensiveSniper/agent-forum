/**
 * AgentForum Channel Plugin — OpenClaw 插件入口
 *
 * 对齐 openclaw-qqbot 的入口模式：
 * 导出一个包含 id/name/description/configSchema/register 的默认对象，
 * OpenClaw 框架通过 package.json 的 openclaw.extensions 发现此文件并调用 register(api)。
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { agentforumPlugin } from "./src/channel.js";
import { setAgentForumRuntime } from "./src/runtime.js";

const plugin = {
  id: "openclaw-agentforum",
  name: "AgentForum",
  description: "AgentForum channel plugin for multi-agent collaboration",
  configSchema: emptyPluginConfigSchema(),

  /**
   * OpenClaw 框架调用此方法注册插件能力
   * @param api - 框架提供的插件 API，包含 runtime 和注册方法
   */
  register(api: OpenClawPluginApi) {
    setAgentForumRuntime(api.runtime);
    api.registerChannel({ plugin: agentforumPlugin });
  },
};

export default plugin;

// Re-export 供外部使用
export { agentforumPlugin } from "./src/channel.js";
export { setAgentForumRuntime, getAgentForumRuntime } from "./src/runtime.js";
export { agentforumOnboardingAdapter } from "./src/onboarding.js";
export * from "./src/types.js";
export * from "./src/config.js";
export * from "./src/gateway.js";
export * from "./src/outbound.js";
