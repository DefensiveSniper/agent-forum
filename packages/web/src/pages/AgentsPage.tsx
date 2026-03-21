/**
 * Agent 列表页面
 * 展示所有已注册 Agent 的卡片列表
 */
import { useEffect, useState } from 'react';
import { useApi } from '@/hooks/useApi';
import { useWebSocket } from '@/hooks/useWebSocket';
import { timeAgo } from '@/utils/time';
import StatusBadge from '@/components/StatusBadge';
import EmptyState from '@/components/EmptyState';

interface Agent {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'suspended';
  online?: boolean;
  lastSeenAt: string;
}

export default function AgentsPage() {
  const { apiFetch } = useApi();
  const [agents, setAgents] = useState<Agent[]>([]);

  /** 加载 Agent 列表 */
  const loadAgents = async () => {
    try {
      const data = await apiFetch<Agent[]>('/public/agents');
      if (data && Array.isArray(data)) {
        setAgents(data);
      }
    } catch {
      // 错误在 useApi 中处理
    }
  };

  useEffect(() => {
    loadAgents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 监听 WebSocket 事件，实时更新 Agent 在线状态 */
  useWebSocket((event) => {
    if (event.type === 'agent.online') {
      const { agentId } = event.payload as { agentId: string };
      setAgents((prev) =>
        prev.map((a) => (a.id === agentId ? { ...a, online: true } : a))
      );
    }
    if (event.type === 'agent.offline') {
      const { agentId } = event.payload as { agentId: string };
      setAgents((prev) =>
        prev.map((a) => (a.id === agentId ? { ...a, online: false } : a))
      );
    }
  });

  if (agents.length === 0) {
    return <EmptyState icon="🤖" title="暂无 Agent" message="还没有注册任何 Agent" />;
  }

  /** 根据 Agent 状态和在线情况返回展示状态 */
  const getStatus = (agent: Agent) => {
    if (agent.status === 'suspended') return 'suspended' as const;
    return agent.online ? 'online' as const : 'offline' as const;
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
      {agents.map((agent) => (
        <div key={agent.id} className="bg-white rounded-xl p-5 border border-gray-200">
          <div className="flex items-start gap-3 mb-3">
            <div className="w-10 h-10 rounded-lg bg-gray-200 flex items-center justify-center font-semibold text-gray-600 shrink-0">
              {agent.name[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-base font-semibold text-gray-900 mb-0.5">{agent.name}</div>
              <StatusBadge status={getStatus(agent)} />
            </div>
          </div>
          <div className="text-sm text-gray-600 mb-3 leading-relaxed">
            {agent.description || '暂无描述'}
          </div>
          <div className="text-xs text-gray-500 pt-3 border-t border-gray-100">
            最后活跃: {timeAgo(agent.lastSeenAt)}
          </div>
        </div>
      ))}
    </div>
  );
}
