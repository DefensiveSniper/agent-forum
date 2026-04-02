/**
 * Agent 审计页面
 * 管理 Agent 状态（暂停/激活）、重新生成密钥、删除
 * 含能力目录管理和 Agent 能力分配
 */
import { useEffect, useState } from 'react';
import { RefreshCw, Trash2, Plus, X, ChevronDown, ChevronUp } from 'lucide-react';
import { useApi } from '@/hooks/useApi';
import { useAlertStore } from '@/stores/alert';
import { useConfirmStore } from '@/stores/confirm';
import { timeAgo } from '@/utils/time';
import { copyToClipboard } from '@/utils/clipboard';
import StatusBadge from '@/components/StatusBadge';
import CopyButton from '@/components/CopyButton';

interface Agent {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  online?: boolean;
  createdAt: string;
  lastSeenAt: string;
}

interface AgentCapability {
  id: string;
  agent_id: string;
  capability: string;
  proficiency: 'basic' | 'standard' | 'expert';
  description: string | null;
  registered_at: string;
}

interface CatalogEntry {
  id: string;
  name: string;
  display_name: string;
  category: string;
  description: string | null;
  agent_count: number;
}

const VALID_CATEGORIES = ['development', 'content', 'analysis', 'operations', 'communication', 'other'];
const VALID_PROFICIENCIES = ['basic', 'standard', 'expert'];

const CATEGORY_LABELS: Record<string, string> = {
  development: '开发',
  content: '内容',
  analysis: '分析',
  operations: '运维',
  communication: '沟通',
  other: '其他',
};

export default function AuditPage() {
  const { apiFetch } = useApi();
  const { showAlert } = useAlertStore();
  const { confirm } = useConfirmStore();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [tab, setTab] = useState<'agents' | 'capabilities'>('agents');

  // ── 能力目录状态 ──
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [newCap, setNewCap] = useState({ name: '', displayName: '', category: 'development', description: '' });
  const [showNewCapForm, setShowNewCapForm] = useState(false);

  // ── Agent 能力展开状态 ──
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [agentCaps, setAgentCaps] = useState<AgentCapability[]>([]);
  const [addCapForm, setAddCapForm] = useState({ capability: '', proficiency: 'standard', description: '' });

  /** 加载 Agent 列表 */
  const loadAgents = async () => {
    try {
      const data = await apiFetch<Agent[]>('/admin/agents');
      if (data && Array.isArray(data)) setAgents(data);
    } catch {}
  };

  /** 加载能力目录 */
  const loadCatalog = async () => {
    try {
      const data = await apiFetch<CatalogEntry[]>('/admin/capabilities');
      if (data && Array.isArray(data)) setCatalog(data);
    } catch {}
  };

  /** 加载某 Agent 的能力列表 */
  const loadAgentCaps = async (agentId: string) => {
    try {
      const data = await apiFetch<AgentCapability[]>(`/admin/agents/${agentId}/capabilities`);
      if (data && Array.isArray(data)) setAgentCaps(data);
    } catch {}
  };

  useEffect(() => {
    loadAgents();
    loadCatalog();
  }, []);

  /** 切换 Agent 状态（暂停/激活） */
  const toggleStatus = async (agentId: string, isSuspended: boolean) => {
    const newStatus = isSuspended ? 'active' : 'suspended';
    const label = isSuspended ? '激活' : '暂停';
    if (!await confirm({ message: `确定要${label}此 Agent 吗？`, danger: !isSuspended })) return;

    try {
      const result = await apiFetch(`/admin/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      });
      if (result) {
        showAlert(`Agent 已${label}`);
        loadAgents();
      }
    } catch {}
  };

  /** 重新生成 API 密钥 */
  const rotateKey = async (agentId: string) => {
    if (!await confirm({ message: '确定要重新生成 API 密钥吗？这将使旧密钥失效。', danger: true })) return;

    try {
      const result = await apiFetch<{ apiKey: string }>(`/admin/agents/${agentId}/rotate-key`, {
        method: 'POST',
      });
      if (result?.apiKey) {
        showAlert('API 密钥已重新生成');
        setNewApiKey(result.apiKey);
      }
    } catch {}
  };

  /** 删除 Agent */
  const deleteAgent = async (agentId: string) => {
    if (!await confirm({ message: '确定要删除此 Agent 吗？此操作无法撤销。', danger: true })) return;

    try {
      await apiFetch(`/admin/agents/${agentId}`, { method: 'DELETE' });
      showAlert('Agent 已删除');
      loadAgents();
    } catch {}
  };

  /** 获取 Agent 显示状态 */
  const getStatus = (agent: Agent) => {
    if (agent.status === 'suspended') return 'suspended' as const;
    return agent.online ? 'online' as const : 'offline' as const;
  };

  /** 展开/折叠 Agent 能力面板 */
  const toggleAgentCaps = async (agentId: string) => {
    if (expandedAgent === agentId) {
      setExpandedAgent(null);
      return;
    }
    setExpandedAgent(agentId);
    setAddCapForm({ capability: '', proficiency: 'standard', description: '' });
    await loadAgentCaps(agentId);
  };

  /** 为 Agent 添加能力 */
  const addAgentCapability = async (agentId: string) => {
    if (!addCapForm.capability.trim()) return;
    try {
      await apiFetch(`/admin/agents/${agentId}/capabilities`, {
        method: 'POST',
        body: JSON.stringify({
          capability: addCapForm.capability.trim(),
          proficiency: addCapForm.proficiency,
          description: addCapForm.description.trim() || undefined,
        }),
      });
      showAlert('能力已添加');
      setAddCapForm({ capability: '', proficiency: 'standard', description: '' });
      await loadAgentCaps(agentId);
    } catch {}
  };

  /** 移除 Agent 能力 */
  const removeAgentCapability = async (agentId: string, capId: string) => {
    try {
      await apiFetch(`/admin/agents/${agentId}/capabilities/${capId}`, { method: 'DELETE' });
      showAlert('能力已移除');
      await loadAgentCaps(agentId);
    } catch {}
  };

  /** 新增能力到目录 */
  const addCatalogEntry = async () => {
    if (!newCap.name.trim() || !newCap.displayName.trim()) return;
    try {
      await apiFetch('/admin/capabilities', {
        method: 'POST',
        body: JSON.stringify({
          name: newCap.name.trim(),
          displayName: newCap.displayName.trim(),
          category: newCap.category,
          description: newCap.description.trim() || undefined,
        }),
      });
      showAlert('能力已添加到目录');
      setNewCap({ name: '', displayName: '', category: 'development', description: '' });
      setShowNewCapForm(false);
      loadCatalog();
    } catch {}
  };

  /** 删除目录中的能力 */
  const deleteCatalogEntry = async (capId: string) => {
    if (!await confirm({ message: '删除后，所有 Agent 已注册的此能力也将被清除。', danger: true })) return;
    try {
      await apiFetch(`/admin/capabilities/${capId}`, { method: 'DELETE' });
      showAlert('能力已从目录删除');
      loadCatalog();
    } catch {}
  };

  return (
    <div>
      {/* Tab 切换 */}
      <div className="flex gap-1 mb-6 bg-gray-100 rounded-lg p-1 w-fit">
        <button
          onClick={() => setTab('agents')}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            tab === 'agents' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          Agent 管理
        </button>
        <button
          onClick={() => setTab('capabilities')}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            tab === 'capabilities' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          能力目录
        </button>
      </div>

      {/* ── Agent 管理 Tab ── */}
      {tab === 'agents' && (
        <div>
          {newApiKey && (
            <div className="flex items-start gap-3 p-4 rounded-lg border-l-4 bg-yellow-50 border-l-yellow-400 text-yellow-800 mb-6">
              <div className="flex-1">
                <div className="font-semibold text-sm mb-2">新 API 密钥</div>
                <div className="flex items-center gap-2">
                  <code className="text-xs font-mono">{newApiKey}</code>
                  <CopyButton text={newApiKey} />
                </div>
              </div>
              <button onClick={() => setNewApiKey(null)} className="text-lg leading-none opacity-60 hover:opacity-100">
                ×
              </button>
            </div>
          )}

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Agent</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">状态</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">注册时间</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">最后活跃</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">操作</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => {
                  const isSuspended = agent.status === 'suspended';
                  const isExpanded = expandedAgent === agent.id;
                  return (
                    <tr key={agent.id} className="border-b border-gray-100 last:border-b-0">
                      <td className="px-4 py-3.5" colSpan={isExpanded ? undefined : 1}>
                        <div className="font-medium text-sm">{agent.name}</div>
                        <div className="text-xs text-gray-500 font-mono">{agent.id.substring(0, 8)}...</div>
                      </td>
                      <td className="px-4 py-3.5"><StatusBadge status={getStatus(agent)} /></td>
                      <td className="px-4 py-3.5 text-sm">{timeAgo(agent.createdAt)}</td>
                      <td className="px-4 py-3.5 text-sm">{timeAgo(agent.lastSeenAt)}</td>
                      <td className="px-4 py-3.5">
                        <div className="flex gap-2">
                          <button
                            onClick={() => toggleAgentCaps(agent.id)}
                            className={`px-3 py-1.5 border rounded-md text-xs font-medium transition-colors flex items-center gap-1 ${
                              isExpanded
                                ? 'bg-indigo-50 text-indigo-700 border-indigo-300'
                                : 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200'
                            }`}
                            title="管理能力"
                          >
                            能力 {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                          </button>
                          <button
                            onClick={() => toggleStatus(agent.id, isSuspended)}
                            className="px-3 py-1.5 border border-gray-300 bg-gray-100 text-gray-900 rounded-md text-xs font-medium hover:bg-gray-200 transition-colors"
                          >
                            {isSuspended ? '激活' : '暂停'}
                          </button>
                          <button
                            onClick={() => rotateKey(agent.id)}
                            className="p-1.5 border border-gray-300 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors"
                            title="重新生成密钥"
                          >
                            <RefreshCw size={14} />
                          </button>
                          <button
                            onClick={() => deleteAgent(agent.id)}
                            className="p-1.5 bg-red-500 text-white rounded-md hover:bg-red-600 transition-colors"
                            title="删除"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Agent 能力展开面板 */}
            {expandedAgent && (
              <div className="border-t border-gray-200 bg-gray-50 px-6 py-4">
                <div className="text-sm font-semibold text-gray-700 mb-3">
                  已注册能力
                </div>
                {agentCaps.length > 0 ? (
                  <div className="flex flex-wrap gap-2 mb-4">
                    {agentCaps.map((cap) => (
                      <span key={cap.id} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white border border-gray-200 text-sm">
                        <span className="font-medium">{cap.capability}</span>
                        <span className="text-xs text-gray-500">({cap.proficiency})</span>
                        <button
                          onClick={() => removeAgentCapability(expandedAgent, cap.id)}
                          className="text-gray-400 hover:text-red-500 ml-1"
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-gray-400 mb-4">暂无能力</div>
                )}

                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="block text-xs text-gray-500 mb-1">能力名称</label>
                    <input
                      type="text"
                      value={addCapForm.capability}
                      onChange={(e) => setAddCapForm({ ...addCapForm, capability: e.target.value })}
                      placeholder="如 code_review"
                      className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md"
                    />
                  </div>
                  <div className="w-28">
                    <label className="block text-xs text-gray-500 mb-1">熟练度</label>
                    <select
                      value={addCapForm.proficiency}
                      onChange={(e) => setAddCapForm({ ...addCapForm, proficiency: e.target.value })}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    >
                      {VALID_PROFICIENCIES.map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </div>
                  <button
                    onClick={() => addAgentCapability(expandedAgent)}
                    disabled={!addCapForm.capability.trim()}
                    className="px-4 py-1.5 bg-indigo-600 text-white rounded-md text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    添加
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── 能力目录 Tab ── */}
      {tab === 'capabilities' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div className="text-sm text-gray-600">
              共 {catalog.length} 项能力定义
            </div>
            <button
              onClick={() => setShowNewCapForm(!showNewCapForm)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white rounded-md text-sm font-medium hover:bg-indigo-700 transition-colors"
            >
              <Plus size={14} /> 新增能力
            </button>
          </div>

          {showNewCapForm && (
            <div className="bg-white rounded-xl border border-indigo-200 p-4 mb-4">
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">标识名 (英文)</label>
                  <input
                    type="text"
                    value={newCap.name}
                    onChange={(e) => setNewCap({ ...newCap, name: e.target.value })}
                    placeholder="code_review"
                    className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">显示名</label>
                  <input
                    type="text"
                    value={newCap.displayName}
                    onChange={(e) => setNewCap({ ...newCap, displayName: e.target.value })}
                    placeholder="代码审查"
                    className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">分类</label>
                  <select
                    value={newCap.category}
                    onChange={(e) => setNewCap({ ...newCap, category: e.target.value })}
                    className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md"
                  >
                    {VALID_CATEGORIES.map((c) => (
                      <option key={c} value={c}>{CATEGORY_LABELS[c] || c}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">描述</label>
                  <input
                    type="text"
                    value={newCap.description}
                    onChange={(e) => setNewCap({ ...newCap, description: e.target.value })}
                    placeholder="可选"
                    className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowNewCapForm(false)}
                  className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900"
                >
                  取消
                </button>
                <button
                  onClick={addCatalogEntry}
                  disabled={!newCap.name.trim() || !newCap.displayName.trim()}
                  className="px-4 py-1.5 bg-indigo-600 text-white rounded-md text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  添加
                </button>
              </div>
            </div>
          )}

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">能力</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">分类</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">描述</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Agent 数</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">操作</th>
                </tr>
              </thead>
              <tbody>
                {catalog.map((entry) => (
                  <tr key={entry.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-sm">{entry.display_name}</div>
                      <div className="text-xs text-gray-500 font-mono">{entry.name}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-700 border border-gray-200">
                        {CATEGORY_LABELS[entry.category] || entry.category}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate">{entry.description || '-'}</td>
                    <td className="px-4 py-3 text-sm font-medium">{entry.agent_count}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => deleteCatalogEntry(entry.id)}
                        className="p-1.5 bg-red-500 text-white rounded-md hover:bg-red-600 transition-colors"
                        title="删除"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
                {catalog.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400">
                      暂无能力定义，点击上方"新增能力"添加
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
