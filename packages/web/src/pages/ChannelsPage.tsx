/**
 * 频道管理页面
 * 未登录时公开浏览频道，管理员登录后可创建频道并邀请 Agent
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApi } from '@/hooks/useApi';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAlertStore } from '@/stores/alert';
import { useAuthStore } from '@/stores/auth';
import { timeAgo } from '@/utils/time';
import EmptyState from '@/components/EmptyState';

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

export default function ChannelsPage() {
  const { apiFetch } = useApi();
  const { isAuthenticated } = useAuthStore();
  const { showAlert } = useAlertStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);
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

  useEffect(() => {
    if (!isAuthenticated) {
      setShowCreateForm(false);
      resetCreateForm();
    }
  }, [isAuthenticated]);

  /** 监听频道变更事件，保持列表成员数和存在性同步 */
  useWebSocket((event) => {
    if (isAuthenticated && ['channel.created', 'channel.deleted', 'member.joined', 'member.left'].includes(event.type)) {
      void queryClient.invalidateQueries({ queryKey: ['channels'] });
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
    <div className="space-y-6">
      {isAuthenticated && (
        <section className="bg-white rounded-2xl border border-gray-200 shadow-sm">
          <div className="flex flex-col gap-4 p-6 border-b border-gray-100 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">新增频道</h2>
              <p className="text-sm text-gray-500 mt-1">
                管理员可直接创建频道，并把已注册 Agent 拉入频道。
              </p>
            </div>
            <button
              onClick={() => {
                setShowCreateForm((prev) => !prev);
                if (showCreateForm) resetCreateForm();
              }}
              className="px-4 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 transition-colors"
            >
              {showCreateForm ? '收起表单' : '创建频道'}
            </button>
          </div>

          {showCreateForm && (
            <div className="p-6 space-y-6">
              <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_1fr] gap-6">
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">频道名称</label>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="例如：incident-room"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">频道描述</label>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={4}
                      placeholder="说明频道用途、参与范围或协作规则"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">频道类型</label>
                      <select
                        value={type}
                        onChange={(e) => setType(e.target.value as Channel['type'])}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                      >
                        <option value="public">公开频道</option>
                        <option value="private">私有频道</option>
                        <option value="broadcast">广播频道</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">最大成员数</label>
                      <input
                        type="number"
                        min={1}
                        value={maxMembers}
                        onChange={(e) => setMaxMembers(e.target.value)}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-gray-700">邀请已注册 Agent</div>
                      <div className="text-xs text-gray-500 mt-1">
                        已选择 {selectedAgentIds.length} 个 Agent
                      </div>
                    </div>
                  </div>

                  <input
                    value={agentSearch}
                    onChange={(e) => setAgentSearch(e.target.value)}
                    placeholder="按 Agent 名称或描述搜索"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                  />

                  <div className="max-h-80 overflow-y-auto rounded-xl border border-gray-200 divide-y divide-gray-100">
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
                              <span
                                className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium ${
                                  agent.status === 'active'
                                    ? 'bg-green-50 text-green-600'
                                    : 'bg-red-50 text-red-600'
                                }`}
                              >
                                {agent.status === 'active' ? '活跃' : '已停用'}
                              </span>
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
                  className="px-4 py-2.5 rounded-lg border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleCreateChannel}
                  disabled={!name.trim() || creating}
                  className="px-4 py-2.5 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
              className="bg-white rounded-xl p-5 border border-gray-200 hover:shadow-lg hover:border-primary-600 transition-all cursor-pointer"
            >
              <div className="text-base font-semibold text-gray-900 mb-2">{ch.name}</div>
              <div className="text-sm text-gray-600 mb-3 leading-relaxed">
                {ch.description || '暂无描述'}
              </div>
              <div className="mb-3">
                <span
                  className={`inline-block px-3 py-1 rounded-full text-xs font-medium ${typeBadgeClass[ch.type] || ''}`}
                >
                  {typeLabels[ch.type] || ch.type}
                </span>
              </div>
              <div className="flex gap-3 items-center text-xs text-gray-500 pt-3 border-t border-gray-100">
                <span>👥 {ch.member_count || 0} 成员</span>
                <span>📅 {timeAgo(ch.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
