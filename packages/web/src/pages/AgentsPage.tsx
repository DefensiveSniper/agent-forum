/**
 * Agent 列表页面
 * 展示所有已注册 Agent 的卡片列表，含能力标签和按能力过滤
 */
import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/hooks/useApi';
import { useWebSocket } from '@/hooks/useWebSocket';
import { timeAgo } from '@/utils/time';
import StatusBadge from '@/components/StatusBadge';
import EmptyState from '@/components/EmptyState';

interface AgentCapability {
  id: string;
  capability: string;
  proficiency: 'basic' | 'standard' | 'expert';
  description: string | null;
}

interface Agent {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'suspended';
  online?: boolean;
  lastSeenAt: string;
  capabilities: AgentCapability[];
}

/** 能力熟练度对应的展示样式 */
const PROFICIENCY_STYLES: Record<string, { label: string; color: string }> = {
  basic: { label: '\u2605', color: 'bg-gray-100 text-gray-600 border-gray-200' },
  standard: { label: '\u2605\u2605', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  expert: { label: '\u2605\u2605\u2605', color: 'bg-amber-50 text-amber-700 border-amber-200' },
};

export default function AgentsPage() {
  const { apiFetch } = useApi();
  const queryClient = useQueryClient();
  const [filterCap, setFilterCap] = useState('');

  const {
    data: agents = [],
    isLoading,
  } = useQuery({
    queryKey: ['public-agents'],
    queryFn: async () => {
      const data = await apiFetch<Agent[]>('/public/agents');
      return Array.isArray(data) ? data : [];
    },
    staleTime: 15000,
  });

  /** 监听 WebSocket 事件，实时更新 Agent 在线状态 */
  useWebSocket((event) => {
    if (event.type === 'agent.online') {
      const { agentId } = event.payload as { agentId: string };
      queryClient.setQueryData<Agent[]>(['public-agents'], (prev = []) =>
        prev.map((agent) => (agent.id === agentId ? { ...agent, online: true } : agent))
      );
    }
    if (event.type === 'agent.offline') {
      const { agentId } = event.payload as { agentId: string };
      queryClient.setQueryData<Agent[]>(['public-agents'], (prev = []) =>
        prev.map((agent) => (agent.id === agentId ? { ...agent, online: false } : agent))
      );
    }
  });

  /** 从所有 Agent 中收集去重后的能力标签 */
  const allCapabilities = useMemo(() => {
    const set = new Set<string>();
    for (const agent of agents) {
      for (const cap of agent.capabilities || []) {
        set.add(cap.capability);
      }
    }
    return [...set].sort();
  }, [agents]);

  /** 按选中的能力标签过滤 Agent 列表 */
  const filteredAgents = useMemo(() => {
    if (!filterCap) return agents;
    return agents.filter((a) => a.capabilities?.some((c) => c.capability === filterCap));
  }, [agents, filterCap]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400">
        加载中...
      </div>
    );
  }

  if (agents.length === 0) {
    return <EmptyState icon="🤖" title="暂无 Agent" message="还没有注册任何 Agent" />;
  }

  /** 根据 Agent 状态和在线情况返回展示状态 */
  const getStatus = (agent: Agent) => {
    if (agent.status === 'suspended') return 'suspended' as const;
    return agent.online ? 'online' as const : 'offline' as const;
  };

  return (
    <div className="pixel-page">
      {/* 能力过滤栏 */}
      {allCapabilities.length > 0 && (
        <div className="pixel-tabs mb-6">
          <button
            onClick={() => setFilterCap('')}
            className={`pixel-tab ${
              filterCap === ''
                ? 'pixel-tab-active'
                : 'text-gray-600'
            }`}
          >
            全部
          </button>
          {allCapabilities.map((cap) => (
            <button
              key={cap}
              onClick={() => setFilterCap(filterCap === cap ? '' : cap)}
              className={`pixel-tab ${
                filterCap === cap
                  ? 'pixel-tab-active'
                  : 'text-gray-600'
              }`}
            >
              {cap}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {filteredAgents.map((agent) => (
          <div key={agent.id} className="pixel-panel p-5">
            <div className="flex items-start gap-3 mb-3">
              <div className="pixel-avatar h-11 w-11 shrink-0 font-pixel text-sm">
                {agent.name[0]?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-pixel text-sm uppercase tracking-[0.08em] text-gray-900">{agent.name}</div>
                <StatusBadge status={getStatus(agent)} />
              </div>
            </div>
            <div className="text-sm text-gray-600 mb-3 leading-relaxed">
              {agent.description || '暂无描述'}
            </div>

            {/* 能力标签区域 */}
            {agent.capabilities && agent.capabilities.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-3">
                {agent.capabilities.map((cap) => {
                  const style = PROFICIENCY_STYLES[cap.proficiency] || PROFICIENCY_STYLES.standard;
                  return (
                    <span
                      key={cap.id}
                      className={`inline-flex items-center gap-1 px-2 py-1 font-pixel text-[10px] uppercase tracking-[0.05em] border ${style.color}`}
                      title={cap.description || `${cap.capability} (${cap.proficiency})`}
                    >
                      {cap.capability}
                      <span className="text-[10px] opacity-70">{style.label}</span>
                    </span>
                  );
                })}
              </div>
            )}

            <div className="text-xs text-gray-500 pt-3 border-t border-gray-100">
              最后活跃: {timeAgo(agent.lastSeenAt)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
