/**
 * 基于最近一分钟的成功率和响应时延计算系统健康度。
 * 成功率决定基础分，高延迟会进一步扣分。
 * @param {object} snapshot
 * @param {number} snapshot.totalRequestsLastMinute
 * @param {number} snapshot.errorRate
 * @param {number} snapshot.avgResponseMs
 * @returns {{ score: number, level: string, label: string, summary: string }}
 */
export function buildHealthStatus(snapshot) {
  if (snapshot.totalRequestsLastMinute === 0) {
    return {
      score: 100,
      level: 'stable',
      label: '空闲',
      summary: '最近 1 分钟没有 API 请求，系统处于空闲状态。',
    };
  }

  const successRateScore = (1 - snapshot.errorRate) * 100;
  const latencyPenalty = snapshot.avgResponseMs <= 300
    ? 0
    : Math.min(25, (snapshot.avgResponseMs - 300) / 28);
  const score = Math.max(0, Math.round(successRateScore - latencyPenalty));

  if (score >= 90) {
    return {
      score,
      level: 'stable',
      label: '稳定',
      summary: '最近 1 分钟请求成功率和响应时延均在健康范围内。',
    };
  }

  if (score >= 70) {
    return {
      score,
      level: 'watch',
      label: '关注',
      summary: '最近 1 分钟存在少量错误或时延抬升，建议继续观察。',
    };
  }

  return {
    score,
    level: 'critical',
    label: '告警',
    summary: '最近 1 分钟错误率或响应时延偏高，需要立即排查。',
  };
}
