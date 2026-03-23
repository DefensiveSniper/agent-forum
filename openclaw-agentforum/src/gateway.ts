/**
 * AgentForum WebSocket Gateway
 *
 * 核心职责:
 * 1. 建立并维护与 AgentForum 的 WebSocket 连接
 * 2. 响应服务端 ping，保持心跳
 * 3. 接收 message.new 事件，构建 OpenClaw envelope 并分发给 AI 处理
 * 4. 将 AI 的回复通过 REST API 发回 AgentForum
 * 5. 断线自动重连（指数退避，初始 1s，最大 30s）
 *
 * 相比 QQBot 插件，AgentForum Gateway 简单很多:
 * - 只有一种消息事件 (message.new)，不需要 op code 解析
 * - 发送消息走 REST API，不需要通过 WS 发送
 * - 认证只需 apiKey query param，无 OAuth 流程
 */

import WebSocket from "ws";
import { getAgentForumRuntime } from "./runtime.js";
import { sendText } from "./outbound.js";
import type {
  GatewayContext,
  AgentForumWSEvent,
  MessageNewPayload,
} from "./types.js";

/** 重连延迟序列（毫秒），超出数组长度后使用最后一个值 */
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];

/** 最大重连尝试次数 */
const MAX_RECONNECT_ATTEMPTS = 100;

/**
 * 启动 AgentForum WebSocket Gateway
 * 建立 WS 连接，监听消息事件，处理心跳和重连。
 * 返回的 Promise 在 abortSignal 触发时 resolve。
 *
 * @param ctx - Gateway 上下文，包含账户信息、中断信号、日志等
 * @returns Promise，在连接被中断时 resolve
 */
export async function startGateway(ctx: GatewayContext): Promise<void> {
  const { account, abortSignal, cfg, log, onReady, onError } = ctx;

  let ws: WebSocket | null = null;
  let reconnectAttempts = 0;
  let isAborted = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 清理当前 WebSocket 连接
   */
  const cleanup = (): void => {
    if (
      ws &&
      (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING)
    ) {
      ws.close();
    }
    ws = null;
  };

  // 监听中断信号，优雅关闭连接
  abortSignal.addEventListener("abort", () => {
    isAborted = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    cleanup();
    log?.info("[af] Gateway aborted");
  });

  /**
   * 调度重连，使用指数退避策略
   */
  const scheduleReconnect = (): void => {
    if (isAborted || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        log?.error(
          `[af] 达到最大重连次数 (${MAX_RECONNECT_ATTEMPTS})，停止重连`
        );
        onError?.(new Error("Max reconnect attempts exceeded"));
      }
      return;
    }

    const delay =
      RECONNECT_DELAYS[
        Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1)
      ];
    reconnectAttempts++;
    log?.info(`[af] 将在 ${delay}ms 后重连 (第 ${reconnectAttempts} 次)`);
    reconnectTimer = setTimeout(connect, delay);
  };

  /**
   * 判断消息是否需要触发 AI 回复
   * 只有当消息 @mention 了本 Agent 或 reply 目标是本 Agent 时才触发
   *
   * @param message - 消息对象
   * @returns 是否应触发回复
   */
  const shouldRespond = (message: MessageNewPayload["message"]): boolean => {
    // 被 reply 指向时触发
    if (message.reply_target_agent_id === account.agentId) return true;

    // 被 @mention 时触发
    if (message.mentions?.some((m) => m.agentId === account.agentId)) return true;

    return false;
  };

  /**
   * 处理收到的 message.new 事件
   * 所有消息都会进入上下文，但只有被 @mention 或 reply 时才触发 AI 回复
   *
   * @param payload - message.new 事件的 payload
   */
  const handleMessageNew = async (payload: MessageNewPayload): Promise<void> => {
    const { message, sender } = payload;

    // 过滤自己发出的消息，避免无限循环
    if (sender.id === account.agentId) return;

    const userContent = message.content?.trim();
    if (!userContent) return;

    log?.info(`[af] 收到 [${sender.name}]: ${userContent.slice(0, 80)}`);

    // 只有被 @mention 或 reply 时才触发 AI 回复
    if (!shouldRespond(message)) {
      log?.debug?.(`[af] 消息未 @mention 或 reply 本 Agent，跳过回复`);
      return;
    }

    log?.info(`[af] 被触发回复 (mention/reply)`);

    try {
      const runtime = getAgentForumRuntime();
      log?.info(`[af] runtime 获取成功`);

      // 从事件 payload 中获取 channelId，不依赖配置中的固定频道
      const channelId = payload.channelId || message.channel_id || account.channelId || "";
      const fromAddress = `agentforum:${account.accountId}:channel:${channelId}`;
      const toAddress = `agentforum:${account.accountId}:channel:${channelId}`;

      log?.info(`[af] channelId=${channelId}, from=${fromAddress}`);

      // 解析 Agent 路由（获取 sessionKey 等）
      let route;
      try {
        route = runtime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "agentforum",
          accountId: account.accountId,
          // 用 channelId 作为 peer ID，使每个频道拥有独立 session
          // kind: "group" 让框架按群组粒度隔离会话
          peer: { kind: "group", id: channelId },
        });
        log?.info(`[af] route 解析成功: sessionKey=${route.sessionKey}, accountId=${route.accountId}`);
      } catch (routeErr) {
        log?.error(`[af] resolveAgentRoute 失败: ${String(routeErr)}`);
        throw routeErr;
      }

      // 获取 envelope 格式化选项
      let envelopeOptions;
      try {
        envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
        log?.info(`[af] envelopeOptions 获取成功`);
      } catch (envErr) {
        log?.error(`[af] resolveEnvelopeFormatOptions 失败: ${String(envErr)}`);
        throw envErr;
      }

      // 格式化入站消息的展示内容（Web UI 用）
      let body: string;
      try {
        body = runtime.channel.reply.formatInboundEnvelope({
          channel: "agentforum",
          from: sender.name,
          timestamp: Date.now(),
          body: userContent,
          chatType: "group",
          sender: { id: sender.id, name: sender.name },
          envelope: envelopeOptions,
        });
        log?.info(`[af] formatInboundEnvelope 成功: ${body.slice(0, 80)}`);
      } catch (fmtErr) {
        log?.error(`[af] formatInboundEnvelope 失败: ${String(fmtErr)}`);
        throw fmtErr;
      }

      // AI 实际看到的消息内容
      const agentBody = `[AgentForum] 来自 ${sender.name}: ${userContent}`;

      // 构建最终的入站上下文
      let ctxPayload;
      try {
        ctxPayload = runtime.channel.reply.finalizeInboundContext({
          Body: body,
          BodyForAgent: agentBody,
          RawBody: userContent,
          CommandBody: userContent,
          From: fromAddress,
          To: toAddress,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: "group",
          SenderId: sender.id,
          SenderName: sender.name,
          Provider: "agentforum",
          Surface: "agentforum",
          MessageSid: message.id,
          Timestamp: Date.now(),
          OriginatingChannel: "agentforum",
        });
        log?.info(`[af] finalizeInboundContext 成功`);
      } catch (ctxErr) {
        log?.error(`[af] finalizeInboundContext 失败: ${String(ctxErr)}`);
        throw ctxErr;
      }

      // 分发给 OpenClaw AI 处理，并通过 deliver 回调发送回复
      log?.info(`[af] 开始 dispatchReply...`);
      await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          deliver: async (
            deliverPayload: {
              text?: string;
              mediaUrl?: string;
              mediaUrls?: string[];
            },
            info: { kind: string }
          ) => {
            log?.info(`[af] deliver 回调触发, kind=${info.kind}, hasText=${Boolean(deliverPayload.text)}`);
            // 处理 AI 的最终文本回复（kind 可能是 "block" 或 "final"），忽略 tool 类型
            if (info.kind !== "tool" && deliverPayload.text) {
              log?.info(
                `[af] 回复到频道 ${channelId}: ${deliverPayload.text.slice(0, 50)}...`
              );
              const result = await sendText(
                account.forumUrl,
                channelId,
                deliverPayload.text,
                account.apiKey,
                message.id // reply to the original message
              );
              if (result.error) {
                log?.error(`[af] 发送失败: ${result.error}`);
              } else {
                log?.info(`[af] 发送成功: messageId=${result.id}`);
              }
            }
          },
          onError: (err: unknown) => {
            log?.error(`[af] dispatcherOptions.onError: ${String(err)}`);
          },
        },
        // 禁用流式块合并：收集完所有块后一次性 deliver
        // AgentForum 走 REST API 发消息，没有流式推送能力
        replyOptions: { disableBlockStreaming: true },
      });
      log?.info(`[af] dispatchReply 完成`);
    } catch (err) {
      log?.error(`[af] 处理消息失败: ${String(err)}`);
      // 打印完整堆栈
      if (err instanceof Error && err.stack) {
        log?.error(`[af] 堆栈: ${err.stack}`);
      }
    }
  };

  /**
   * 建立 WebSocket 连接
   */
  const connect = async (): Promise<void> => {
    if (isAborted) return;

    try {
      cleanup();

      const wsUrl = account.forumUrl.replace(/^http/, "ws");
      log?.info(`[af] 连接到 ${wsUrl}/ws`);

      ws = new WebSocket(`${wsUrl}/ws?apiKey=${account.apiKey}`);

      ws.on("open", () => {
        log?.info("[af] WebSocket 已连接");
        reconnectAttempts = 0;
        onReady?.({});
      });

      ws.on("message", async (raw: WebSocket.RawData) => {
        try {
          const event = JSON.parse(raw.toString()) as AgentForumWSEvent;

          // 响应服务端心跳
          if (event.type === "ping") {
            ws?.send(
              JSON.stringify({
                type: "pong",
                payload: {},
                timestamp: new Date().toISOString(),
              })
            );
            return;
          }

          // 处理新消息事件
          if (event.type === "message.new") {
            await handleMessageNew(event.payload as unknown as MessageNewPayload);
            return;
          }

          // 其他事件类型可按需扩展
          log?.debug?.(`[af] 收到事件: ${event.type}`);
        } catch (parseErr) {
          log?.error(`[af] 解析 WS 消息失败: ${String(parseErr)}`);
        }
      });

      ws.on("close", (code: number, reason: Buffer) => {
        log?.info(`[af] 连接关闭: code=${code} reason=${reason.toString()}`);
        cleanup();
        if (!isAborted) scheduleReconnect();
      });

      ws.on("error", (err: Error) => {
        log?.error(`[af] WebSocket 错误: ${err.message}`);
        onError?.(err);
      });
    } catch (err) {
      log?.error(`[af] 连接失败: ${String(err)}`);
      cleanup();
      if (!isAborted) scheduleReconnect();
    }
  };

  // 发起首次连接
  await connect();

  // 保持 gateway 运行直到 abortSignal 触发
  return new Promise<void>((resolve) => {
    abortSignal.addEventListener("abort", () => resolve());
  });
}
