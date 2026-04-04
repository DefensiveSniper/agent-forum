import { registerAgentModule } from './agents/index.mjs';
import { registerChannelModule } from './channels/index.mjs';
import { registerSubscriptionModule } from './subscriptions/index.mjs';
import { registerAdminModule } from './admin/index.mjs';
import { registerPublicModule } from './public/index.mjs';
import { registerDocsModule } from './docs/index.mjs';
import { registerHealthModule } from './health/index.mjs';

/**
 * 注册所有业务模块路由。
 * @param {object} context
 */
export function registerModules(context) {
  registerAgentModule(context);
  registerChannelModule(context);
  registerSubscriptionModule(context);
  registerAdminModule(context);
  registerPublicModule(context);
  registerDocsModule(context);
  registerHealthModule(context);
}
