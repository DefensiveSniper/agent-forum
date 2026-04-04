/**
 * 邀请码管理页面
 * 支持生成、查看、作废邀请码
 */
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useApi } from '@/hooks/useApi';
import { useAlertStore } from '@/stores/alert';
import { useConfirmStore } from '@/stores/confirm';
import { timeAgo } from '@/utils/time';
import CopyButton from '@/components/CopyButton';
import EmptyState from '@/components/EmptyState';

interface Invite {
  id: string;
  code: string;
  label: string | null;
  max_uses: number;
  uses_count: number;
  revoked: boolean;
  expires_at: string | null;
  created_at: string;
}

/** 计算邀请码当前状态 */
function getInviteStatus(inv: Invite): string {
  if (inv.revoked) return 'revoked';
  if (inv.expires_at && new Date(inv.expires_at) < new Date()) return 'expired';
  if (inv.max_uses > 0 && inv.uses_count >= inv.max_uses) return 'exhausted';
  return 'valid';
}

/** 状态徽章样式映射 */
const statusBadges: Record<string, { label: string; className: string }> = {
  valid: { label: '有效', className: 'bg-green-50 text-green-600' },
  revoked: { label: '已作废', className: 'bg-red-50 text-red-600' },
  expired: { label: '已过期', className: 'bg-red-50 text-red-600' },
  exhausted: { label: '已用完', className: 'bg-red-50 text-red-600' },
};

export default function InvitesPage() {
  const { apiFetch } = useApi();
  const { showAlert } = useAlertStore();
  const { confirm } = useConfirmStore();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState('');
  const [maxUses, setMaxUses] = useState('0');

  /** 加载邀请码列表 */
  const loadInvites = async () => {
    try {
      const data = await apiFetch<Invite[]>('/admin/invites');
      if (data && Array.isArray(data)) {
        setInvites(data);
      }
    } catch {
      // 错误在 useApi 中处理
    }
  };

  useEffect(() => {
    loadInvites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 提交生成邀请码 */
  const handleSubmit = async () => {
    if (!label) {
      showAlert('请输入邀请码标签', 'error');
      return;
    }

    try {
      const result = await apiFetch('/admin/invites', {
        method: 'POST',
        body: JSON.stringify({ label, maxUses: parseInt(maxUses) || 0 }),
      });

      if (result) {
        showAlert('邀请码生成成功');
        setShowForm(false);
        setLabel('');
        setMaxUses('0');
        loadInvites();
      }
    } catch {
      // 错误在 useApi 中处理
    }
  };

  /** 作废邀请码 */
  const handleRevoke = async (inviteId: string) => {
    if (!await confirm({ message: '确定要作废此邀请码吗？', danger: true })) return;

    try {
      await apiFetch(`/admin/invites/${inviteId}`, { method: 'DELETE' });
      showAlert('邀请码已作废');
      loadInvites();
    } catch {
      // 错误在 useApi 中处理
    }
  };

  return (
    <div className="pixel-page">
      {/* 操作按钮 */}
      <div className="mb-6 flex justify-end">
        <button
          onClick={() => setShowForm(!showForm)}
          className="pixel-button pixel-button-primary"
        >
          <Plus size={16} />
          生成邀请码
        </button>
      </div>

      {/* 生成表单 */}
      {showForm && (
        <div className="pixel-panel mb-6 max-w-[640px] p-6">
          <div className="pixel-kicker">Invite Generator</div>
          <h3 className="pixel-title mt-3 text-lg">生成新邀请码</h3>
          <div className="space-y-4">
            <div>
              <label className="mb-2 block font-pixel text-xs uppercase tracking-[0.08em] text-gray-500">标签</label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="例如: 内测用户"
                className="pixel-input w-full px-3 py-2.5 text-sm"
              />
            </div>
            <div>
              <label className="mb-2 block font-pixel text-xs uppercase tracking-[0.08em] text-gray-500">
                最大使用次数 (0 = 无限)
              </label>
              <input
                type="number"
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                min="0"
                className="pixel-input w-full px-3 py-2.5 text-sm"
              />
            </div>
            <div className="flex gap-3 justify-end pt-4 border-t border-gray-200">
              <button
                onClick={() => setShowForm(false)}
                className="pixel-button pixel-button-ghost"
              >
                取消
              </button>
              <button
                onClick={handleSubmit}
                className="pixel-button pixel-button-primary"
              >
                生成
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 邀请码列表 */}
      {invites.length === 0 ? (
        <EmptyState icon="🎫" title="暂无邀请码" message="点击上方按钮生成邀请码" />
      ) : (
        <div className="pixel-panel overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  标签
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  邀请码
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  使用情况
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  状态
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  创建时间
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {invites.map((inv) => {
                const status = getInviteStatus(inv);
                const badge = statusBadges[status];
                return (
                  <tr key={inv.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                    <td className="px-4 py-3.5 text-sm">{inv.label || '无标签'}</td>
                    <td className="px-4 py-3.5 text-sm">
                      <div className="flex items-center gap-2">
                        <code className="text-xs">{inv.code.substring(0, 12)}...</code>
                        <CopyButton text={inv.code} />
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-sm">
                      {inv.uses_count || 0}{inv.max_uses > 0 ? ` / ${inv.max_uses}` : ' / 无限'}
                    </td>
                    <td className="px-4 py-3.5 text-sm">
                      <span className={`inline-block px-3 py-1 rounded-full text-xs font-medium ${badge.className}`}>
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-sm">{timeAgo(inv.created_at)}</td>
                    <td className="px-4 py-3.5 text-sm">
                      {status === 'valid' ? (
                        <button
                          onClick={() => handleRevoke(inv.id)}
                          className="pixel-button pixel-button-danger min-h-0 px-3 py-1.5 text-[11px]"
                        >
                          作废
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
