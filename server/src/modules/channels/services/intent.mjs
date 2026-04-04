/** 合法的意图任务类型白名单。 */
const VALID_TASK_TYPES = new Set([
  'chat', 'code_review', 'approval_request', 'task_assignment',
  'info_share', 'question', 'decision', 'bug_report', 'feature_request',
]);
const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const MAX_INTENT_SIZE = 4096;

/**
 * 校验并清理 intent 对象。
 * @param {unknown} intent
 * @returns {object|null}
 */
export function validateIntent(intent) {
  if (intent === null || intent === undefined) return null;
  if (typeof intent !== 'object' || Array.isArray(intent)) {
    throw new Error('intent must be an object');
  }

  const raw = JSON.stringify(intent);
  if (raw.length > MAX_INTENT_SIZE) {
    throw new Error(`intent JSON exceeds ${MAX_INTENT_SIZE} bytes`);
  }

  const cleaned = {};
  if (intent.task_type !== undefined) {
    if (typeof intent.task_type !== 'string') throw new Error('intent.task_type must be a string');
    if (!VALID_TASK_TYPES.has(intent.task_type) && !intent.task_type.startsWith('custom:')) {
      throw new Error(`intent.task_type must be one of: ${[...VALID_TASK_TYPES].join(', ')} or custom:*`);
    }
    cleaned.task_type = intent.task_type;
  }
  if (intent.priority !== undefined) {
    if (!VALID_PRIORITIES.has(intent.priority)) {
      throw new Error(`intent.priority must be one of: ${[...VALID_PRIORITIES].join(', ')}`);
    }
    cleaned.priority = intent.priority;
  }
  if (intent.requires_approval !== undefined) {
    if (typeof intent.requires_approval !== 'boolean') {
      throw new Error('intent.requires_approval must be a boolean');
    }
    cleaned.requires_approval = intent.requires_approval;
    if (intent.requires_approval) {
      cleaned.approval_status = 'pending';
    }
  }
  if (intent.deadline !== undefined) {
    if (intent.deadline !== null && typeof intent.deadline !== 'string') {
      throw new Error('intent.deadline must be a string or null');
    }
    cleaned.deadline = intent.deadline;
  }
  if (intent.tags !== undefined) {
    if (!Array.isArray(intent.tags) || !intent.tags.every((tag) => typeof tag === 'string')) {
      throw new Error('intent.tags must be an array of strings');
    }
    cleaned.tags = intent.tags;
  }
  if (intent.custom !== undefined) {
    if (typeof intent.custom !== 'object' || Array.isArray(intent.custom)) {
      throw new Error('intent.custom must be an object');
    }
    cleaned.custom = intent.custom;
  }

  return Object.keys(cleaned).length > 0 ? cleaned : null;
}
