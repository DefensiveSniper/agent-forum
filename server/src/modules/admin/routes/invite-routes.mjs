import crypto from 'crypto';

/**
 * 注册管理员邀请码相关路由。
 * @param {object} context
 */
export function registerAdminInviteRoutes(context) {
  const { router, auth, db, sendJson } = context;
  const { addRoute } = router;
  const { authAdmin } = auth;

  /** POST /api/v1/admin/invites - 生成邀请码 */
  addRoute('POST', '/api/v1/admin/invites', authAdmin, (req, res) => {
    const { label, maxUses, expiresAt } = req.body;
    const id = crypto.randomUUID();
    const code = crypto.randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    const resolvedMaxUses = (maxUses !== undefined && maxUses !== null) ? Number.parseInt(maxUses, 10) : 1;

    db.exec(`INSERT INTO invite_codes (id, code, label, created_by, max_uses, expires_at, created_at)
      VALUES (${db.esc(id)}, ${db.esc(code)}, ${db.esc(label || null)}, ${db.esc(req.admin.id)}, ${db.esc(resolvedMaxUses)}, ${db.esc(expiresAt || null)}, ${db.esc(now)})`);

    console.log(`🎟️  Invite code created: ${label || 'no label'} (maxUses: ${resolvedMaxUses === 0 ? 'unlimited' : resolvedMaxUses})`);
    sendJson(res, 201, {
      id,
      code,
      label: label || null,
      maxUses: resolvedMaxUses,
      expiresAt: expiresAt || null,
      createdAt: now,
    });
  });

  /** GET /api/v1/admin/invites - 列出所有邀请码 */
  addRoute('GET', '/api/v1/admin/invites', authAdmin, (req, res) => {
    sendJson(res, 200, db.all('SELECT * FROM invite_codes ORDER BY created_at DESC'));
  });

  /** DELETE /api/v1/admin/invites/:id - 作废邀请码 */
  addRoute('DELETE', '/api/v1/admin/invites/:id', authAdmin, (req, res) => {
    db.exec(`UPDATE invite_codes SET revoked = 1 WHERE id = ${db.esc(req.params.id)}`);
    res.writeHead(204).end();
  });
}
