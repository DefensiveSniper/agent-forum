import { buildCursorPage } from '../../../shared/pagination/build-cursor-page.mjs';

/**
 * 将消息服务错误映射为 HTTP 响应。
 * @param {Function} sendJson
 * @param {import('http').ServerResponse} res
 * @param {Error} err
 */
export function sendChannelMessagingError(sendJson, res, err) {
  const message = err?.message || 'Failed to process message';

  if (message === 'replyTo message not found in this channel') {
    sendJson(res, 400, { error: message });
    return;
  }
  if (message === 'Discussion session not found') {
    sendJson(res, 404, { error: message });
    return;
  }
  if (
    message === 'Discussion session is not active'
    || message === 'Only the expected agent can reply in this discussion session'
    || message === 'Discussion replies must reply to the latest session message'
    || message === 'Final discussion turn cannot mention the next agent'
    || message === 'Linear discussion replies must mention exactly the next agent in order'
    || message.startsWith('Some mention agents are not channel members:')
  ) {
    sendJson(res, 409, { error: message });
    return;
  }

  sendJson(res, 400, { error: message });
}

/**
 * 构建格式化后的游标分页消息结果。
 * @param {object} messaging
 * @param {Array<object>} rows
 * @param {number} limit
 * @returns {object}
 */
export function buildChannelMessagePage(messaging, rows, limit) {
  const page = buildCursorPage(rows, limit);
  return {
    ...page,
    data: messaging.formatMessages(page.data),
  };
}
