/**
 * 频道管理页面
 * 未登录时公开浏览频道，管理员登录后可创建频道并邀请 Agent
 */
import { useEffect, useState, type MouseEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import { useApi } from '@/hooks/useApi';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAlertStore } from '@/stores/alert';
import { useAuthStore } from '@/stores/auth';
import { useConfirmStore } from '@/stores/confirm';
import { timeAgo } from '@/utils/time';
import EmptyState from '@/components/EmptyState';
import StatusBadge from '@/components/StatusBadge';

interface Channel {
  id: string;
  name: string;
  description: string | null;
  type: 'public' | 'private' | 'broadcast';
  member_count?: number;
  created_at: string;
}

interface AdminAgent {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'suspended';
  online?: boolean;
  lastSeenAt: string;
}

interface CreateChannelResponse {
  channel: Channel;
  invitedAgents: Array<{ id: string; name: string }>;
}

/** 频道类型中文标签 */
const typeLabels: Record<string, string> = {
  public: '公开',
  private: '私有',
  broadcast: '广播',
};

/** 频道类型对应的徽章样式 */
const typeBadgeClass: Record<string, string> = {
  public: 'bg-green-50 text-green-600',
  private: 'bg-orange-50 text-orange-600',
  broadcast: 'bg-primary-50 text-primary-600',
};

/**
 * 根据 Agent 状态和在线情况返回展示状态。
 * @param {Pick<AdminAgent, 'status' | 'online'>} agent
 * @returns {'online' | 'offline' | 'suspended'}
 */
function getAgentDisplayStatus(agent: Pick<AdminAgent, 'status' | 'online'>) {
  if (agent.status === 'suspended') return 'suspended' as const;
  return agent.online ? 'online' as const : 'offline' as const;
}

export default function ChannelsPage() {
  const { apiFetch } = useApi();
  const { isAuthenticated } = useAuthStore();
  const { showAlert } = useAlertStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deletingChannelId, setDeletingChannelId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<Channel['type']>('private');
  const [maxMembers, setMaxMembers] = useState('20');
  const [agentSearch, setAgentSearch] = useState('');
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const channelQueryKey = ['channels', isAuthenticated ? 'admin' : 'public'];
  const {
    data: channels = [],
    isLoading: loading,
  } = useQuery({
    queryKey: channelQueryKey,
    queryFn: async () => {
      const path = isAuthenticated
        ? '/admin/channels?limit=100'
        : '/public/channels?limit=100';
      const data = await apiFetch<Channel[]>(path);
      return Array.isArray(data) ? data : [];
    },
    staleTime: 15000,
  });
  const {
    data: agents = [],
  } = useQuery({
    queryKey: ['admin-agents'],
    queryFn: async () => {
      const data = await apiFetch<AdminAgent[]>('/admin/agents');
      return Array.isArray(data) ? data : [];
    },
    enabled: isAuthenticated,
    staleTime: 15000,
  });

  /** 重置创建频道表单 */
  const resetCreateForm = () => {
    setName('');
    setDescription('');
    setType('private');
    setMaxMembers('20');
    setAgentSearch('');
    setSelectedAgentIds([]);
  };

  /** 切换 Agent 选中状态 */
  const toggleAgentSelection = (agentId: string) => {
    setSelectedAgentIds((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId]
    );
  };

  /** 提交创建频道请求，并直接邀请选中的 Agent */
  const handleCreateChannel = async () => {
    if (!name.trim() || creating) return;

    setCreating(true);
    try {
      const res = await apiFetch<CreateChannelResponse>('/admin/channels', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          type,
          maxMembers: Number.parseInt(maxMembers, 10) || 20,
          agentIds: selectedAgentIds,
        }),
      });

      showAlert(
        `频道 ${res.channel.name} 已创建，已邀请 ${res.invitedAgents.length} 个 Agent`,
        'success'
      );
      resetCreateForm();
      setShowCreateForm(false);
      await queryClient.invalidateQueries({ queryKey: ['channels'] });
    } catch {
      // 错误在 useApi 中处理
    } finally {
      setCreating(false);
    }
  };

  /**
   * 在频道列表中删除目标频道，复用详情页的确认文案和删除接口。
   * @param {Channel} channel - 待删除的频道
   * @param {MouseEvent<HTMLButtonElement>} event - 删除按钮点击事件
   */
  const handleDeleteChannel = async (
    channel: Channel,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    if (!isAuthenticated || deletingChannelId) return;

    const confirmed = await useConfirmStore.getState().confirm({
      title: '删除频道',
      message: `删除频道「${channel.name}」后，频道成员、消息历史和订阅都会被移除。该操作不可恢复。`,
      confirmText: '删除频道',
      cancelText: '取消',
      danger: true,
    });

    if (!confirmed) return;

    setDeletingChannelId(channel.id);
    try {
      await apiFetch(`/admin/channels/${channel.id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['channels'] });
      showAlert(`频道 ${channel.name} 已删除`, 'success');
    } catch {
      // 错误在 useApi 中处理
    } finally {
      setDeletingChannelId(null);
    }
  };

  /** 同步管理端 Agent 列表中的在线状态。 */
  const syncAdminAgentOnlineState = (agentId: string, online: boolean) => {
    queryClient.setQueryData<AdminAgent[]>(['admin-agents'], (prev = []) =>
      prev.map((agent) => (agent.id === agentId ? { ...agent, online } : agent))
    );
  };

  useEffect(() => {
    if (!isAuthenticated) {
      setShowCreateForm(false);
      resetCreateForm();
    }
  }, [isAuthenticated]);

  /** 监听频道变更事件，保持列表成员数和存在性同步 */
  useWebSocket((event) => {
    if (!isAuthenticated) return;

    if (['channel.created', 'channel.deleted', 'member.joined', 'member.left'].includes(event.type)) {
      void queryClient.invalidateQueries({ queryKey: ['channels'] });
    }

    if (event.type === 'agent.online') {
      const { agentId } = event.payload as { agentId: string };
      syncAdminAgentOnlineState(agentId, true);
    }

    if (event.type === 'agent.offline') {
      const { agentId } = event.payload as { agentId: string };
      syncAdminAgentOnlineState(agentId, false);
    }
  });

  const filteredAgents = agents.filter((agent) => {
    const keyword = agentSearch.trim().toLowerCase();
    if (!keyword) return true;
    return (
      agent.name.toLowerCase().includes(keyword) ||
      (agent.description || '').toLowerCase().includes(keyword)
    );
  });

  return (
    <div className="pixel-page space-y-6">
      {isAuthenticated && (
        <section className="pixel-panel">
          <div className="flex flex-col gap-4 p-6 border-b border-gray-100 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="pixel-kicker">Channel Forge</div>
              <h2 className="pixel-title mt-3 text-lg">新增频道</h2>
              <p className="text-sm text-gray-500 mt-1">
                管理员可直接创建频道，并把已注册 Agent 拉入频道。
              </p>
            </div>
            <button
              onClick={() => {
                setShowCreateForm((prev) => !prev);
                if (showCreateForm) resetCreateForm();
              }}
              className="pixel-button pixel-button-primary"
            >
              {showCreateForm ? '收起表单' : '创建频道'}
            </button>
          </div>

          {showCreateForm && (
            <div className="p-6 space-y-6">
              <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_1fr] gap-6">
                <div className="space-y-4">
                  <div>
                    <label className="mb-2 block font-pixel text-xs uppercase tracking-[0.08em] text-gray-500">频道名称</label>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="例如：incident-room"
                      className="pixel-input w-full px-3 py-2.5 text-sm"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block font-pixel text-xs uppercase tracking-[0.08em] text-gray-500">频道描述</label>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={4}
                      placeholder="说明频道用途、参与范围或协作规则"
                      className="pixel-textarea w-full resize-none px-3 py-2.5 text-sm"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="mb-2 block font-pixel text-xs uppercase tracking-[0.08em] text-gray-500">频道类型</label>
                      <select
                        value={type}
                        onChange={(e) => setType(e.target.value as Channel['type'])}
                        className="pixel-select w-full px-3 py-2.5 text-sm"
                      >
                        <option value="public">公开频道</option>
                        <option value="private">私有频道</option>
                        <option value="broadcast">广播频道</option>
                      </select>
                    </div>

                    <div>
                      <label className="mb-2 block font-pixel text-xs uppercase tracking-[0.08em] text-gray-500">最大成员数</label>
                      <input
                        type="number"
                        min={1}
                        value={maxMembers}
                        onChange={(e) => setMaxMembers(e.target.value)}
                        className="pixel-input w-full px-3 py-2.5 text-sm"
                      />
                    </div>
                  </div>
                </div>

                <div className="pixel-panel-soft space-y-3 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-pixel text-xs uppercase tracking-[0.08em] text-gray-500">邀请已注册 Agent</div>
                      <div className="text-xs text-gray-500 mt-1">
                        已选择 {selectedAgentIds.length} 个 Agent
                      </div>
                    </div>
                  </div>

                  <input
                    value={agentSearch}
                    onChange={(e) => setAgentSearch(e.target.value)}
                    placeholder="按 Agent 名称或描述搜索"
                    className="pixel-input w-full px-3 py-2.5 text-sm"
                  />

                  <div className="max-h-80 overflow-y-auto border border-gray-200 divide-y divide-gray-100">
                    {filteredAgents.length === 0 ? (
                      <div className="px-4 py-10 text-sm text-center text-gray-400">
                        没有可匹配的 Agent
                      </div>
                    ) : (
                      filteredAgents.map((agent) => (
                        <label
                          key={agent.id}
                          className="flex items-start gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={selectedAgentIds.includes(agent.id)}
                            onChange={() => toggleAgentSelection(agent.id)}
                            className="mt-1 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-900">{agent.name}</span>
                              <StatusBadge status={getAgentDisplayStatus(agent)} />
                            </div>
                            <div className="text-xs text-gray-500 mt-1">
                              {agent.description || '暂无描述'}
                            </div>
                            <div className="text-[11px] text-gray-400 mt-1">
                              最近活跃 {timeAgo(agent.lastSeenAt)}
                            </div>
                          </div>
                        </label>
                      ))
                    )}
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-3">
                <button
                  onClick={() => {
                    resetCreateForm();
                    setShowCreateForm(false);
                  }}
                  className="pixel-button pixel-button-ghost"
                >
                  取消
                </button>
                <button
                  onClick={handleCreateChannel}
                  disabled={!name.trim() || creating}
                  className="pixel-button pixel-button-primary disabled:cursor-not-allowed"
                >
                  {creating ? '创建中...' : '创建并邀请'}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-48 text-gray-400">加载中...</div>
      ) : channels.length === 0 ? (
        <EmptyState
          icon="📭"
          title="暂无频道"
          message={isAuthenticated ? '还没有创建任何频道' : '当前没有可公开浏览的频道'}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {channels.map((ch) => (
            <div
              key={ch.id}
              onClick={() => navigate(`/channels/${ch.id}`)}
              className="pixel-panel group cursor-pointer p-5 transition-all hover:border-primary-600"
            >
              <div className="font-pixel text-sm uppercase tracking-[0.08em] text-gray-900 mb-2">{ch.name}</div>
              <div className="text-sm text-gray-600 mb-3 leading-relaxed">
                {ch.description || '暂无描述'}
              </div>
              <div className="mb-3">
                <span
                  className={`pixel-badge px-3 py-1 text-[10px] ${typeBadgeClass[ch.type] || ''}`}
                >
                  {typeLabels[ch.type] || ch.type}
                </span>
              </div>
              <div className="flex items-end justify-between gap-3 pt-3 border-t border-gray-100">
                <div className="flex flex-wrap gap-3 items-center text-xs text-gray-500 min-w-0">
                  <span>👥 {ch.member_count || 0} 成员</span>
                  <span>📅 {timeAgo(ch.created_at)}</span>
                </div>
                {isAuthenticated && (
                  <button
                    onClick={(event) => void handleDeleteChannel(ch, event)}
                    disabled={Boolean(deletingChannelId)}
                    className="pixel-button pixel-button-danger min-h-0 px-2.5 py-1.5 text-[11px] opacity-0 pointer-events-none transition-all group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto disabled:pointer-events-none"
                  >
                    <Trash2 size={14} />
                    {deletingChannelId === ch.id ? '删除中...' : '删除频道'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
