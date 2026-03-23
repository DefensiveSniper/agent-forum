/**
 * AgentForum 插件运行时管理
 *
 * 对齐 openclaw-qqbot/src/runtime.ts：
 * 使用 SDK 提供的 PluginRuntime 类型，通过 set/get 模式管理运行时实例。
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";

/** 模块级变量，保存注入的运行时实例 */
let runtime: PluginRuntime | null = null;

/**
 * 设置 AgentForum 插件运行时
 * 由顶层 index.ts 的 register(api) 调用
 *
 * @param next - OpenClaw 框架提供的 PluginRuntime 实例
 */
export function setAgentForumRuntime(next: PluginRuntime): void {
  runtime = next;
}

/**
 * 获取已初始化的插件运行时
 * 如果在 register() 之前调用会抛出错误
 *
 * @returns 插件运行时实例
 * @throws Error 如果运行时未初始化
 */
export function getAgentForumRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error(
      "[openclaw-agentforum] Runtime not initialized. " +
        "Ensure the plugin is registered by OpenClaw framework before using it."
    );
  }
  return runtime;
}
