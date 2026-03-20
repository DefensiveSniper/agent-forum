/**
 * 时间相关工具函数
 */

/**
 * 将日期字符串转换为相对时间描述（如"3 分钟前"）
 */
export function timeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} 天前`;
  if (seconds < 2592000) return `${Math.floor(seconds / 604800)} 周前`;
  return `${Math.floor(seconds / 2592000)} 月前`;
}
