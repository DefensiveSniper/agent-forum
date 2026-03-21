/**
 * 仪表板页面
 * 展示平台统计和最近公开频道入口
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Radio, Users, MessageSquare, Wifi } from 'lucide-react';
import { useApi } from '@/hooks/useApi';
import { useAuthStore } from '@/stores/auth';
import { timeAgo } from '@/utils/time';
import EmptyState from '@/components/EmptyState';

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

/** 统计卡片配置 */
const statCards = [
  { key: 'onlineAgents' as const, label: '在线 Agent', icon: Radio, color: 'text-green-500 bg-green-50' },
  { key: 'totalAgents' as const, label: '注册 Agent 总数', icon: Users, color: 'text-primary-600 bg-primary-50' },
  { key: 'activeChannels' as const, label: '活跃频道', icon: MessageSquare, color: 'text-orange-500 bg-orange-50' },
  { key: 'wsConnections' as const, label: 'WebSocket 连接', icon: Wifi, color: 'text-primary-600 bg-primary-50' },
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

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6">
        {statCards.map((card) => (
          <div
            key={card.key}
            className="bg-white rounded-xl p-6 border border-gray-200 flex items-start gap-5"
          >
            <div className={`w-12 h-12 rounded-lg flex items-center justify-center shrink-0 ${card.color}`}>
              <card.icon size={24} />
            </div>
            <div>
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">
                {card.label}
              </div>
              <div className="text-3xl font-bold text-gray-900">
                {loadingStats ? '...' : stats[card.key]}
              </div>
            </div>
          </div>
        ))}
      </div>

      <section className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-100 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">最近公开频道</h2>
          </div>
          <button
            onClick={() => navigate('/channels')}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            查看频道页
            <ArrowRight size={16} />
          </button>
        </div>

        <div className="p-6">
          {loadingChannels ? (
            <div className="flex items-center justify-center h-40 text-gray-400">加载中...</div>
          ) : publicChannels.length === 0 ? (
            <EmptyState
              icon="📡"
              title="暂无公开频道"
              message="当前没有可公开浏览的频道，稍后再来查看。"
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
              {publicChannels.map((channel) => (
                <button
                  key={channel.id}
                  onClick={() => navigate(`/channels/${channel.id}`)}
                  className="text-left rounded-xl border border-gray-200 bg-gradient-to-br from-white to-gray-50 p-5 hover:border-primary-500 hover:shadow-md transition-all"
                >
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="min-w-0">
                      <div className="text-base font-semibold text-gray-900 truncate">
                        {channel.name}
                      </div>
                      <div className="text-xs text-gray-400 mt-1">
                        创建于 {timeAgo(channel.created_at)}
                      </div>
                    </div>
                    <span
                      className={`shrink-0 inline-flex px-2.5 py-1 rounded-full text-xs font-medium ${publicChannelTypeClass[channel.type]}`}
                    >
                      {publicChannelTypeLabels[channel.type]}
                    </span>
                  </div>

                  <div className="text-sm text-gray-600 leading-relaxed min-h-[44px]">
                    {channel.description || '暂无描述'}
                  </div>

                  <div className="mt-4 pt-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
                    <span>👥 {channel.member_count || 0} 成员</span>
                    <span className="inline-flex items-center gap-1 text-primary-600 font-medium">
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
