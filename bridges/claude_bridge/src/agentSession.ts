import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * 单个 Channel 对应的 Claude Code session 状态
 */
interface SessionState {
  sessionId: string | null;        // Claude Code 返回的 session id，用于续接对话
  isProcessing: boolean;           // 防止并发消息
}

/**
 * canUseTool 回调的返回类型
 */
export interface PermissionResult {
  behavior: "allow" | "deny";
  updatedInput?: any;
  message?: string;
}

/**
 * canUseTool 回调函数签名
 * 当 Claude Code 想执行未预批准的工具时调用
 */
export type CanUseToolCallback = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<PermissionResult>;

/**
 * AgentSessionManager
 * 通过 @anthropic-ai/claude-agent-sdk 调用本机 Claude Code，
 * 为每个频道维护独立的持久 session（跨消息记忆）。
 */
export class AgentSessionManager {
  /** channelId -> session 状态 */
  private sessions = new Map<string, SessionState>();

  /** Claude Code SDK 最大轮次 */
  private maxTurns: number;

  /** 主工作目录 */
  private cwd: string;

  /** 附加可访问目录 */
  private additionalDirectories: string[];

  /** Claude Code 权限模式 */
  private permissionMode: string;

  constructor(maxTurns: number = 10, cwd?: string, additionalDirectories?: string[], permissionMode?: string) {
    this.maxTurns = maxTurns;
    this.cwd = cwd ?? process.cwd();
    this.additionalDirectories = additionalDirectories ?? [];
    this.permissionMode = permissionMode ?? "plan";
  }

  /**
   * 获取或初始化一个 channel 的 session 状态
   */
  private getOrCreateSession(channelId: string): SessionState {
    if (!this.sessions.has(channelId)) {
      this.sessions.set(channelId, {
        sessionId: null,
        isProcessing: false,
      });
    }
    return this.sessions.get(channelId)!;
  }

  /**
   * 重置某个 channel 的 session（清空历史）
   */
  resetSession(channelId: string): void {
    this.sessions.delete(channelId);
    console.log(`[Session] Channel ${channelId} session reset`);
  }

  /**
   * 判断当前权限模式是否需要注入 canUseTool 回调
   * - default: 所有未预批准的工具都走回调
   * - acceptEdits: 文件编辑自动批准，但 Bash 等仍走回调
   */
  private needsPermissionCallback(): boolean {
    return this.permissionMode === "default" || this.permissionMode === "acceptEdits";
  }

  /**
   * 向某个 channel 的 Claude Code session 发送 prompt 并返回完整文本回复。
   * 通过 claude-agent-sdk 的 query() 驱动本地 Claude Code 进程。
   * 每个 channel 维护独立 session，通过 resume 续接实现跨消息记忆。
   *
   * @param channelId 频道 ID
   * @param prompt 提示词
   * @param canUseTool 可选的权限回调，在 default/acceptEdits 模式下拦截工具请求
   */
  async run(channelId: string, prompt: string, canUseTool?: CanUseToolCallback): Promise<string> {
    const session = this.getOrCreateSession(channelId);
    let fullText = "";

    try {
      // 构造 Claude Agent SDK 选项
      const options: Record<string, unknown> = {
        cwd: this.cwd,
        maxTurns: this.maxTurns,
        // 安全工具：自动批准读取和搜索
        allowedTools: ["Read", "Grep", "Glob", "WebSearch"],
        permissionMode: this.permissionMode,
      };

      // 附加可访问目录
      if (this.additionalDirectories.length > 0) {
        options.additionalDirectories = this.additionalDirectories;
      }

      // 如果有历史 session，续接对话
      if (session.sessionId) {
        options.resume = session.sessionId;
      }

      // 在 default/acceptEdits 模式下注入权限回调
      // Bash、Write、Edit 等危险工具会触发此回调，由 forum 用户决定是否允许
      if (this.needsPermissionCallback() && canUseTool) {
        options.canUseTool = canUseTool;
      }

      // 流式遍历 Claude Code 的输出
      for await (const message of query({ prompt, options })) {
        // 捕获 session id（首次会话后保存，后续用于续接）
        if (message.type === "system" && (message as any).session_id) {
          session.sessionId = (message as any).session_id;
          console.log(`[Session] Channel ${channelId} session id: ${session.sessionId}`);
        }

        // assistant 消息：提取文本内容
        if (message.type === "assistant") {
          const content = (message as any).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text") {
                fullText += block.text;
              }
            }
          }
        }

        // 最终结果
        if (message.type === "result") {
          const result = (message as any).result;
          if (result && !fullText) {
            fullText = result;
          }
          if ((message as any).session_id && !session.sessionId) {
            session.sessionId = (message as any).session_id;
          }
        }
      }
    } catch (err: any) {
      console.error(`[Session] Channel ${channelId} error:`, err);
      throw err;
    }

    return fullText || "(无输出)";
  }
}
