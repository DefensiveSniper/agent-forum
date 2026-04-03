import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import WebSocket from "ws";

/**
 * app-server 常见的审批/交互请求方法集合。
 */
type ServerRequestMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/permissions/requestApproval"
  | "item/tool/requestUserInput"
  | "mcpServer/elicitation/request"
  | "item/tool/call"
  | "applyPatchApproval"
  | "execCommandApproval"
  | "account/chatgptAuthTokens/refresh";

/**
 * app-server 客户端发起 turn 时允许附带的配置。
 */
export interface CodexRunOptions {
  channelId: string;
  channelName: string;
  prompt: string;
  outputSchema?: Record<string, unknown>;
  onServerRequest?: CodexServerRequestHandler;
}

/**
 * 单轮 Codex 执行的结果。
 */
export interface CodexRunResult {
  threadId: string;
  turnId: string;
  text: string;
}

/**
 * 暴露给桥接主流程的 server request 结构。
 */
export interface CodexServerRequest {
  id: number | string;
  method: ServerRequestMethod;
  params: Record<string, unknown>;
}

/**
 * Forum 侧对 app-server 审批请求的处理器。
 */
export type CodexServerRequestHandler = (request: CodexServerRequest) => Promise<unknown>;

/**
 * 初始化 app-server 客户端所需的配置。
 */
export interface CodexAppServerOptions {
  codexBin: string;
  appServerUrl: string | null;
  appServerAuthToken: string | null;
  cwd: string;
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  approvalPolicy: string;
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  developerInstructions: string;
  replyTimeoutMs: number;
  onThreadBound?: (channelId: string, channelName: string, threadId: string) => Promise<void> | void;
}

interface JsonRpcSuccess<T = unknown> {
  id: number | string;
  result: T;
}

interface JsonRpcFailure {
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
}

interface PendingTurn {
  threadId: string;
  turnId: string;
  textByItemId: Map<string, string>;
  onServerRequest?: CodexServerRequestHandler;
  resolve: (value: CodexRunResult) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ThreadState {
  threadId: string | null;
  loaded: boolean;
}

/**
 * CodexAppServerClient
 * 维护一条到 `codex app-server` 的 JSON-RPC WebSocket 连接，并为每个频道维护独立 thread。
 */
export class CodexAppServerClient {
  private readonly options: CodexAppServerOptions;

  private readonly pendingRequests = new Map<number, PendingRequest>();

  private readonly pendingTurns = new Map<string, PendingTurn>();

  private readonly threadStates = new Map<string, ThreadState>();

  private ws: WebSocket | null = null;

  private child: ChildProcess | null = null;

  private connectPromise: Promise<void> | null = null;

  private initialized = false;

  private nextId = 1;

  private managedServerUrl: string | null = null;

  constructor(options: CodexAppServerOptions) {
    this.options = options;
  }

  /**
   * 预加载本地档案里的频道到 thread 绑定。
   * @param bindings channelId -> threadId 映射。
   */
  setKnownThreads(bindings: Record<string, string>): void {
    for (const [channelId, threadId] of Object.entries(bindings)) {
      if (!channelId || !threadId) continue;
      this.threadStates.set(channelId, {
        threadId,
        loaded: false,
      });
    }
  }

  /**
   * 对外暴露：确保某个频道已经存在对应的 Codex thread。
   * @param channelId Forum 频道 ID。
   * @param channelName Forum 频道名称。
   * @returns thread id。
   */
  async ensureThread(channelId: string, channelName: string): Promise<string> {
    await this.ensureReady();

    const existing = this.getOrCreateThreadState(channelId);
    if (existing.threadId) {
      if (!existing.loaded) {
        try {
          await this.resumeThread(existing.threadId);
          existing.loaded = true;
        } catch (error: any) {
          console.warn(`[CodexBridge] 恢复 thread 失败，将重建 channel=${channelId}: ${error.message}`);
          existing.threadId = null;
          existing.loaded = false;
        }
      }
      if (existing.threadId) {
        return existing.threadId;
      }
    }

    const response = await this.request<any>("thread/start", {
      model: this.options.model,
      serviceTier: this.options.serviceTier,
      cwd: this.options.cwd,
      approvalPolicy: this.options.approvalPolicy,
      sandbox: this.options.sandboxMode,
      developerInstructions: this.options.developerInstructions,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });

    const threadId = response?.thread?.id;
    if (!threadId) {
      throw new Error("thread/start 响应缺少 thread.id");
    }

    existing.threadId = threadId;
    existing.loaded = true;
    await this.safeSetThreadName(threadId, channelName);
    await this.options.onThreadBound?.(channelId, channelName, threadId);
    return threadId;
  }

  /**
   * 执行单轮 Codex 输入，并等待 turn 完成。
   * @param options 单轮执行的上下文配置。
   * @returns turn 完成后的文本结果。
   */
  async run(options: CodexRunOptions): Promise<CodexRunResult> {
    const threadId = await this.ensureThread(options.channelId, options.channelName);
    const turnStartResponse = await this.request<any>("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: options.prompt,
          text_elements: [],
        },
      ],
      model: this.options.model,
      serviceTier: this.options.serviceTier,
      effort: this.options.reasoningEffort,
      outputSchema: options.outputSchema ?? null,
    });

    const turnId = turnStartResponse?.turn?.id;
    if (!turnId) {
      throw new Error("turn/start 响应缺少 turn.id");
    }

    return new Promise<CodexRunResult>((resolve, reject) => {
      const timer = setTimeout(async () => {
        this.pendingTurns.delete(turnId);
        try {
          const fallbackText = await this.readTurnText(threadId, turnId);
          if (fallbackText) {
            resolve({ threadId, turnId, text: fallbackText });
            return;
          }
          reject(new Error(`Codex 回复超时 (${this.options.replyTimeoutMs}ms)`));
        } catch (error) {
          reject(error);
        }
      }, this.options.replyTimeoutMs);

      this.pendingTurns.set(turnId, {
        threadId,
        turnId,
        textByItemId: new Map<string, string>(),
        onServerRequest: options.onServerRequest,
        resolve,
        reject,
        timer,
      });
    });
  }

  /**
   * 主动关闭 app-server 连接与本地拉起的子进程。
   */
  async close(): Promise<void> {
    this.rejectAll(new Error("Codex app-server 已关闭"));
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    if (this.child && !this.child.killed) {
      this.child.kill();
      this.child = null;
    }
    this.initialized = false;
    this.connectPromise = null;
  }

  /**
   * 确保底层 WebSocket 已连接且 initialize 已完成。
   */
  private async ensureReady(): Promise<void> {
    if (this.ws && this.initialized && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = (async () => {
      await this.spawnManagedServerIfNeeded();
      const targetUrl = this.options.appServerUrl ?? this.managedServerUrl;
      if (!targetUrl) {
        throw new Error("未配置可用的 Codex app-server URL");
      }

      const headers = this.options.appServerAuthToken
        ? { Authorization: `Bearer ${this.options.appServerAuthToken}` }
        : undefined;

      const ws = await this.connectWebSocket(targetUrl, headers);
      this.attachSocket(ws);
      this.ws = ws;
      await this.requestInternal("initialize", {
        clientInfo: {
          name: "agent-forum-codex-bridge",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      this.initialized = true;
    })();

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  /**
   * 如未显式指定 app-server URL，则拉起一个本地受管的 app-server 实例。
   */
  private async spawnManagedServerIfNeeded(): Promise<void> {
    if (this.options.appServerUrl || this.child) {
      return;
    }

    const port = await this.getAvailablePort();
    const listenUrl = `ws://127.0.0.1:${port}`;
    const child = spawn(this.options.codexBin, ["app-server", "--listen", listenUrl], {
      cwd: this.options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString().trimEnd();
      if (text) console.log(`[CodexAppServer] ${text}`);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString().trimEnd();
      if (text) console.error(`[CodexAppServer] ${text}`);
    });
    child.on("exit", (code, signal) => {
      console.warn(`[CodexAppServer] 退出 code=${code ?? "null"} signal=${signal ?? "null"}`);
      this.child = null;
      this.managedServerUrl = null;
    });

    this.child = child;
    this.managedServerUrl = listenUrl;
  }

  /**
   * 为 JSON-RPC 发送一条请求，并等待响应。
   * @param method JSON-RPC 方法名。
   * @param params 请求参数。
   * @returns 解析后的 result。
   */
  private async request<T>(method: string, params: unknown): Promise<T> {
    await this.ensureReady();

    return this.requestInternal<T>(method, params);
  }

  /**
   * 在连接已经可用时直接发送 JSON-RPC 请求，避免初始化阶段递归进入 ensureReady。
   * @param method JSON-RPC 方法名。
   * @param params 请求参数。
   * @returns 解析后的 result。
   */
  private async requestInternal<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      try {
        this.ws?.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  /**
   * 将新建立的 WebSocket 连接挂上统一的事件分发逻辑。
   * @param ws 已打开的 WebSocket 连接。
   */
  private attachSocket(ws: WebSocket): void {
    ws.on("message", (payload) => {
      void this.handleIncomingMessage(payload.toString()).catch((error: any) => {
        console.error(`[CodexBridge] 处理 app-server 消息失败: ${error.message}`);
      });
    });

    ws.on("close", (code) => {
      console.warn(`[CodexBridge] app-server 连接关闭 code=${code}`);
      this.handleSocketClose(new Error(`app-server 连接已关闭 (${code})`));
    });

    ws.on("error", (error) => {
      console.error(`[CodexBridge] app-server 连接错误: ${error.message}`);
      this.handleSocketClose(error);
    });
  }

  /**
   * 处理 app-server 推送的所有 JSON-RPC 消息。
   * @param raw 原始 JSON 文本。
   */
  private async handleIncomingMessage(raw: string): Promise<void> {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof message?.id !== "undefined" && Object.prototype.hasOwnProperty.call(message, "result")) {
      this.resolveRequest(message as JsonRpcSuccess);
      return;
    }
    if (typeof message?.id !== "undefined" && Object.prototype.hasOwnProperty.call(message, "error")) {
      this.rejectRequest(message as JsonRpcFailure);
      return;
    }
    if (typeof message?.method !== "string") {
      return;
    }

    if (this.isServerRequest(message.method)) {
      await this.handleServerRequest(message as CodexServerRequest);
      return;
    }

    await this.handleNotification(message.method, message.params ?? {});
  }

  /**
   * 处理 turn / item 等通知消息。
   * @param method 通知方法名。
   * @param params 通知载荷。
   */
  private async handleNotification(method: string, params: Record<string, unknown>): Promise<void> {
    if (method === "item/agentMessage/delta") {
      const turn = this.pendingTurns.get(String(params.turnId ?? ""));
      if (!turn) return;
      const itemId = String(params.itemId ?? "");
      const delta = String(params.delta ?? "");
      const previous = turn.textByItemId.get(itemId) || "";
      turn.textByItemId.set(itemId, previous + delta);
      return;
    }

    if (method === "item/completed") {
      const turn = this.pendingTurns.get(String(params.turnId ?? ""));
      if (!turn) return;
      const item = params.item as Record<string, unknown> | undefined;
      if (item?.type !== "agentMessage") return;
      const itemId = String(item.id ?? "");
      const text = String(item.text ?? "").trim();
      if (!itemId || !text) return;
      turn.textByItemId.set(itemId, text);
      return;
    }

    if (method === "turn/completed") {
      const turn = this.pendingTurns.get(String((params.turn as any)?.id ?? ""));
      if (!turn) return;

      clearTimeout(turn.timer);
      this.pendingTurns.delete(turn.turnId);

      const status = String((params.turn as any)?.status ?? "");
      if (status === "failed") {
        const errorMessage = String((params.turn as any)?.error?.message ?? "Codex turn 失败");
        turn.reject(new Error(errorMessage));
        return;
      }
      if (status === "interrupted") {
        turn.reject(new Error("Codex turn 被中断"));
        return;
      }

      const directText = this.extractTurnText(turn);
      if (directText) {
        turn.resolve({
          threadId: turn.threadId,
          turnId: turn.turnId,
          text: directText,
        });
        return;
      }

      try {
        const fallbackText = await this.readTurnText(turn.threadId, turn.turnId);
        turn.resolve({
          threadId: turn.threadId,
          turnId: turn.turnId,
          text: fallbackText,
        });
      } catch (error) {
        turn.reject(error);
      }
    }
  }

  /**
   * 处理 app-server 发起的反向请求，例如审批与交互提问。
   * @param request app-server 反向请求对象。
   */
  private async handleServerRequest(request: CodexServerRequest): Promise<void> {
    const pendingTurn = this.findPendingTurnForRequest(request);
    const handler = pendingTurn?.onServerRequest;

    if (!handler) {
      this.sendRpcResult(request.id, this.buildDefaultServerRequestResponse(request));
      return;
    }

    try {
      const result = await handler(request);
      this.sendRpcResult(request.id, result);
    } catch (error: any) {
      this.sendRpcError(request.id, -32000, error?.message || "处理 app-server 请求失败");
    }
  }

  /**
   * 在 thread 已存在但当前连接尚未加载时恢复 thread。
   * @param threadId 目标 thread id。
   */
  private async resumeThread(threadId: string): Promise<void> {
    await this.request("thread/resume", {
      threadId,
      model: this.options.model,
      serviceTier: this.options.serviceTier,
      cwd: this.options.cwd,
      approvalPolicy: this.options.approvalPolicy,
      sandbox: this.options.sandboxMode,
      developerInstructions: this.options.developerInstructions,
      persistExtendedHistory: true,
    });
  }

  /**
   * 创建 thread 后，尽量把 thread 名称改成频道名，便于本机调试与恢复。
   * @param threadId 目标 thread id。
   * @param channelName Forum 频道名称。
   */
  private async safeSetThreadName(threadId: string, channelName: string): Promise<void> {
    if (!channelName.trim()) return;
    try {
      await this.request("thread/name/set", {
        threadId,
        name: channelName,
      });
    } catch (error: any) {
      console.warn(`[CodexBridge] thread 命名失败 ${threadId}: ${error.message}`);
    }
  }

  /**
   * 读取指定 turn 的最终 agentMessage 文本，作为通知缺失时的兜底读取。
   * @param threadId 所属 thread id。
   * @param turnId 目标 turn id。
   * @returns 最终读取到的 agent 文本。
   */
  private async readTurnText(threadId: string, turnId: string): Promise<string> {
    const response = await this.request<any>("thread/read", {
      threadId,
      includeTurns: true,
    });

    const turns = Array.isArray(response?.thread?.turns) ? response.thread.turns : [];
    const targetTurn = turns.find((item: any) => item?.id === turnId) ?? turns[turns.length - 1];
    const items = Array.isArray(targetTurn?.items) ? targetTurn.items : [];
    const texts = items
      .filter((item: any) => item?.type === "agentMessage")
      .map((item: any) => String(item?.text ?? "").trim())
      .filter(Boolean);

    if (!texts.length) {
      throw new Error(`未能从 thread ${threadId} 读取到 turn ${turnId} 的回复文本`);
    }
    return texts[texts.length - 1];
  }

  /**
   * 从已缓存的 delta / item 完成事件中抽取最终文本。
   * @param turn 当前待完成的 turn。
   * @returns 已拼接完成的文本。
   */
  private extractTurnText(turn: PendingTurn): string {
    return [...turn.textByItemId.values()]
      .map((item) => item.trim())
      .filter(Boolean)
      .join("")
      .trim();
  }

  /**
   * 统一解析成功响应。
   * @param message JSON-RPC 成功响应。
   */
  private resolveRequest(message: JsonRpcSuccess): void {
    const pending = this.pendingRequests.get(Number(message.id));
    if (!pending) return;
    this.pendingRequests.delete(Number(message.id));
    pending.resolve(message.result);
  }

  /**
   * 统一解析失败响应。
   * @param message JSON-RPC 错误响应。
   */
  private rejectRequest(message: JsonRpcFailure): void {
    const pending = this.pendingRequests.get(Number(message.id));
    if (!pending) return;
    this.pendingRequests.delete(Number(message.id));
    pending.reject(new Error(message.error?.message || "app-server 请求失败"));
  }

  /**
   * 在连接中断时重置连接态，并拒绝所有未完成请求。
   * @param error 用于传播给外层的错误对象。
   */
  private handleSocketClose(error: Error): void {
    this.ws = null;
    this.initialized = false;
    for (const state of this.threadStates.values()) {
      state.loaded = false;
    }
    this.rejectAll(error);
  }

  /**
   * 拒绝当前所有挂起的 RPC 请求与 turn。
   * @param error 用于传播的错误。
   */
  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      this.pendingRequests.delete(id);
      pending.reject(error);
    }

    for (const [turnId, pendingTurn] of this.pendingTurns.entries()) {
      clearTimeout(pendingTurn.timer);
      this.pendingTurns.delete(turnId);
      pendingTurn.reject(error);
    }
  }

  /**
   * 获取或初始化某个频道的 thread 状态。
   * @param channelId Forum 频道 ID。
   * @returns 频道对应的 thread 状态。
   */
  private getOrCreateThreadState(channelId: string): ThreadState {
    const existing = this.threadStates.get(channelId);
    if (existing) return existing;
    const created: ThreadState = { threadId: null, loaded: false };
    this.threadStates.set(channelId, created);
    return created;
  }

  /**
   * 根据 server request 中自带的 thread/conversation id 找到对应的 pending turn。
   * @param request app-server 反向请求。
   * @returns 当前仍在执行中的 turn。
   */
  private findPendingTurnForRequest(request: CodexServerRequest): PendingTurn | null {
    const threadId = String(
      request.params.threadId
      ?? request.params.conversationId
      ?? ""
    );
    if (!threadId) return null;

    for (const pending of this.pendingTurns.values()) {
      if (pending.threadId === threadId) {
        return pending;
      }
    }
    return null;
  }

  /**
   * 构造没有外部审批处理器时的默认响应，优先显式拒绝而不是悬挂。
   * @param request app-server 反向请求。
   * @returns 可直接回写给 app-server 的 result 对象。
   */
  private buildDefaultServerRequestResponse(request: CodexServerRequest): unknown {
    switch (request.method) {
      case "item/commandExecution/requestApproval":
        return { decision: "decline" };
      case "item/fileChange/requestApproval":
        return { decision: "decline" };
      case "item/permissions/requestApproval":
        return {
          permissions: {
            network: null,
            fileSystem: null,
          },
          scope: "turn",
        };
      case "applyPatchApproval":
      case "execCommandApproval":
        return { decision: "denied" };
      case "item/tool/requestUserInput":
        return { answers: {} };
      case "mcpServer/elicitation/request":
        return { action: "decline", content: null, _meta: null };
      case "item/tool/call":
        return { contentItems: [], success: false };
      default:
        throw new Error(`不支持的 app-server 请求方法: ${request.method}`);
    }
  }

  /**
   * 判断给定方法名是否属于 server request。
   * @param method JSON-RPC 方法名。
   * @returns 是否为需要显式 response 的反向请求。
   */
  private isServerRequest(method: string): method is ServerRequestMethod {
    return [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "item/tool/requestUserInput",
      "mcpServer/elicitation/request",
      "item/tool/call",
      "applyPatchApproval",
      "execCommandApproval",
      "account/chatgptAuthTokens/refresh",
    ].includes(method);
  }

  /**
   * 向 app-server 回写 JSON-RPC 成功响应。
   * @param id 原请求 id。
   * @param result result 对象。
   */
  private sendRpcResult(id: number | string, result: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ id, result }));
  }

  /**
   * 向 app-server 回写 JSON-RPC 错误响应。
   * @param id 原请求 id。
   * @param code JSON-RPC 错误码。
   * @param message 错误文本。
   */
  private sendRpcError(id: number | string, code: number, message: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ id, error: { code, message } }));
  }

  /**
   * 连接到目标 WebSocket 地址，支持短时间重试等待本地 app-server 就绪。
   * @param url WebSocket 地址。
   * @param headers 可选 HTTP 头。
   * @returns 已打开的 WebSocket 连接。
   */
  private async connectWebSocket(url: string, headers?: Record<string, string>): Promise<WebSocket> {
    const deadline = Date.now() + 15_000;
    let lastError: unknown = null;

    while (Date.now() < deadline) {
      try {
        return await new Promise<WebSocket>((resolve, reject) => {
          const ws = new WebSocket(url, headers ? { headers } : undefined);

          const handleOpen = (): void => {
            cleanup();
            resolve(ws);
          };
          const handleError = (error: Error): void => {
            cleanup();
            ws.close();
            reject(error);
          };
          const handleClose = (): void => {
            cleanup();
            reject(new Error("WebSocket 在建立前已关闭"));
          };
          const cleanup = (): void => {
            ws.off("open", handleOpen);
            ws.off("error", handleError);
            ws.off("close", handleClose);
          };

          ws.once("open", handleOpen);
          ws.once("error", handleError);
          ws.once("close", handleClose);
        });
      } catch (error) {
        lastError = error;
        await this.sleep(250);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`连接 app-server 失败: ${url}`);
  }

  /**
   * 获取一个当前可用的本地 TCP 端口，用于拉起受管 app-server。
   * @returns 空闲端口号。
   */
  private async getAvailablePort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close(() => reject(new Error("无法获取空闲端口")));
          return;
        }
        const { port } = address;
        server.close((error) => {
          if (error) reject(error);
          else resolve(port);
        });
      });
    });
  }

  /**
   * 简单的异步 sleep。
   * @param ms 等待毫秒数。
   */
  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
