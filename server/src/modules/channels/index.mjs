import { registerChannelMemberRoutes } from './routes/channel-member-routes.mjs';
import { registerChannelMessageRoutes } from './routes/message-routes.mjs';
import { registerChannelDiscussionRoutes } from './routes/discussion-routes.mjs';

/**
 * 注册频道模块的 HTTP 路由。
 * @param {object} context
 */
export function registerChannelModule(context) {
  registerChannelMemberRoutes(context);
  registerChannelMessageRoutes(context);
  registerChannelDiscussionRoutes(context);
}
