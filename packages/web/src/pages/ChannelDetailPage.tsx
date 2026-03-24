/**
 * 频道详情页面
 * 未登录时公开浏览频道详情，管理员登录后可邀请 Agent、删除频道并发送评论
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Users, Hash, Send, Reply, X, Trash2, UserPlus } from 'lucide-react';
import { useApi } from '@/hooks/useApi';
import { useAuthStore } from '@/stores/auth';
import { useAlertStore } from '@/stores/alert';
import { useConfirmStore } from '@/stores/confirm';
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
  reply_target_agent_id?: string | null;
  reply_sender_name?: string | null;
  reply_preview?: string | null;
  created_at: string;
  mentions?: Array<{ agentId: string; agentName: string }>;
  discussion?: {
    id: string;
    mode: 'linear';
    participantAgentIds: string[];
    participantCount: number;
    completedRounds: number;
    currentRound: number;
    maxRounds: number;
    status: 'active' | 'completed';
    expectedSpeakerId: string | null;
    nextSpeakerId: string | null;
    finalTurn: boolean;
    rootMessageId: string;
    lastMessageId: string;
  } | null;
}

interface MessagesResponse {
  data: Message[];
  hasMore: boolean;
  cursor?: string;
}

interface AdminAgent {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'suspended';
}

interface InviteAgentsResponse {
  invitedAgents: Array<{ id: string; name: string }>;
  invitedCount: number;
  skippedAgentIds: string[];
}

interface StartDiscussionResponse {
  message: Message;
  discussion: NonNullable<Message['discussion']>;
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

/**
 * 转义正则特殊字符，供 mention 提取使用。
 * @param {string} value
 * @returns {string}
 */
function escapeMentionRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从输入框文本中提取当前频道成员 mentions。
 * @param {string} value
 * @param {Member[]} members
 * @returns {string[]}
 */
function extractMentionAgentIds(value: string, members: Member[]) {
  const ids: string[] = [];
  const seen = new Set<string>();
  const orderedMembers = [...members].sort((a, b) => b.agent_name.length - a.agent_name.length);

  for (const member of orderedMembers) {
    const pattern = new RegExp(`(^|\\s)@${escapeMentionRegex(member.agent_name)}(?=$|\\s|[,.!?;:])`, 'g');
    if (!pattern.test(value) || seen.has(member.agent_id)) continue;
    seen.add(member.agent_id);
    ids.push(member.agent_id);
  }

  return ids;
}

/**
 * 解析光标前是否处于 @mention 输入态。
 * @param {string} value
 * @param {number} cursor
 * @returns {{ query: string, start: number, end: number }|null}
 */
function resolveMentionDraft(value: string, cursor: number) {
  const prefix = value.slice(0, cursor);
  const match = prefix.match(/(^|\s)@([^\s@]*)$/);
  if (!match) return null;

  return {
    query: match[2],
    start: cursor - match[2].length - 1,
    end: cursor,
  };
}

/**
 * 生成消息列表中的回复说明文案。
 * 后端已返回回复目标和摘要，这里只负责按展示要求拼接。
 * @param {Message} message
 * @returns {string}
 */
function getReplySummary(message: Message) {
  const replySenderName = message.reply_sender_name || '原消息';
  const replyPreview = message.reply_preview ? `：${message.reply_preview}` : '';
  return `回复 ${replySenderName} 的消息${replyPreview}`;
}

export default function ChannelDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { apiFetch } = useApi();
  const { isAuthenticated } = useAuthStore();
  const { showAlert } = useAlertStore();
  const [channel, setChannel] = useState<ChannelDetail | null>(null);
  const [allAgents, setAllAgents] = useState<AdminAgent[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [mentionDraft, setMentionDraft] = useState<{ query: string; start: number; end: number } | null>(null);
  const [showDiscussionPanel, setShowDiscussionPanel] = useState(false);
  const [selectedDiscussionAgentIds, setSelectedDiscussionAgentIds] = useState<string[]>([]);
  const [discussionRounds, setDiscussionRounds] = useState('1');
  const [startingDiscussion, setStartingDiscussion] = useState(false);
  const [showInvitePanel, setShowInvitePanel] = useState(false);
  const [inviteSearch, setInviteSearch] = useState('');
  const [selectedInviteAgentIds, setSelectedInviteAgentIds] = useState<string[]>([]);
  const [inviting, setInviting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** 加载频道详情（含成员） */
  const loadChannel = useCallback(async () => {
    try {
      const path = isAuthenticated
        ? `/admin/channels/${id}`
        : `/public/channels/${id}`;
      const data = await apiFetch<ChannelDetail>(path);
      if (data) setChannel(data);
    } catch {
      // 错误在 useApi 中处理
    }
  }, [apiFetch, id, isAuthenticated]);

  /** 加载所有已注册 Agent，用于频道内邀请 */
  const loadAgents = useCallback(async () => {
    if (!isAuthenticated) {
      setAllAgents([]);
      return;
    }

    try {
      const data = await apiFetch<AdminAgent[]>('/admin/agents');
      if (data && Array.isArray(data)) {
        setAllAgents(data);
      }
    } catch {
      // 错误在 useApi 中处理
    }
  }, [apiFetch, isAuthenticated]);

  /** 加载消息（首次或加载更多） */
  const loadMessages = useCallback(async (loadCursor?: string) => {
    if (loadCursor) setLoadingMore(true);
    try {
      let path = isAuthenticated
        ? `/admin/channels/${id}/messages?limit=50`
        : `/public/channels/${id}/messages?limit=50`;
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
  }, [apiFetch, id, isAuthenticated]);

  /** 进入频道时加载数据，仅依赖 id 和认证状态 */
  useEffect(() => {
    setLoading(true);
    loadChannel();
    loadAgents();
    loadMessages();
  }, [id, isAuthenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 首次加载完成后滚动到底部 */
  useEffect(() => {
    if (!loading && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView();
    }
  }, [loading]);

  /** 监听 WebSocket 事件：新消息、成员变动、在线状态 */
  useWebSocket((event) => {
    if (!isAuthenticated) return;

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

    // 频道被删除 → 返回列表页
    if (event.type === 'channel.deleted' && event.channelId === id && !deleting) {
      showAlert('频道已被删除', 'warning');
      navigate('/channels');
    }
  });

  /**
   * 点击回复按钮，设置回复目标并预填 @agentname
   * 触发 agent 的 WS 监听逻辑（bridge 根据 @mention 判断是否响应）
   */
  const handleReply = (msg: Message) => {
    setReplyTo(msg);
    setShowDiscussionPanel(false);
    const senderName = msg.sender_name || msg.sender_id.substring(0, 8);
    // 预填 @agentname 以触发 agent bridge 的响应规则
    setComment(`@${senderName} `);
    setMentionDraft(null);
    // 聚焦输入框
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  /** 取消回复 */
  const handleCancelReply = () => {
    setReplyTo(null);
    setComment('');
    setMentionDraft(null);
  };

  /**
   * 根据当前输入框内容和光标位置刷新 @mention 草稿状态。
   * @param {string} value
   * @param {number} cursor
   */
  const updateMentionDraft = (value: string, cursor: number) => {
    setMentionDraft(resolveMentionDraft(value, cursor));
  };

  /**
   * 将选中的成员插入输入框中的 @mention 草稿位置。
   * @param {Member} member
   */
  const applyMention = (member: Member) => {
    if (!mentionDraft || !textareaRef.current) return;

    const nextValue = `${comment.slice(0, mentionDraft.start)}@${member.agent_name} ${comment.slice(mentionDraft.end)}`;
    const nextCursor = mentionDraft.start + member.agent_name.length + 2;
    setComment(nextValue);
    setMentionDraft(null);

    requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(nextCursor, nextCursor);
    });
  };

  /**
   * 切换线性讨论参与者，保留选择顺序作为循环顺序。
   * @param {string} agentId
   */
  const toggleDiscussionAgent = (agentId: string) => {
    setSelectedDiscussionAgentIds((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId]
    );
  };

  /**
   * 切换线性讨论面板显示状态。
   */
  const toggleDiscussionPanel = () => {
    setShowDiscussionPanel((prev) => {
      const next = !prev;
      setMentionDraft(null);
      if (next) {
        setReplyTo(null);
      } else {
        setSelectedDiscussionAgentIds([]);
        setDiscussionRounds('1');
      }
      return next;
    });
  };

  /** 切换待邀请 Agent 的选择状态 */
  const toggleInviteAgent = (agentId: string) => {
    setSelectedInviteAgentIds((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId]
    );
  };

  /** 邀请选中的已注册 Agent 进入当前频道 */
  const handleInviteAgents = async () => {
    if (!id || selectedInviteAgentIds.length === 0 || inviting) return;

    setInviting(true);
    try {
      const res = await apiFetch<InviteAgentsResponse>(`/admin/channels/${id}/invite`, {
        method: 'POST',
        body: JSON.stringify({ agentIds: selectedInviteAgentIds }),
      });

      showAlert(`已邀请 ${res.invitedCount} 个 Agent`, 'success');
      setInviteSearch('');
      setSelectedInviteAgentIds([]);
      setShowInvitePanel(false);
      await loadChannel();
    } catch {
      // 错误在 useApi 中处理
    } finally {
      setInviting(false);
    }
  };

  /** 发起线性多 Agent 讨论，会按选中顺序循环并以完整循环计一轮 */
  const handleStartDiscussion = async () => {
    const trimmed = comment.trim();
    if (!id || !trimmed || startingDiscussion) return;

    setStartingDiscussion(true);
    try {
      await apiFetch<StartDiscussionResponse>(`/admin/channels/${id}/discussions`, {
        method: 'POST',
        body: JSON.stringify({
          content: trimmed,
          participantAgentIds: selectedDiscussionAgentIds,
          maxRounds: Number.parseInt(discussionRounds, 10),
        }),
      });

      setComment('');
      setReplyTo(null);
      setMentionDraft(null);
      setShowDiscussionPanel(false);
      setSelectedDiscussionAgentIds([]);
      setDiscussionRounds('1');
    } catch {
      // 错误在 useApi 中处理
    } finally {
      setStartingDiscussion(false);
    }
  };

  /** 删除当前频道及其关联成员、消息和订阅 */
  const handleDeleteChannel = async () => {
    if (!id || !channel || deleting) return;

    const confirmed = await useConfirmStore.getState().confirm({
      title: '删除频道',
      message: `删除频道「${channel.name}」后，频道成员、消息历史和订阅都会被移除。该操作不可恢复。`,
      confirmText: '删除频道',
      cancelText: '取消',
      danger: true,
    });

    if (!confirmed) return;

    setDeleting(true);
    try {
      await apiFetch(`/admin/channels/${id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['channels'] });
      showAlert(`频道 ${channel.name} 已删除`, 'success');
      navigate('/channels');
    } catch {
      // 错误在 useApi 中处理
    } finally {
      setDeleting(false);
    }
  };

  /** 管理员发送评论 */
  const handleSendComment = async () => {
    const trimmed = comment.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      const mentionAgentIds = channel ? extractMentionAgentIds(trimmed, channel.members || []) : [];
      await apiFetch(`/admin/channels/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content: trimmed,
          contentType: 'text',
          replyTo: replyTo?.id || null,
          mentionAgentIds,
        }),
      });
      setComment('');
      setReplyTo(null);
      setMentionDraft(null);
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
      if (showDiscussionPanel) handleStartDiscussion();
      else handleSendComment();
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
    return <EmptyState icon="❌" title="频道不存在" message="该频道可能不存在，或当前不可公开访问" />;
  }

  // API 返回的消息是 DESC 排序，需要反转为时间正序（旧→新，从上到下）
  const sortedMessages = [...messages].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  const memberNameMap = new Map((channel.members || []).map((member) => [member.agent_id, member.agent_name]));
  const memberIds = new Set((channel.members || []).map((member) => member.agent_id));
  const availableAgents = allAgents.filter((agent) => !memberIds.has(agent.id));
  const filteredAvailableAgents = availableAgents.filter((agent) => {
    const keyword = inviteSearch.trim().toLowerCase();
    if (!keyword) return true;
    return (
      agent.name.toLowerCase().includes(keyword) ||
      (agent.description || '').toLowerCase().includes(keyword)
    );
  });
  const mentionCandidates = (channel.members || [])
    .filter((member) => {
      if (!mentionDraft) return false;
      const keyword = mentionDraft.query.trim().toLowerCase();
      if (!keyword) return true;
      return member.agent_name.toLowerCase().includes(keyword);
    })
    .slice(0, 8);
  const discussionCandidates = (channel.members || []).filter((member) => member.online);

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
          {isAuthenticated && (
            <div className="ml-auto flex items-center gap-2">
              {channel.is_archived !== 1 && (
                <button
                  onClick={() => {
                    setShowInvitePanel((prev) => !prev);
                    if (showInvitePanel) {
                      setInviteSearch('');
                      setSelectedInviteAgentIds([]);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-primary-200 bg-primary-50 text-primary-700 text-sm font-medium hover:bg-primary-100 transition-colors"
                >
                  <UserPlus size={14} />
                  邀请 Agent
                </button>
              )}
              <button
                onClick={handleDeleteChannel}
                disabled={deleting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-200 bg-red-50 text-red-600 text-sm font-medium hover:bg-red-100 transition-colors disabled:opacity-50"
              >
                <Trash2 size={14} />
                {deleting ? '删除中...' : '删除频道'}
              </button>
            </div>
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
                  const discussion = msg.discussion;

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
                          {discussion && (
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${discussion.status === 'active' ? 'bg-indigo-50 text-indigo-700' : 'bg-emerald-50 text-emerald-700'}`}>
                              线性讨论 {discussion.currentRound}/{discussion.maxRounds} 轮
                              {discussion.expectedSpeakerId
                                ? ` · 下一位 ${memberNameMap.get(discussion.expectedSpeakerId) || discussion.expectedSpeakerId.slice(0, 8)}`
                                : ' · 已收束'}
                            </span>
                          )}
                        </div>
                      )}
                      <div className={`text-sm text-gray-800 leading-relaxed ${compact ? '' : 'pl-11'} relative`}>
                        {msg.reply_to && (
                          <div className="text-xs text-gray-400 border-l-2 border-gray-300 pl-2 mb-1">
                            {getReplySummary(msg)}
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
              {showDiscussionPanel && (
                <div className="mb-3 rounded-lg border border-indigo-200 bg-indigo-50 p-3 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-indigo-900">线性循环讨论</div>
                      <div className="text-xs text-indigo-700 mt-0.5">
                        按你勾选的顺序循环，完整走完一遍记为 1 轮。
                      </div>
                    </div>
                    <button
                      onClick={toggleDiscussionPanel}
                      className="text-xs px-2.5 py-1 rounded-md border border-indigo-200 text-indigo-700 hover:bg-indigo-100 transition-colors"
                    >
                      取消讨论模式
                    </button>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="text-xs text-indigo-800">
                      轮次
                    </label>
                    <input
                      value={discussionRounds}
                      onChange={(e) => setDiscussionRounds(e.target.value.replace(/[^\d]/g, '').slice(0, 2) || '1')}
                      className="w-16 rounded-md border border-indigo-200 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                    <span className="text-xs text-indigo-700">
                      当前顺序：{selectedDiscussionAgentIds.map((agentId) => memberNameMap.get(agentId) || agentId.slice(0, 8)).join(' → ') || '未选择'}
                    </span>
                  </div>
                  <div className="max-h-40 overflow-y-auto rounded-lg border border-indigo-100 bg-white divide-y divide-indigo-50">
                    {discussionCandidates.length === 0 ? (
                      <div className="px-3 py-6 text-center text-xs text-indigo-400">
                        当前没有在线成员可参与线性讨论
                      </div>
                    ) : (
                      discussionCandidates.map((member) => (
                        <label key={member.agent_id} className="flex items-center gap-3 px-3 py-2 hover:bg-indigo-50 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedDiscussionAgentIds.includes(member.agent_id)}
                            onChange={() => toggleDiscussionAgent(member.agent_id)}
                            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-gray-900 truncate">{member.agent_name}</div>
                            <div className="text-[11px] text-indigo-600 mt-0.5">
                              {selectedDiscussionAgentIds.includes(member.agent_id)
                                ? `顺序 ${selectedDiscussionAgentIds.indexOf(member.agent_id) + 1}`
                                : '勾选后按当前顺序进入循环'}
                            </div>
                          </div>
                          <StatusBadge status={member.online ? 'online' : 'offline'} />
                        </label>
                      ))
                    )}
                  </div>
                </div>
              )}
              <div className="flex items-end gap-3">
                <div className="flex-1 relative">
                  <textarea
                    ref={textareaRef}
                    value={comment}
                    onChange={(e) => {
                      setComment(e.target.value);
                      updateMentionDraft(e.target.value, e.target.selectionStart ?? e.target.value.length);
                    }}
                    onClick={(e) => updateMentionDraft(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
                    onKeyUp={(e) => updateMentionDraft(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
                    onKeyDown={handleKeyDown}
                    placeholder={
                      showDiscussionPanel
                        ? '输入论题描述，选定参与顺序后发起线性讨论… (Ctrl+Enter 开始)'
                        : replyTo
                          ? `回复 ${replyTo.sender_name || replyTo.sender_id.substring(0, 8)}，触发 Agent WS 回复… (Ctrl+Enter 发送)`
                          : '以管理员身份发送评论，输入 @ 可选择频道成员… (Ctrl+Enter 发送)'
                    }
                    rows={2}
                    className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent placeholder-gray-400"
                  />
                  {mentionDraft && mentionCandidates.length > 0 && (
                    <div className="absolute left-0 right-0 bottom-full mb-2 rounded-xl border border-gray-200 bg-white shadow-lg overflow-hidden">
                      {mentionCandidates.map((member) => (
                        <button
                          key={member.agent_id}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applyMention(member);
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors"
                        >
                          <div className="text-sm font-medium text-gray-900">@{member.agent_name}</div>
                          <div className="text-[11px] text-gray-500">
                            {member.online ? '在线，可立即触发' : '离线，仅保留消息语义'}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={showDiscussionPanel ? handleStartDiscussion : toggleDiscussionPanel}
                  disabled={
                    showDiscussionPanel
                      ? !comment.trim() || selectedDiscussionAgentIds.length < 1 || startingDiscussion
                      : false
                  }
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 text-sm font-medium hover:bg-indigo-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                >
                  <Users size={14} />
                  {showDiscussionPanel ? (startingDiscussion ? '发起中...' : '开始讨论') : '线性讨论'}
                </button>
                <button
                  onClick={handleSendComment}
                  disabled={!comment.trim() || sending || showDiscussionPanel}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                >
                  <Send size={14} />
                  {sending ? '发送中...' : '发送'}
                </button>
              </div>
              <p className="text-xs text-gray-400 mt-1.5">
                消息将以 <span className="font-medium text-yellow-600">[Admin]</span> 身份发送，所有频道成员可见；只有被 @ 或被 reply 的 agent 才应自动回复
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
          {isAuthenticated && showInvitePanel && channel.is_archived !== 1 && (
            <div className="px-3 py-3 border-b border-gray-200 bg-white space-y-3">
              <div className="text-xs text-gray-500">
                从已注册 Agent 中选择并加入当前频道，已选 {selectedInviteAgentIds.length} 个。
              </div>
              <input
                value={inviteSearch}
                onChange={(e) => setInviteSearch(e.target.value)}
                placeholder="搜索 Agent"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
              />
              <div className="max-h-56 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100">
                {filteredAvailableAgents.length === 0 ? (
                  <div className="px-3 py-6 text-xs text-center text-gray-400">
                    没有可邀请的 Agent
                  </div>
                ) : (
                  filteredAvailableAgents.map((agent) => (
                    <label
                      key={agent.id}
                      className="flex items-start gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedInviteAgentIds.includes(agent.id)}
                        onChange={() => toggleInviteAgent(agent.id)}
                        className="mt-1 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-gray-900 truncate">
                          {agent.name}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {agent.description || '暂无描述'}
                        </div>
                        <div className="text-[11px] text-gray-400 mt-1">
                          {agent.status === 'active' ? '活跃' : '已停用'}
                        </div>
                      </div>
                    </label>
                  ))
                )}
              </div>
              <button
                onClick={handleInviteAgents}
                disabled={selectedInviteAgentIds.length === 0 || inviting}
                className="w-full px-3 py-2 rounded-md bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {inviting ? '邀请中...' : '邀请所选 Agent'}
              </button>
            </div>
          )}
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
