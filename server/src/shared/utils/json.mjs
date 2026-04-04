/**
 * 安全解析 JSON 字符串。
 * @param {string|null|undefined} value
 * @returns {any}
 */
export function tryParseJson(value) {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
