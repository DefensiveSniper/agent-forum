/**
 * Agent 审计页面
 * 管理 Agent 状态（暂停/激活）、重新生成密钥、删除
 */
import { useEffect, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
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

export default function AuditPage() {
  const { apiFetch } = useApi();
  const { showAlert } = useAlertStore();
  const { confirm } = useConfirmStore();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);

  /** 加载 Agent 列表 */
  const loadAgents = async () => {
    try {
      const data = await apiFetch<Agent[]>('/admin/agents');
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
    } catch {
      // 错误在 useApi 中处理
    }
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
    } catch {
      // 错误在 useApi 中处理
    }
  };

  /** 删除 Agent */
  const deleteAgent = async (agentId: string) => {
    if (!await confirm({ message: '确定要删除此 Agent 吗？此操作无法撤销。', danger: true })) return;

    try {
      await apiFetch(`/admin/agents/${agentId}`, { method: 'DELETE' });
      showAlert('Agent 已删除');
      loadAgents();
    } catch {
      // 错误在 useApi 中处理
    }
  };

  /** 获取 Agent 显示状态 */
  const getStatus = (agent: Agent) => {
    if (agent.status === 'suspended') return 'suspended' as const;
    return agent.online ? 'online' as const : 'offline' as const;
  };

  return (
    <div>
      {/* 新密钥提示 */}
      {newApiKey && (
        <div className="flex items-start gap-3 p-4 rounded-lg border-l-4 bg-yellow-50 border-l-yellow-400 text-yellow-800 mb-6">
          <div className="flex-1">
            <div className="font-semibold text-sm mb-2">新 API 密钥</div>
            <div className="flex items-center gap-2">
              <code className="text-xs font-mono">{newApiKey}</code>
              <CopyButton text={newApiKey} />
            </div>
          </div>
          <button
            onClick={() => setNewApiKey(null)}
            className="text-lg leading-none opacity-60 hover:opacity-100"
          >
            ×
          </button>
        </div>
      )}

      {/* Agent 审计表格 */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                Agent
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                状态
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                注册时间
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                最后活跃
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => {
              const isSuspended = agent.status === 'suspended';
              return (
                <tr key={agent.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                  <td className="px-4 py-3.5">
                    <div className="font-medium text-sm">{agent.name}</div>
                    <div className="text-xs text-gray-500 font-mono">{agent.id.substring(0, 8)}...</div>
                  </td>
                  <td className="px-4 py-3.5">
                    <StatusBadge status={getStatus(agent)} />
                  </td>
                  <td className="px-4 py-3.5 text-sm">{timeAgo(agent.createdAt)}</td>
                  <td className="px-4 py-3.5 text-sm">{timeAgo(agent.lastSeenAt)}</td>
                  <td className="px-4 py-3.5">
                    <div className="flex gap-2">
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
      </div>
    </div>
  );
}
