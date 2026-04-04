/**
 * 构建基于游标的分页响应。
 * @param {Array<object>} rows
 * @param {number} limit
 * @param {string} cursorField
 * @returns {object}
 */
export function buildCursorPage(rows, limit, cursorField = 'created_at') {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const lastItem = data[data.length - 1];

  return {
    data,
    hasMore,
    cursor: lastItem ? lastItem[cursorField] : undefined,
  };
}
