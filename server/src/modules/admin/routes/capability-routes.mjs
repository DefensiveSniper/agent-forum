import crypto from 'crypto';
import { VALID_CATEGORIES, VALID_PROFICIENCIES } from '../../../shared/capabilities/constants.mjs';

/**
 * 注册管理员能力目录相关路由。
 * @param {object} context
 */
export function registerAdminCapabilityRoutes(context) {
  const { router, auth, db, sendJson } = context;
  const { addRoute } = router;
  const { authAdmin } = auth;

  /** POST /api/v1/admin/capabilities - 新增能力到目录 */
  addRoute('POST', '/api/v1/admin/capabilities', authAdmin, (req, res) => {
    const { name, displayName, category, description } = req.body;
    if (!name || !displayName || !category) {
      return sendJson(res, 400, { error: 'name, displayName, and category are required' });
    }
    if (!VALID_CATEGORIES.has(category)) {
      return sendJson(res, 400, { error: `category must be one of: ${[...VALID_CATEGORIES].join(', ')}` });
    }
    if (db.get(`SELECT id FROM capability_catalog WHERE name = ${db.esc(name)}`)) {
      return sendJson(res, 409, { error: 'Capability name already exists' });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.exec(`INSERT INTO capability_catalog (id, name, display_name, category, description, created_at, created_by)
      VALUES (${db.esc(id)}, ${db.esc(name)}, ${db.esc(displayName)}, ${db.esc(category)}, ${db.esc(description || null)}, ${db.esc(now)}, ${db.esc(req.admin.username)})`);

    sendJson(res, 201, db.get(`SELECT * FROM capability_catalog WHERE id = ${db.esc(id)}`));
  });

  /** GET /api/v1/admin/capabilities - 列出能力目录 */
  addRoute('GET', '/api/v1/admin/capabilities', authAdmin, (req, res) => {
    const catalog = db.all('SELECT * FROM capability_catalog ORDER BY category, name');
    const counts = db.all('SELECT capability, COUNT(*) AS agent_count FROM agent_capabilities GROUP BY capability');
    const countMap = new Map(counts.map((row) => [row.capability, row.agent_count]));

    sendJson(res, 200, catalog.map((capability) => ({ ...capability, agent_count: countMap.get(capability.name) || 0 })));
  });

  /** PATCH /api/v1/admin/capabilities/:id - 编辑能力定义 */
  addRoute('PATCH', '/api/v1/admin/capabilities/:id', authAdmin, (req, res) => {
    const cap = db.get(`SELECT * FROM capability_catalog WHERE id = ${db.esc(req.params.id)}`);
    if (!cap) return sendJson(res, 404, { error: 'Capability not found' });

    const { displayName, category, description } = req.body;
    const sets = [];
    if (displayName !== undefined) sets.push(`display_name = ${db.esc(displayName)}`);
    if (category !== undefined) {
      if (!VALID_CATEGORIES.has(category)) {
        return sendJson(res, 400, { error: `category must be one of: ${[...VALID_CATEGORIES].join(', ')}` });
      }
      sets.push(`category = ${db.esc(category)}`);
    }
    if (description !== undefined) sets.push(`description = ${db.esc(description)}`);

    if (sets.length > 0) {
      db.exec(`UPDATE capability_catalog SET ${sets.join(', ')} WHERE id = ${db.esc(req.params.id)}`);
    }

    sendJson(res, 200, db.get(`SELECT * FROM capability_catalog WHERE id = ${db.esc(req.params.id)}`));
  });

  /** DELETE /api/v1/admin/capabilities/:id - 删除能力定义 */
  addRoute('DELETE', '/api/v1/admin/capabilities/:id', authAdmin, (req, res) => {
    const cap = db.get(`SELECT * FROM capability_catalog WHERE id = ${db.esc(req.params.id)}`);
    if (!cap) return sendJson(res, 404, { error: 'Capability not found' });

    db.exec(`DELETE FROM agent_capabilities WHERE capability = ${db.esc(cap.name)}`);
    db.exec(`DELETE FROM capability_catalog WHERE id = ${db.esc(req.params.id)}`);
    res.writeHead(204).end();
  });

  /** POST /api/v1/admin/agents/:id/capabilities - 管理员为 Agent 分配能力 */
  addRoute('POST', '/api/v1/admin/agents/:id/capabilities', authAdmin, (req, res) => {
    const agent = db.get(`SELECT id FROM agents WHERE id = ${db.esc(req.params.id)}`);
    if (!agent) return sendJson(res, 404, { error: 'Agent not found' });

    const { capability, proficiency, description } = req.body;
    if (!capability) return sendJson(res, 400, { error: 'capability is required' });

    const prof = proficiency || 'standard';
    if (!VALID_PROFICIENCIES.has(prof)) {
      return sendJson(res, 400, { error: `proficiency must be one of: ${[...VALID_PROFICIENCIES].join(', ')}` });
    }

    const existing = db.get(`SELECT id FROM agent_capabilities
      WHERE agent_id = ${db.esc(req.params.id)} AND capability = ${db.esc(capability)}`);
    const now = new Date().toISOString();

    if (existing) {
      db.exec(`UPDATE agent_capabilities
        SET proficiency = ${db.esc(prof)}, description = ${db.esc(description || null)}, registered_at = ${db.esc(now)}
        WHERE id = ${db.esc(existing.id)}`);
      return sendJson(res, 200, db.get(`SELECT * FROM agent_capabilities WHERE id = ${db.esc(existing.id)}`));
    }

    const id = crypto.randomUUID();
    db.exec(`INSERT INTO agent_capabilities (id, agent_id, capability, proficiency, description, registered_at)
      VALUES (${db.esc(id)}, ${db.esc(req.params.id)}, ${db.esc(capability)}, ${db.esc(prof)}, ${db.esc(description || null)}, ${db.esc(now)})`);
    sendJson(res, 201, db.get(`SELECT * FROM agent_capabilities WHERE id = ${db.esc(id)}`));
  });

  /** GET /api/v1/admin/agents/:id/capabilities - 查看 Agent 能力 */
  addRoute('GET', '/api/v1/admin/agents/:id/capabilities', authAdmin, (req, res) => {
    sendJson(res, 200, db.all(`SELECT * FROM agent_capabilities
      WHERE agent_id = ${db.esc(req.params.id)} ORDER BY registered_at DESC`));
  });

  /** DELETE /api/v1/admin/agents/:id/capabilities/:capId - 移除 Agent 能力 */
  addRoute('DELETE', '/api/v1/admin/agents/:id/capabilities/:capId', authAdmin, (req, res) => {
    const cap = db.get(`SELECT id FROM agent_capabilities
      WHERE id = ${db.esc(req.params.capId)} AND agent_id = ${db.esc(req.params.id)}`);
    if (!cap) return sendJson(res, 404, { error: 'Capability not found' });

    db.exec(`DELETE FROM agent_capabilities WHERE id = ${db.esc(req.params.capId)}`);
    res.writeHead(204).end();
  });
}
