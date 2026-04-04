import { sendChannelMessagingError } from '../support/http.mjs';

/**
 * 注册频道讨论状态机相关路由。
 * @param {object} context
 */
export function registerChannelDiscussionRoutes(context) {
  const { router, auth, db, sendJson, ws, messaging } = context;
  const { addRoute } = router;
  const { authAgent } = auth;

  /** GET /api/v1/channels/:id/discussions/:sessionId - 获取讨论详情 */
  addRoute('GET', '/api/v1/channels/:id/discussions/:sessionId', authAgent, (req, res) => {
    const member = db.get(`SELECT agent_id FROM channel_members
      WHERE channel_id = ${db.esc(req.params.id)} AND agent_id = ${db.esc(req.agent.id)}`);
    if (!member) return sendJson(res, 403, { error: 'Must be a channel member' });

    const session = messaging.getDiscussionSession(req.params.sessionId);
    if (!session || session.channel_id !== req.params.id) {
      return sendJson(res, 404, { error: 'Discussion session not found' });
    }

    const discussion = messaging.buildDiscussionStateSnapshot(session);
    const transitions = messaging.getDiscussionTransitions(req.params.sessionId);
    sendJson(res, 200, { discussion, transitions });
  });

  /** POST /api/v1/channels/:id/discussions/:sessionId/submit-approval - Agent 提交审批请求 */
  addRoute('POST', '/api/v1/channels/:id/discussions/:sessionId/submit-approval', authAgent, (req, res) => {
    const member = db.get(`SELECT agent_id FROM channel_members
      WHERE channel_id = ${db.esc(req.params.id)} AND agent_id = ${db.esc(req.agent.id)}`);
    if (!member) return sendJson(res, 403, { error: 'Must be a channel member' });

    try {
      const result = messaging.submitForApproval({
        sessionId: req.params.sessionId,
        channelId: req.params.id,
        triggeredBy: req.agent.id,
        triggeredByName: req.agent.name,
      });

      ws.broadcastChannel(req.params.id, {
        type: 'discussion.status_changed',
        payload: {
          sessionId: req.params.sessionId,
          channelId: req.params.id,
          fromStatus: result.transition.from,
          toStatus: result.transition.to,
          triggeredBy: req.agent.id,
          triggeredByName: req.agent.name,
        },
        timestamp: new Date().toISOString(),
        channelId: req.params.id,
      });

      sendJson(res, 200, { discussion: result.discussion });
    } catch (err) {
      sendChannelMessagingError(sendJson, res, err);
    }
  });

  /** POST /api/v1/channels/:id/discussions/:sessionId/approve - 被授权 Agent 批准讨论 */
  addRoute('POST', '/api/v1/channels/:id/discussions/:sessionId/approve', authAgent, (req, res) => {
    const member = db.get(`SELECT agent_id FROM channel_members
      WHERE channel_id = ${db.esc(req.params.id)} AND agent_id = ${db.esc(req.agent.id)}`);
    if (!member) return sendJson(res, 403, { error: 'Must be a channel member' });

    const { resolution } = req.body || {};

    try {
      const result = messaging.approveDiscussion({
        sessionId: req.params.sessionId,
        channelId: req.params.id,
        triggeredBy: req.agent.id,
        triggeredByName: req.agent.name,
        resolution: resolution || null,
      });

      ws.broadcastChannel(req.params.id, {
        type: 'discussion.status_changed',
        payload: {
          sessionId: req.params.sessionId,
          channelId: req.params.id,
          fromStatus: result.transition.from,
          toStatus: result.transition.to,
          triggeredBy: req.agent.id,
          triggeredByName: req.agent.name,
          resolution: resolution || null,
        },
        timestamp: new Date().toISOString(),
        channelId: req.params.id,
      });

      sendJson(res, 200, { discussion: result.discussion });
    } catch (err) {
      sendChannelMessagingError(sendJson, res, err);
    }
  });

  /** POST /api/v1/channels/:id/discussions/:sessionId/reject - 被授权 Agent 拒绝讨论 */
  addRoute('POST', '/api/v1/channels/:id/discussions/:sessionId/reject', authAgent, (req, res) => {
    const member = db.get(`SELECT agent_id FROM channel_members
      WHERE channel_id = ${db.esc(req.params.id)} AND agent_id = ${db.esc(req.agent.id)}`);
    if (!member) return sendJson(res, 403, { error: 'Must be a channel member' });

    const { reason } = req.body || {};

    try {
      const result = messaging.rejectDiscussion({
        sessionId: req.params.sessionId,
        channelId: req.params.id,
        triggeredBy: req.agent.id,
        triggeredByName: req.agent.name,
        reason: reason || null,
      });

      ws.broadcastChannel(req.params.id, {
        type: 'discussion.status_changed',
        payload: {
          sessionId: req.params.sessionId,
          channelId: req.params.id,
          fromStatus: result.transition.from,
          toStatus: result.transition.to,
          triggeredBy: req.agent.id,
          triggeredByName: req.agent.name,
          reason: reason || null,
        },
        timestamp: new Date().toISOString(),
        channelId: req.params.id,
      });

      sendJson(res, 200, { discussion: result.discussion });
    } catch (err) {
      sendChannelMessagingError(sendJson, res, err);
    }
  });
}
