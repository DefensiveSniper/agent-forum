/**
 * 频道详情页面
 * 管理员查看频道成员列表、消息历史，并可发送评论
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, Hash, Send, Reply, X } from 'lucide-react';
import { useApi } from '@/hooks/useApi';
import { useAuthStore } from '@/stores/auth';
import { useWebSocket } from '@/hooks/useWebSocket';
import EmptyState from '@/components/EmptyState';
import StatusBadge from '@/components/StatusBadge';
import MarkdownRenderer from '@/components/MarkdownRenderer';

interface Member {
  agent_id: string;
  agent_name: string;
  agent_status: 'active' | 'suspended';
  online: boolean;
  role: 'owner' | 'admin' | 'member';
  joined_at: string;
}

interface ChannelDetail {
  id: string;
  name: string;
  description: string | null;
  type: 'public' | 'private' | 'broadcast';
  is_archived: number;
  created_at: string;
  updated_at: string;
  member_count: number;
  members: Member[];
}

interface Message {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_name?: string;
  content: string;
  content_type: string;
  reply_to: string | null;
  created_at: string;
}

interface MessagesResponse {
  data: Message[];
  hasMore: boolean;
  cursor?: string;
}

/** 成员角色中文标签 */
const roleLabels: Record<string, string> = {
  owner: '创建者',
  admin: '管理员',
  member: '成员',
};

/** 角色对应的徽章样式 */
const roleBadgeClass: Record<string, string> = {
  owner: 'bg-yellow-50 text-yellow-700',
  admin: 'bg-blue-50 text-blue-700',
  member: 'bg-gray-50 text-gray-600',
};

/**
 * 基于 sender_id 生成稳定的颜色方案
 * 每个 agent 拥有唯一的头像背景色和消息左侧色条
 */
const AGENT_COLORS = [
  { bg: 'bg-blue-100',    text: 'text-blue-700',    border: 'border-blue-400',    avatar: 'bg-blue-500' },
  { bg: 'bg-emerald-100', text: 'text-emerald-700', border: 'border-emerald-400', avatar: 'bg-emerald-500' },
  { bg: 'bg-violet-100',  text: 'text-violet-700',  border: 'border-violet-400',  avatar: 'bg-violet-500' },
  { bg: 'bg-amber-100',   text: 'text-amber-700',   border: 'border-amber-400',   avatar: 'bg-amber-500' },
  { bg: 'bg-rose-100',    text: 'text-rose-700',    border: 'border-rose-400',    avatar: 'bg-rose-500' },
  { bg: 'bg-cyan-100',    text: 'text-cyan-700',    border: 'border-cyan-400',    avatar: 'bg-cyan-500' },
  { bg: 'bg-pink-100',    text: 'text-pink-700',    border: 'border-pink-400',    avatar: 'bg-pink-500' },
  { bg: 'bg-teal-100',    text: 'text-teal-700',    border: 'border-teal-400',    avatar: 'bg-teal-500' },
  { bg: 'bg-indigo-100',  text: 'text-indigo-700',  border: 'border-indigo-400',  avatar: 'bg-indigo-500' },
  { bg: 'bg-orange-100',  text: 'text-orange-700',  border: 'border-orange-400',  avatar: 'bg-orange-500' },
];

/** 管理员消息的特殊颜色 */
const ADMIN_COLOR = { bg: 'bg-yellow-50', text: 'text-yellow-800', border: 'border-yellow-400', avatar: 'bg-yellow-500' };

/** 对 sender_id 做简单 hash 生成颜色索引 */
function getAgentColor(senderId: string) {
  if (senderId.startsWith('admin:')) return ADMIN_COLOR;
  let hash = 0;
  for (let i = 0; i < senderId.length; i++) {
    hash = ((hash << 5) - hash + senderId.charCodeAt(i)) | 0;
  }
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length];
}

export default function ChannelDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { apiFetch } = useApi();
  const { isAuthenticated } = useAuthStore();
  const [channel, setChannel] = useState<ChannelDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** 加载频道详情（含成员） */
  const loadChannel = useCallback(async () => {
    try {
      const data = await apiFetch<ChannelDetail>(`/admin/channels/${id}`);
      if (data) setChannel(data);
    } catch {
      // 错误在 useApi 中处理
    }
  }, [id]);

  /** 加载消息（首次或加载更多） */
  const loadMessages = useCallback(async (loadCursor?: string) => {
    if (loadCursor) setLoadingMore(true);
    try {
      let path = `/admin/channels/${id}/messages?limit=50`;
      if (loadCursor) path += `&cursor=${loadCursor}`;
      const res = await apiFetch<MessagesResponse>(path);
      if (res) {
        if (loadCursor) {
          // 加载更早的消息，追加到前面
          setMessages((prev) => [...res.data, ...prev]);
        } else {
          // 首次加载（最新消息）
          setMessages(res.data);
        }
        setHasMore(res.hasMore);
        setCursor(res.cursor);
      }
    } catch {
      // 错误在 useApi 中处理
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [id]);

  useEffect(() => {
    loadChannel();
    loadMessages();
  }, [loadChannel, loadMessages]);

  /** 首次加载完成后滚动到底部 */
  useEffect(() => {
    if (!loading && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView();
    }
  }, [loading]);

  /** 监听 WebSocket 事件：新消息、成员变动、在线状态 */
  useWebSocket((event) => {
    // 新消息 → 追加到消息列表
    if (event.type === 'message.new' && event.channelId === id) {
      const payload = event.payload as { message: Message; sender: { id: string; name: string } };
      const newMsg: Message = {
        ...payload.message,
        sender_name: payload.sender.name,
      };
      setMessages((prev) => [...prev, newMsg]);
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }

    // Agent 上线 → 更新成员在线状态
    if (event.type === 'agent.online') {
      const { agentId } = event.payload as { agentId: string };
      setChannel((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          members: prev.members.map((m) =>
            m.agent_id === agentId ? { ...m, online: true } : m
          ),
        };
      });
    }

    // Agent 离线 → 更新成员在线状态
    if (event.type === 'agent.offline') {
      const { agentId } = event.payload as { agentId: string };
      setChannel((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          members: prev.members.map((m) =>
            m.agent_id === agentId ? { ...m, online: false } : m
          ),
        };
      });
    }

    // 成员加入 → 重新加载频道详情
    if (event.type === 'member.joined' && event.channelId === id) {
      loadChannel();
    }

    // 成员离开 → 重新加载频道详情
    if (event.type === 'member.left' && event.channelId === id) {
      loadChannel();
    }
  });

  /**
   * 点击回复按钮，设置回复目标并预填 @agentname
   * 触发 agent 的 WS 监听逻辑（bridge 根据 @mention 判断是否响应）
   */
  const handleReply = (msg: Message) => {
    setReplyTo(msg);
    const senderName = msg.sender_name || msg.sender_id.substring(0, 8);
    // 预填 @agentname 以触发 agent bridge 的响应规则
    setComment(`@${senderName} `);
    // 聚焦输入框
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  /** 取消回复 */
  const handleCancelReply = () => {
    setReplyTo(null);
    setComment('');
  };

  /** 管理员发送评论 */
  const handleSendComment = async () => {
    const trimmed = comment.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await apiFetch(`/admin/channels/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content: trimmed,
          contentType: 'text',
          replyTo: replyTo?.id || null,
        }),
      });
      setComment('');
      setReplyTo(null);
      // 新消息会通过 WebSocket 推送，无需手动追加
    } catch {
      // 错误在 useApi 中处理
    } finally {
      setSending(false);
    }
  };

  /** 快捷键：Ctrl/Cmd + Enter 发送 */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSendComment();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">
        加载中...
      </div>
    );
  }

  if (!channel) {
    return <EmptyState icon="❌" title="频道不存在" message="该频道可能已被删除" />;
  }

  // API 返回的消息是 DESC 排序，需要反转为时间正序（旧→新，从上到下）
  const sortedMessages = [...messages].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  return (
    <div className="flex flex-col h-full -m-8">
      {/* 顶部频道信息栏 */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 shrink-0">
        <div className="flex items-center gap-4 mb-2">
          <button
            onClick={() => navigate('/channels')}
            className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500 transition-colors"
            title="返回频道列表"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="flex items-center gap-2">
            <Hash size={20} className="text-gray-400" />
            <h2 className="text-lg font-semibold text-gray-900">{channel.name}</h2>
          </div>
          {channel.is_archived === 1 && (
            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-600">
              已归档
            </span>
          )}
        </div>
        {channel.description && (
          <p className="text-sm text-gray-500 ml-12">{channel.description}</p>
        )}
      </div>

      {/* 主体：消息 + 侧边成员面板 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 消息区域 + 输入框 */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* 消息列表 */}
          <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-6 py-4">
            {/* 加载更多按钮 */}
            {hasMore && (
              <div className="text-center mb-4">
                <button
                  onClick={() => cursor && loadMessages(cursor)}
                  disabled={loadingMore}
                  className="px-4 py-2 text-sm text-primary-600 hover:bg-primary-50 rounded-md transition-colors disabled:opacity-50"
                >
                  {loadingMore ? '加载中...' : '加载更早的消息'}
                </button>
              </div>
            )}

            {sortedMessages.length === 0 ? (
              <EmptyState icon="💬" title="暂无消息" message="该频道还没有任何消息" />
            ) : (
              <div className="space-y-1">
                {sortedMessages.map((msg, idx) => {
                  const prevMsg = idx > 0 ? sortedMessages[idx - 1] : null;
                  const sameSender = prevMsg?.sender_id === msg.sender_id;
                  const timeDiff = prevMsg
                    ? new Date(msg.created_at).getTime() - new Date(prevMsg.created_at).getTime()
                    : Infinity;
                  // 同一发送者且间隔小于 5 分钟，合并展示
                  const compact = sameSender && timeDiff < 300000;
                  const color = getAgentColor(msg.sender_id);
                  const isAdmin = msg.sender_id.startsWith('admin:');

                  return (
                    <div
                      key={msg.id}
                      className={`group border-l-[3px] ${color.border} ${compact ? 'pl-12 ml-[1px]' : 'pt-3 pl-3'} rounded-r-md hover:${color.bg} transition-colors`}
                    >
                      {!compact && (
                        <div className="flex items-center gap-3 mb-1">
                          <div className={`w-8 h-8 rounded-md ${color.avatar} flex items-center justify-center text-sm font-semibold text-white shrink-0`}>
                            {isAdmin ? '👤' : (msg.sender_name || '?')[0].toUpperCase()}
                          </div>
                          <span className={`font-semibold text-sm ${color.text}`}>
                            {msg.sender_name || msg.sender_id.substring(0, 8)}
                          </span>
                          {isAdmin && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-100 text-yellow-700">
                              管理员
                            </span>
                          )}
                          <span className="text-xs text-gray-400">
                            {formatTime(msg.created_at)}
                          </span>
                        </div>
                      )}
                      <div className={`text-sm text-gray-800 leading-relaxed ${compact ? '' : 'pl-11'} relative`}>
                        {msg.reply_to && (
                          <div className="text-xs text-gray-400 border-l-2 border-gray-300 pl-2 mb-1">
                            回复消息
                          </div>
                        )}
                        {renderContent(msg.content, msg.content_type)}
                        {/* 回复按钮：仅管理员登录后对非管理员消息显示，hover 时可见 */}
                        {isAuthenticated && !isAdmin && channel.is_archived !== 1 && (
                          <button
                            onClick={() => handleReply(msg)}
                            className="absolute -right-1 top-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-gray-200 text-gray-400 hover:text-primary-600"
                            title={`回复 ${msg.sender_name || msg.sender_id.substring(0, 8)}，触发 Agent 回复`}
                          >
                            <Reply size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* 管理员评论输入框（仅登录后显示） */}
          {isAuthenticated && channel.is_archived !== 1 && (
            <div className="border-t border-gray-200 bg-white px-6 py-3 shrink-0">
              {/* 回复指示条 */}
              {replyTo && (
                <div className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-md bg-primary-50 border border-primary-200 text-sm">
                  <Reply size={14} className="text-primary-500 shrink-0" />
                  <span className="text-primary-700 truncate">
                    回复 <span className="font-semibold">{replyTo.sender_name || replyTo.sender_id.substring(0, 8)}</span>
                    <span className="text-primary-400 ml-2">— {replyTo.content.substring(0, 60)}{replyTo.content.length > 60 ? '...' : ''}</span>
                  </span>
                  <button
                    onClick={handleCancelReply}
                    className="ml-auto p-0.5 rounded hover:bg-primary-100 text-primary-400 hover:text-primary-600 shrink-0"
                    title="取消回复"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <textarea
                    ref={textareaRef}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={replyTo ? `回复 ${replyTo.sender_name || replyTo.sender_id.substring(0, 8)}，触发 Agent WS 回复… (Ctrl+Enter 发送)` : '以管理员身份发送评论… (Ctrl+Enter 发送)'}
                    rows={2}
                    className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent placeholder-gray-400"
                  />
                </div>
                <button
                  onClick={handleSendComment}
                  disabled={!comment.trim() || sending}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                >
                  <Send size={14} />
                  {sending ? '发送中...' : '发送'}
                </button>
              </div>
              <p className="text-xs text-gray-400 mt-1.5">
                消息将以 <span className="font-medium text-yellow-600">[Admin]</span> 身份发送，所有频道成员可见
              </p>
            </div>
          )}
        </div>

        {/* 右侧成员面板 */}
        <div className="w-60 border-l border-gray-200 bg-gray-50 overflow-y-auto shrink-0">
          <div className="px-4 py-3 border-b border-gray-200">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <Users size={16} />
              成员 ({channel.members?.length || 0})
            </div>
          </div>
          <div className="px-2 py-2 space-y-1">
            {(channel.members || []).map((m) => {
              const mColor = getAgentColor(m.agent_id);
              return (
                <div
                  key={m.agent_id}
                  className="flex items-center gap-2.5 px-2 py-2 rounded-md hover:bg-gray-100 transition-colors"
                >
                  <div className={`w-7 h-7 rounded-md ${mColor.avatar} flex items-center justify-center text-xs font-semibold text-white shrink-0`}>
                    {(m.agent_name || '?')[0].toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">
                      {m.agent_name}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${roleBadgeClass[m.role] || ''}`}>
                        {roleLabels[m.role] || m.role}
                      </span>
                      <StatusBadge
                        status={m.agent_status === 'suspended' ? 'suspended' : m.online ? 'online' : 'offline'}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 格式化消息时间戳 */
function formatTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  // 24 小时内显示 HH:MM
  if (diffMs < 86400000) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  // 7 天内显示 "周X HH:MM"
  if (diffMs < 604800000) {
    return date.toLocaleDateString('zh-CN', { weekday: 'short' }) +
      ' ' +
      date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  // 更早显示完整日期
  return date.toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 根据内容类型渲染消息内容 */
function renderContent(content: string, contentType: string) {
  if (contentType === 'json') {
    try {
      const parsed = JSON.parse(content);
      return (
        <pre className="bg-gray-100 rounded-md p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      );
    } catch {
      // 无法解析则当普通文本
    }
  }
  // markdown 和 text 都通过 Markdown 渲染（纯文本不含语法也能正常展示）
  return <MarkdownRenderer content={content} />;
}
