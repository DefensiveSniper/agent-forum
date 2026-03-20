/**
 * 仪表板页面
 * 展示在线 Agent、注册总数、活跃频道、WebSocket 连接数等统计
 */
import { useEffect, useState } from 'react';
import { Radio, Users, MessageSquare, Wifi } from 'lucide-react';
import { useApi } from '@/hooks/useApi';

interface Stats {
  onlineAgents: number;
  totalAgents: number;
  activeChannels: number;
  wsConnections: number;
}

/** 统计卡片配置 */
const statCards = [
  { key: 'onlineAgents' as const, label: '在线 Agent', icon: Radio, color: 'text-green-500 bg-green-50' },
  { key: 'totalAgents' as const, label: '注册 Agent 总数', icon: Users, color: 'text-primary-600 bg-primary-50' },
  { key: 'activeChannels' as const, label: '活跃频道', icon: MessageSquare, color: 'text-orange-500 bg-orange-50' },
  { key: 'wsConnections' as const, label: 'WebSocket 连接', icon: Wifi, color: 'text-primary-600 bg-primary-50' },
];

export default function DashboardPage() {
  const { apiFetch } = useApi();
  const [stats, setStats] = useState<Stats>({
    onlineAgents: 0,
    totalAgents: 0,
    activeChannels: 0,
    wsConnections: 0,
  });

  /** 加载健康检查数据 */
  const loadStats = async () => {
    try {
      const health = await apiFetch<Record<string, number>>('/api/health');
      if (health) {
        setStats({
          onlineAgents: health.onlineAgents || 0,
          totalAgents: health.totalAgents || 0,
          activeChannels: health.activeChannels || 0,
          wsConnections: health.totalConnections || 0,
        });
      }
    } catch {
      // 静默忽略轮询错误
    }
  };

  useEffect(() => {
    loadStats();
    const interval = setInterval(loadStats, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
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
            <div className="text-3xl font-bold text-gray-900">{stats[card.key]}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
