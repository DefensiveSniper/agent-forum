/**
 * 创建内存级监控服务。
 * 以秒为粒度保存最近一分钟的请求与连接快照，用于管理端仪表板展示。
 * @param {object} options
 * @param {object} options.ws
 * @returns {object}
 */
export function createMonitoringService({ ws }) {
  const HISTORY_LIMIT = 60;
  const startedAt = Date.now();
  let samplerTimer = null;
  let historyBuckets = [];
  let currentBucket = createBucket(floorToSecond(startedAt));

  /**
   * 将毫秒时间戳归一化到秒。
   * @param {number} timestampMs
   * @returns {number}
   */
  function floorToSecond(timestampMs) {
    return Math.floor(timestampMs / 1000) * 1000;
  }

  /**
   * 读取当前 WebSocket 连接快照。
   * @returns {{ onlineAgents: number, totalConnections: number, adminConnections: number }}
   */
  function getConnectionSnapshot() {
    const stats = ws.getConnectionStats();

    return {
      onlineAgents: stats.onlineAgents || 0,
      totalConnections: stats.totalConnections || 0,
      adminConnections: stats.adminConnections || 0,
    };
  }

  /**
   * 创建指定秒的监控桶。
   * @param {number} secondMs
   * @returns {object}
   */
  function createBucket(secondMs) {
    const snapshot = getConnectionSnapshot();

    return {
      secondMs,
      requests: 0,
      errors: 0,
      totalDurationMs: 0,
      onlineAgents: snapshot.onlineAgents,
      totalConnections: snapshot.totalConnections,
      adminConnections: snapshot.adminConnections,
    };
  }

  /**
   * 使用最新连接快照刷新桶的瞬时指标。
   * @param {object} bucket
   * @returns {object}
   */
  function refreshBucketSnapshot(bucket) {
    const snapshot = getConnectionSnapshot();
    bucket.onlineAgents = snapshot.onlineAgents;
    bucket.totalConnections = snapshot.totalConnections;
    bucket.adminConnections = snapshot.adminConnections;
    return bucket;
  }

  /**
   * 将当前桶推进到目标时间所在的秒。
   * 即使中间没有请求，也会补齐空桶以保证图表连续。
   * @param {number} timestampMs
   * @returns {object}
   */
  function rollToTimestamp(timestampMs) {
    const targetSecondMs = floorToSecond(timestampMs);

    while (currentBucket.secondMs < targetSecondMs) {
      refreshBucketSnapshot(currentBucket);
      historyBuckets.push(currentBucket);
      historyBuckets = historyBuckets.slice(-(HISTORY_LIMIT - 1));
      currentBucket = createBucket(currentBucket.secondMs + 1000);
    }

    return refreshBucketSnapshot(currentBucket);
  }

  /**
   * 将内部桶结构转换为前端可消费的时间序列点。
   * @param {object} bucket
   * @returns {object}
   */
  function buildHistoryPoint(bucket) {
    const avgResponseMs = bucket.requests > 0
      ? Number((bucket.totalDurationMs / bucket.requests).toFixed(1))
      : 0;

    return {
      secondAt: new Date(bucket.secondMs).toISOString(),
      requests: bucket.requests,
      qps: bucket.requests,
      errors: bucket.errors,
      avgResponseMs,
      totalConnections: bucket.totalConnections,
      adminConnections: bucket.adminConnections,
      onlineAgents: bucket.onlineAgents,
    };
  }

  /**
   * 获取最近一分钟的原始桶窗口。
   * @returns {object[]}
   */
  function getWindowBuckets() {
    rollToTimestamp(Date.now());
    return [...historyBuckets, currentBucket].slice(-HISTORY_LIMIT);
  }

  /**
   * 记录一次 HTTP API 请求。
   * 监控接口自身的轮询会被排除，避免把看板流量计入业务 QPS。
   * @param {object} input
   * @param {string} input.pathname
   * @param {number} input.statusCode
   * @param {number} input.durationMs
   */
  function recordHttpRequest({ pathname, statusCode, durationMs }) {
    if (pathname === '/api/v1/admin/monitoring') return;

    const bucket = rollToTimestamp(Date.now());
    bucket.requests += 1;
    bucket.totalDurationMs += Math.max(0, durationMs);

    if (statusCode >= 400) {
      bucket.errors += 1;
    }
  }

  /**
   * 汇总最近一分钟的监控快照。
   * @returns {object}
   */
  function getSnapshot() {
    const windowBuckets = getWindowBuckets();
    const totals = windowBuckets.reduce((acc, bucket) => {
      acc.requests += bucket.requests;
      acc.errors += bucket.errors;
      acc.totalDurationMs += bucket.totalDurationMs;
      return acc;
    }, { requests: 0, errors: 0, totalDurationMs: 0 });
    const latestConnections = getConnectionSnapshot();
    const currentQps = windowBuckets.length > 0 ? windowBuckets[windowBuckets.length - 1].requests : 0;
    const peakQps = windowBuckets.reduce((max, bucket) => Math.max(max, bucket.requests), 0);
    const avgResponseMs = totals.requests > 0
      ? Number((totals.totalDurationMs / totals.requests).toFixed(1))
      : 0;
    const errorRate = totals.requests > 0
      ? Number((totals.errors / totals.requests).toFixed(4))
      : 0;

    return {
      generatedAt: new Date().toISOString(),
      startedAt: new Date(startedAt).toISOString(),
      uptimeMs: Date.now() - startedAt,
      currentQps,
      peakQps,
      totalRequestsLastMinute: totals.requests,
      totalErrorsLastMinute: totals.errors,
      avgResponseMs,
      errorRate,
      connections: latestConnections,
      history: windowBuckets.map(buildHistoryPoint),
    };
  }

  /**
   * 启动秒级采样定时器，保证空闲期也能持续记录连接曲线。
   */
  function startSampling() {
    if (samplerTimer) return;

    samplerTimer = setInterval(() => {
      rollToTimestamp(Date.now());
    }, 1000);

    if (typeof samplerTimer.unref === 'function') {
      samplerTimer.unref();
    }
  }

  /**
   * 停止秒级采样定时器。
   */
  function stopSampling() {
    if (!samplerTimer) return;
    clearInterval(samplerTimer);
    samplerTimer = null;
  }

  return {
    recordHttpRequest,
    getSnapshot,
    startSampling,
    stopSampling,
  };
}
