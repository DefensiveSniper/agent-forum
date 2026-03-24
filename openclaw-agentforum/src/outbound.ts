/**
 * AgentForum 出站消息发送
 *
 * 通过 REST API 将 OpenClaw 的 AI 回复发送到 AgentForum 频道。
 * 所有发送操作都走 POST /api/v1/channels/:channelId/messages 端点。
 *
 * 注意:
 * - AgentForum 当前仅支持纯文本/markdown，不支持媒体附件
 * - 服务端返回字段存在 camelCase / snake_case 混用
 */

import type { SendMessageResult } from "./types.js";

/**
 * 向指定频道发送文本消息
 *
 * @param forumUrl - AgentForum 服务地址（如 http://localhost:3000）
 * @param channelId - 目标频道 ID
 * @param text - 消息内容
 * @param apiKey - Agent 的 API Key（af_xxx 格式）
 * @param replyTo - 可选，要回复的消息 ID
 * @param discussionSessionId - 可选，线性讨论会话 ID（服务端会自动注入下一位 agent 的 mention）
 * @returns 发送结果，包含消息 ID 或错误信息
 */
export async function sendText(
  forumUrl: string,
  channelId: string,
  text: string,
  apiKey: string,
  replyTo?: string,
  discussionSessionId?: string
): Promise<SendMessageResult> {
  try {
    const url = `${forumUrl}/api/v1/channels/${channelId}/messages`;

    const body: Record<string, string> = {
      content: text,
      contentType: "markdown",
    };
    if (replyTo) {
      body.replyTo = replyTo;
    }
    if (discussionSessionId) {
      body.discussionSessionId = discussionSessionId;
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { id: "", error: `HTTP ${res.status}: ${errText}` };
    }

    const data = (await res.json()) as Record<string, unknown>;
    return { id: (data.id as string) ?? "", error: undefined };
  } catch (err) {
    return { id: "", error: `sendText failed: ${String(err)}` };
  }
}

/**
 * 向指定频道发送带 @mention 的消息
 * 在多 Agent 协作场景中用于触发特定 Agent 的回复
 *
 * @param forumUrl - AgentForum 服务地址
 * @param channelId - 目标频道 ID
 * @param text - 消息内容
 * @param apiKey - Agent 的 API Key
 * @param mentionAgentIds - 要 @mention 的 Agent ID 数组
 * @param replyTo - 可选，要回复的消息 ID
 * @returns 发送结果
 */
export async function sendTextWithMentions(
  forumUrl: string,
  channelId: string,
  text: string,
  apiKey: string,
  mentionAgentIds: string[],
  replyTo?: string
): Promise<SendMessageResult> {
  try {
    const url = `${forumUrl}/api/v1/channels/${channelId}/messages`;

    const body: Record<string, unknown> = {
      content: text,
      contentType: "markdown",
      mentionAgentIds,
    };
    if (replyTo) {
      body.replyTo = replyTo;
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { id: "", error: `HTTP ${res.status}: ${errText}` };
    }

    const data = (await res.json()) as Record<string, unknown>;
    return { id: (data.id as string) ?? "", error: undefined };
  } catch (err) {
    return { id: "", error: `sendTextWithMentions failed: ${String(err)}` };
  }
}
