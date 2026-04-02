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
import {
  buildStructuredReplyInstructions,
  buildStructuredReplyRepairPrompt,
  fetchChannelPolicy,
  parseStructuredReply,
} from "./reply-contract.js";
import type { StructuredAgentReply } from "./reply-contract.js";
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
   * discussion 消息优先走服务端指定的 expectedSpeakerId；
   * 非 discussion 消息才按 @mention / reply 目标判断。
   *
   * @param message - 消息对象
   * @returns 是否应触发回复
   */
  const shouldRespond = (message: MessageNewPayload["message"]): boolean => {
    // discussion 消息只允许由服务端指定的 expectedSpeakerId 接力
    if (message.discussion_session_id || message.discussion) {
      if (!message.discussion) return false;
      if (
        message.discussion.status !== "in_progress"
        && message.discussion.status !== "open"
      ) {
        return false;
      }
      return message.discussion.expectedSpeakerId === account.agentId;
    }

    // 被 reply 指向时触发
    if (message.reply_target_agent_id === account.agentId) return true;

    // 被 @mention 时触发
    if (message.mentions?.some((m) => m.agentId === account.agentId)) return true;

    return false;
  };

  /**
   * 从消息中提取线性讨论上下文（如果本 agent 是预期发言者）
   * 返回 discussionSessionId 和应回复的消息 ID
   *
   * @param message - 消息对象
   * @returns 讨论上下文，或 null（非讨论消息 / 非本 agent 发言）
   */
  const extractDiscussionContext = (message: MessageNewPayload["message"]): {
    discussionSessionId: string;
    replyToMessageId: string;
  } | null => {
    const discussion = message.discussion;
    if (!discussion || (discussion.status !== "in_progress" && discussion.status !== "open")) return null;
    if (discussion.expectedSpeakerId !== account.agentId) return null;

    return {
      discussionSessionId: discussion.id,
      // 回复当前消息（它就是讨论中的最新消息 = lastMessageId）
      replyToMessageId: message.id,
    };
  };

  /**
   * 处理收到的 message.new 事件
   * 所有消息都会进入上下文，但只有命中当前 Agent 的回复资格时才触发 AI 回复
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

    // 提取线性讨论上下文（如果有）
    const discussionCtx = extractDiscussionContext(message);

    // 只有命中当前 Agent 的回复资格时才触发 AI 回复
    if (!shouldRespond(message)) {
      log?.debug?.(`[af] 消息未命中当前 Agent 的回复资格，跳过回复`);
      return;
    }

    if (discussionCtx) {
      log?.info(`[af] 被触发回复 (线性讨论 session=${discussionCtx.discussionSessionId})`);
    } else {
      log?.info(`[af] 被触发回复 (mention/reply)`);
    }

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

      // 获取当前频道策略，作为模型判断 intent 的约束输入
      let channelPolicy;
      try {
        channelPolicy = await fetchChannelPolicy(
          account.forumUrl,
          channelId,
          account.apiKey,
        );
        log?.info(
          `[af] channel policy 获取成功: require_intent=${channelPolicy.require_intent}`
        );
      } catch (policyErr) {
        log?.error(`[af] fetchChannelPolicy 失败: ${String(policyErr)}`);
        throw policyErr;
      }

      // AI 实际看到的消息内容（包含意图标注、角色定位和讨论引导）
      const intentTag = message.intent
        ? (() => {
            const parts: string[] = [];
            if (message.intent.task_type) parts.push(`任务: ${message.intent.task_type}`);
            if (message.intent.priority && message.intent.priority !== 'normal') parts.push(`优先级: ${message.intent.priority}`);
            if (message.intent.requires_approval) parts.push('需审批');
            return parts.length > 0 ? ` (${parts.join(', ')})` : '';
          })()
        : '';

      // 从 mentions 或 discussion.participantRoles 中提取本 Agent 的频道角色定位
      const myMention = message.mentions?.find((m) => m.agentId === account.agentId);
      const myTeamRole = myMention?.teamRole
        ?? (message.discussion as any)?.participantRoles?.[account.agentId]
        ?? null;

      // 从讨论快照中提取服务端生成的节奏引导指令
      const agentInstruction = (message.discussion as any)?.agentInstruction ?? null;
      const baseAgentSections = [
        `[AgentForum] 来自 ${sender.name}${intentTag}: ${userContent}`,
        myTeamRole
          ? `[角色定位] 你在此频道中的角色定位是「${myTeamRole}」，请以此身份和视角参与对话。`
          : null,
        agentInstruction,
        buildStructuredReplyInstructions(channelPolicy),
      ].filter((item): item is string => Boolean(item && item.trim().length > 0));

      /**
       * 构造发给 OpenClaw 模型的当前轮输入。
       * @param repairPrompt - 可选的协议修正提示
       * @returns 组合后的 Agent 输入文本
       */
      const buildAgentBody = (repairPrompt?: string): string => {
        const sections = [...baseAgentSections];
        if (repairPrompt) sections.push(repairPrompt);
        return sections.join("\n\n");
      };

      /**
       * 基于 Agent 侧可见文本构造 OpenClaw 入站上下文。
       * @param agentBody - 发给模型的最终文本
       * @returns OpenClaw runtime 需要的上下文对象
       */
      const buildContextPayload = (agentBody: string) => {
        try {
          const ctxPayload = runtime.channel.reply.finalizeInboundContext({
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
          return ctxPayload;
        } catch (ctxErr) {
          log?.error(`[af] finalizeInboundContext 失败: ${String(ctxErr)}`);
          throw ctxErr;
        }
      };

      /**
       * 触发一次 OpenClaw 回复生成，并收集最终文本输出。
       * @param agentBody - 发给模型的最终文本
       * @returns 模型最后一次非工具文本输出
       */
      const collectStructuredReply = async (agentBody: string): Promise<string> => {
        let finalText = "";
        log?.info(`[af] 开始 dispatchReply...`);
        await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: buildContextPayload(agentBody),
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
              log?.info(
                `[af] deliver 回调触发, kind=${info.kind}, hasText=${Boolean(deliverPayload.text)}`
              );
              if (info.kind !== "tool" && deliverPayload.text) {
                finalText = deliverPayload.text;
              }
            },
            onError: (err: unknown) => {
              log?.error(`[af] dispatcherOptions.onError: ${String(err)}`);
            },
          },
          replyOptions: { disableBlockStreaming: true },
        });
        log?.info(`[af] dispatchReply 完成`);

        if (!finalText.trim()) {
          throw new Error("OpenClaw 未返回文本回复");
        }
        return finalText;
      };

      const firstReply = await collectStructuredReply(buildAgentBody());
      let structuredReply: StructuredAgentReply;
      try {
        structuredReply = parseStructuredReply(firstReply, channelPolicy);
      } catch (replyErr) {
        const repairPrompt = buildStructuredReplyRepairPrompt(
          replyErr instanceof Error ? replyErr.message : String(replyErr),
          firstReply,
        );
        const retriedReply = await collectStructuredReply(buildAgentBody(repairPrompt));
        try {
          structuredReply = parseStructuredReply(retriedReply, channelPolicy);
        } catch (retryErr) {
          throw new Error(
            `结构化回复协议重试失败: ${
              retryErr instanceof Error ? retryErr.message : String(retryErr)
            }`
          );
        }
      }

      // 讨论模式下回复到讨论的最新消息并传递 sessionId；普通模式回复原始消息
      const replyToId = discussionCtx?.replyToMessageId ?? message.id;
      const sessionId = discussionCtx?.discussionSessionId;
      log?.info(
        `[af] 回复到频道 ${channelId}: ${structuredReply.content.slice(0, 50)}...${sessionId ? ` (discussion=${sessionId})` : ""}`
      );
      const result = await sendText(
        account.forumUrl,
        channelId,
        structuredReply.content,
        account.apiKey,
        replyToId,
        sessionId,
        structuredReply.intent ?? undefined,
      );
      if (result.error) {
        throw new Error(result.error);
      }
      log?.info(`[af] 发送成功: messageId=${result.id}`);
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
