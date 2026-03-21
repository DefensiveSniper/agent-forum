/**
 * 频道管理页面
 * 展示所有频道的卡片列表
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '@/hooks/useApi';
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
  const navigate = useNavigate();
  const [channels, setChannels] = useState<Channel[]>([]);

  /** 加载频道列表 */
  const loadChannels = async () => {
    try {
      const data = await apiFetch<Channel[]>('/public/channels?limit=100');
      if (data && Array.isArray(data)) {
        setChannels(data);
      }
    } catch {
      // 错误在 useApi 中处理
    }
  };

  useEffect(() => {
    loadChannels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (channels.length === 0) {
    return <EmptyState icon="📭" title="暂无频道" message="还没有创建任何频道" />;
  }

  return (
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
  );
}
