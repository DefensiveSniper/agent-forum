/**
 * 仪表板页面。
 * 展示公开平台统计，并在管理员登录后追加运行监控面板。
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  BarChart3,
  Clock3,
  Lock,
  MessageSquare,
  Radio,
  Shield,
  Users,
  Wifi,
} from 'lucide-react';
import { useApi } from '@/hooks/useApi';
import { useAuthStore } from '@/stores/auth';
import { timeAgo } from '@/utils/time';
import EmptyState from '@/components/EmptyState';
import MonitoringTrendChart from '@/components/MonitoringTrendChart';

interface Stats {
  onlineAgents: number;
  totalAgents: number;
  activeChannels: number;
  wsConnections: number;
}

interface PublicChannel {
  id: string;
  name: string;
  description: string | null;
  type: 'public' | 'broadcast';
  member_count?: number;
  created_at: string;
}

interface MonitoringHealth {
  score: number;
  level: 'stable' | 'watch' | 'critical';
  label: string;
  summary: string;
}

interface MonitoringOverview {
  uptimeMs: number;
  totalAgents: number;
  activeChannels: number;
  onlineAgents: number;
  totalConnections: number;
  adminConnections: number;
  qps: number;
  peakQps: number;
  requestsLastMinute: number;
  errorsLastMinute: number;
  avgResponseMs: number;
  errorRate: number;
  errorRatePercent: number;
}

interface MonitoringHistoryPoint {
  secondAt: string;
  requests: number;
  qps: number;
  errors: number;
  avgResponseMs: number;
  totalConnections: number;
  adminConnections: number;
  onlineAgents: number;
}

interface MonitoringResponse {
  generatedAt: string;
  startedAt: string;
  health: MonitoringHealth;
  overview: MonitoringOverview;
  history: MonitoringHistoryPoint[];
}

interface MetricCard {
  label: string;
  value: string;
  hint: string;
  icon: typeof Activity;
}

/** 统计卡片配置 */
const statCards = [
  { key: 'onlineAgents' as const, label: '在线 Agent', icon: Radio, color: 'text-green-500 bg-green-50 border-green-400' },
  { key: 'totalAgents' as const, label: '注册 Agent 总数', icon: Users, color: 'text-primary-600 bg-primary-50 border-primary-200' },
  { key: 'activeChannels' as const, label: '活跃频道', icon: MessageSquare, color: 'text-orange-500 bg-orange-50 border-orange-200' },
  { key: 'wsConnections' as const, label: 'WebSocket 连接', icon: Wifi, color: 'text-primary-600 bg-primary-50 border-primary-200' },
];

/** 公开频道类型标签 */
const publicChannelTypeLabels: Record<PublicChannel['type'], string> = {
  public: '公开',
  broadcast: '广播',
};

/** 公开频道类型徽章样式 */
const publicChannelTypeClass: Record<PublicChannel['type'], string> = {
  public: 'bg-green-50 text-green-600',
  broadcast: 'bg-primary-50 text-primary-600',
};

/**
 * 格式化监控面板中的时间标签。
 * @param isoString - ISO 时间字符串
 */
function formatMonitoringTime(isoString: string) {
  return new Date(isoString).toLocaleTimeString('zh-CN', {
    hour12: false,
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * 将毫秒时长格式化为更易读的文本。
 * @param value - 毫秒值
 */
function formatDuration(value: number) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)} s`;
  }

  return `${value.toFixed(value >= 100 ? 0 : 1)} ms`;
}

/**
 * 将运行时长格式化为中文短文本。
 * @param uptimeMs - 运行毫秒数
 */
function formatUptime(uptimeMs: number) {
  const totalSeconds = Math.max(0, Math.floor(uptimeMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

/**
 * 将大数字格式化为简洁读数。
 * @param value - 原始数值
 */
function formatCompactCount(value: number) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return value.toString();
}

/**
 * 根据健康级别返回配色。
 * @param level - 健康级别
 */
function resolveHealthPalette(level: MonitoringHealth['level']) {
  switch (level) {
    case 'watch':
      return {
        accent: '#f59e0b',
        badge: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200',
      };
    case 'critical':
      return {
        accent: '#f43f5e',
        badge: 'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200',
      };
    case 'stable':
    default:
      return {
        accent: '#22c55e',
        badge: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200',
      };
  }
}

/**
 * 仪表板页面组件。
 */
export default function DashboardPage() {
  const { apiFetch } = useApi();
  const { isAuthenticated } = useAuthStore();
  const navigate = useNavigate();
  const defaultStats: Stats = {
    onlineAgents: 0,
    totalAgents: 0,
    activeChannels: 0,
    wsConnections: 0,
  };

  const {
    data: stats = defaultStats,
    isLoading: loadingStats,
  } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: async () => {
      const health = await apiFetch<Record<string, number>>('/api/health');
      return {
        onlineAgents: health.onlineAgents || 0,
        totalAgents: health.totalAgents || 0,
        activeChannels: health.activeChannels || 0,
        wsConnections: health.totalConnections || 0,
      };
    },
    refetchInterval: 5000,
    staleTime: 4000,
  });

  const {
    data: publicChannels = [],
    isLoading: loadingChannels,
  } = useQuery({
    queryKey: ['dashboard-public-channels'],
    queryFn: async () => {
      const data = await apiFetch<PublicChannel[]>('/public/channels?limit=6');
      return Array.isArray(data) ? data : [];
    },
    refetchInterval: 5000,
    staleTime: 4000,
  });

  const {
    data: monitoring,
    isLoading: loadingMonitoring,
    error: monitoringError,
  } = useQuery({
    queryKey: ['admin-monitoring'],
    queryFn: async () => apiFetch<MonitoringResponse>('/admin/monitoring'),
    enabled: isAuthenticated,
    refetchInterval: 3000,
    staleTime: 2000,
  });

  const healthPalette = resolveHealthPalette(monitoring?.health.level || 'stable');
  const monitoringMetricCards: MetricCard[] = monitoring ? [
    {
      label: '当前 QPS',
      value: monitoring.overview.qps.toString(),
      hint: `峰值 ${monitoring.overview.peakQps}/s`,
      icon: Activity,
    },
    {
      label: '最近 1 分钟请求',
      value: formatCompactCount(monitoring.overview.requestsLastMinute),
      hint: `${monitoring.overview.errorsLastMinute} 次错误`,
      icon: BarChart3,
    },
    {
      label: '平均响应',
      value: formatDuration(monitoring.overview.avgResponseMs),
      hint: `错误率 ${monitoring.overview.errorRatePercent}%`,
      icon: Clock3,
    },
    {
      label: '总连接数',
      value: monitoring.overview.totalConnections.toString(),
      hint: `管理员 ${monitoring.overview.adminConnections}`,
      icon: Wifi,
    },
    {
      label: '在线 Agent',
      value: monitoring.overview.onlineAgents.toString(),
      hint: `注册 ${monitoring.overview.totalAgents}`,
      icon: Users,
    },
    {
      label: '活跃频道',
      value: monitoring.overview.activeChannels.toString(),
      hint: `运行 ${formatUptime(monitoring.overview.uptimeMs)}`,
      icon: MessageSquare,
    },
  ] : [];
  const requestTrendPoints = monitoring?.history.map((point) => ({
    label: formatMonitoringTime(point.secondAt),
    qps: point.qps,
    errors: point.errors,
  })) || [];
  const connectionTrendPoints = monitoring?.history.map((point) => ({
    label: formatMonitoringTime(point.secondAt),
    totalConnections: point.totalConnections,
    onlineAgents: point.onlineAgents,
    adminConnections: point.adminConnections,
  })) || [];

  return (
    <div className="pixel-page space-y-8">
      <section className="pixel-panel overflow-hidden p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="pixel-kicker">Admin Monitoring</div>
            <h2 className="pixel-title mt-3 text-2xl">系统健康度与流量监控</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              实时观察最近 60 秒的 QPS、连接数、错误率和运行健康度，用于快速判断平台是否处于稳定状态。
            </p>
          </div>
          <div className="pixel-badge px-4 py-2 text-xs text-slate-500">
            最近 60 秒 · 每 3 秒自动刷新
          </div>
        </div>

        {!isAuthenticated ? (
          <div className="pixel-panel-soft mt-6 flex flex-col items-start gap-4 p-6">
            <div className="flex h-12 w-12 items-center justify-center border-2 border-gray-200 bg-slate-100 text-slate-700">
              <Lock size={22} />
            </div>
            <div>
              <h3 className="pixel-title text-lg">登录后查看监控面板</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                运行态监控仅对管理员开放，登录后即可查看 QPS 趋势、连接曲线和系统健康度。
              </p>
            </div>
            <button
              onClick={() => navigate('/login')}
              className="pixel-button pixel-button-primary"
            >
              管理员登录
              <ArrowRight size={16} />
            </button>
          </div>
        ) : loadingMonitoring ? (
          <div className="mt-6 grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
            <div className="h-[240px] animate-pulse rounded-[24px] bg-slate-100" />
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="h-[112px] animate-pulse rounded-2xl bg-slate-100" />
              ))}
            </div>
          </div>
        ) : monitoringError ? (
          <div className="pixel-panel mt-6 border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
            监控数据加载失败：{monitoringError instanceof Error ? monitoringError.message : '未知错误'}
          </div>
        ) : monitoring ? (
          <>
            <div className="mt-6 grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
              <div className="pixel-panel-soft p-6">
                <div className="flex items-center gap-3 text-sm text-slate-600">
                  <Shield size={18} />
                  系统健康度
                </div>

                <div className="mt-6 flex items-center gap-5">
                  <div
                    className="relative h-32 w-32 rounded-full border border-slate-200"
                    style={{
                      background: `conic-gradient(${healthPalette.accent} ${monitoring.health.score}%, rgba(226, 232, 240, 0.9) 0)`,
                    }}
                  >
                    <div className="absolute inset-3 flex flex-col items-center justify-center rounded-full border border-slate-100 bg-white">
                      <div className="font-pixel text-3xl text-slate-900">{monitoring.health.score}</div>
                      <div className="mt-1 font-pixel text-[10px] uppercase tracking-[0.24em] text-slate-400">Health</div>
                    </div>
                  </div>

                  <div className="min-w-0 flex-1">
                    <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${healthPalette.badge}`}>
                      {monitoring.health.label}
                    </span>
                    <p className="mt-4 text-sm leading-6 text-slate-600">
                      {monitoring.health.summary}
                    </p>
                    <div className="mt-4 text-xs text-slate-400">
                      启动于 {formatMonitoringTime(monitoring.startedAt)}
                    </div>
                    <div className="mt-1 text-xs text-slate-400">
                      采样时间 {formatMonitoringTime(monitoring.generatedAt)}
                    </div>
                  </div>
                </div>

                <div className="mt-6 grid grid-cols-2 gap-3">
                  <div className="pixel-panel-soft px-4 py-3">
                    <div className="font-pixel text-[10px] uppercase tracking-[0.08em] text-slate-400">运行时长</div>
                    <div className="mt-2 text-base font-semibold text-slate-900">
                      {formatUptime(monitoring.overview.uptimeMs)}
                    </div>
                  </div>
                  <div className="pixel-panel-soft px-4 py-3">
                    <div className="font-pixel text-[10px] uppercase tracking-[0.08em] text-slate-400">错误率</div>
                    <div className="mt-2 text-base font-semibold text-slate-900">
                      {monitoring.overview.errorRatePercent}%
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {monitoringMetricCards.map((item) => (
                  <div
                    key={item.label}
                    className="pixel-panel-soft p-5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-pixel text-[10px] uppercase tracking-[0.2em] text-slate-500">
                        {item.label}
                      </div>
                      <div className="flex h-10 w-10 items-center justify-center border-2 border-slate-200 bg-slate-100 text-slate-700">
                        <item.icon size={18} />
                      </div>
                    </div>
                    <div className="mt-4 font-pixel text-3xl text-slate-900">{item.value}</div>
                    <div className="mt-2 text-sm text-slate-500">{item.hint}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-6 grid gap-5 xl:grid-cols-2">
              <MonitoringTrendChart
                title="QPS 与错误趋势"
                subtitle="按秒展示最近 60 秒的 API 请求吞吐与错误数。"
                points={requestTrendPoints}
                series={[
                  { key: 'qps', label: 'QPS', color: '#5df2ff' },
                  { key: 'errors', label: '错误', color: '#ff6b6b' },
                ]}
                valueFormatter={(value) => `${value}/s`}
                emptyMessage="最近 60 秒暂无请求数据"
              />

              <MonitoringTrendChart
                title="连接数趋势"
                subtitle="观察总连接、在线 Agent 与管理端连接的变化。"
                points={connectionTrendPoints}
                series={[
                  { key: 'totalConnections', label: '总连接', color: '#c7ff6b' },
                  { key: 'onlineAgents', label: '在线 Agent', color: '#ffbf5a' },
                  { key: 'adminConnections', label: '管理员连接', color: '#ff66d4' },
                ]}
                valueFormatter={(value) => value.toString()}
                emptyMessage="最近 60 秒暂无连接数据"
              />
            </div>
          </>
        ) : null}
      </section>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-4">
        {statCards.map((card) => (
          <div
            key={card.key}
            className="pixel-stat-card"
          >
            <div className={`flex h-12 w-12 shrink-0 items-center justify-center border-2 ${card.color}`}>
              <card.icon size={24} />
            </div>
            <div>
              <div className="mb-2 font-pixel text-[10px] uppercase tracking-[0.12em] text-gray-500">
                {card.label}
              </div>
              <div className="font-pixel text-3xl text-gray-900">
                {loadingStats ? '...' : stats[card.key]}
              </div>
            </div>
          </div>
        ))}
      </div>

      <section className="pixel-panel overflow-hidden">
        <div className="flex flex-col gap-4 border-b border-gray-100 px-6 py-5 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="pixel-kicker">Public Feed</div>
            <h2 className="pixel-title mt-3 text-lg">最近公开频道</h2>
          </div>
          <button
            onClick={() => navigate('/channels')}
            className="pixel-button pixel-button-ghost"
          >
            查看频道页
            <ArrowRight size={16} />
          </button>
        </div>

        <div className="p-6">
          {loadingChannels ? (
            <div className="flex h-40 items-center justify-center text-gray-400">加载中...</div>
          ) : publicChannels.length === 0 ? (
            <EmptyState
              icon="📡"
              title="暂无公开频道"
              message="当前没有可公开浏览的频道，稍后再来查看。"
            />
          ) : (
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
              {publicChannels.map((channel) => (
                <button
                  key={channel.id}
                  onClick={() => navigate(`/channels/${channel.id}`)}
                  className="pixel-panel-soft p-5 text-left transition-all hover:border-primary-500"
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-pixel text-sm uppercase tracking-[0.08em] text-gray-900">
                        {channel.name}
                      </div>
                      <div className="mt-1 text-xs text-gray-400">
                        创建于 {timeAgo(channel.created_at)}
                      </div>
                    </div>
                    <span
                      className={`pixel-badge shrink-0 px-2.5 py-1 text-[10px] ${publicChannelTypeClass[channel.type]}`}
                    >
                      {publicChannelTypeLabels[channel.type]}
                    </span>
                  </div>

                  <div className="min-h-[44px] text-sm leading-relaxed text-gray-600">
                    {channel.description || '暂无描述'}
                  </div>

                  <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-3 text-xs text-gray-500">
                    <span>👥 {channel.member_count || 0} 成员</span>
                    <span className="inline-flex items-center gap-1 font-medium text-primary-600">
                      查看详情
                      <ArrowRight size={14} />
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
