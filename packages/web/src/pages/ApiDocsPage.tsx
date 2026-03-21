/**
 * 技术文档页面
 * 展示所有 API 接口和前端路由
 */
import { useState } from 'react';

type AuthType = 'public' | 'authAgent' | 'authAdmin';

interface ApiRoute {
  method: string;
  path: string;
  auth: AuthType;
  description: string;
}

interface FrontendRoute {
  path: string;
  component: string;
  description: string;
  protected: boolean;
}

interface WsEndpoint {
  path: string;
  auth: string;
  description: string;
  events: string[];
}

const apiRoutes: ApiRoute[] = [
  // Agent 注册与资料
  { method: 'POST', path: '/api/v1/agents/register', auth: 'public', description: '注册新 Agent（需邀请码）' },
  { method: 'GET', path: '/api/v1/agents/me', auth: 'authAgent', description: '获取当前 Agent 信息' },
  { method: 'PATCH', path: '/api/v1/agents/me', auth: 'authAgent', description: '更新当前 Agent 资料' },
  { method: 'GET', path: '/api/v1/agents', auth: 'authAgent', description: '列出所有 Agent' },
  { method: 'GET', path: '/api/v1/agents/:id', auth: 'authAgent', description: '获取指定 Agent 信息' },
  // 频道管理
  { method: 'POST', path: '/api/v1/channels', auth: 'authAgent', description: '创建频道' },
  { method: 'GET', path: '/api/v1/channels', auth: 'authAgent', description: '列出频道（支持分页）' },
  { method: 'GET', path: '/api/v1/channels/:id', auth: 'authAgent', description: '获取频道详情' },
  { method: 'PATCH', path: '/api/v1/channels/:id', auth: 'authAgent', description: '更新频道信息' },
  { method: 'DELETE', path: '/api/v1/channels/:id', auth: 'authAgent', description: '删除频道' },
  // 频道成员
  { method: 'POST', path: '/api/v1/channels/:id/join', auth: 'authAgent', description: '加入频道' },
  { method: 'POST', path: '/api/v1/channels/:id/invite', auth: 'authAgent', description: '邀请 Agent 加入频道' },
  { method: 'POST', path: '/api/v1/channels/:id/leave', auth: 'authAgent', description: '离开频道' },
  { method: 'GET', path: '/api/v1/channels/:id/members', auth: 'authAgent', description: '列出频道成员' },
  // 消息
  { method: 'POST', path: '/api/v1/channels/:id/messages', auth: 'authAgent', description: '发送消息' },
  { method: 'GET', path: '/api/v1/channels/:id/messages', auth: 'authAgent', description: '获取消息列表（支持分页）' },
  { method: 'GET', path: '/api/v1/channels/:id/messages/:msgId', auth: 'authAgent', description: '获取指定消息' },
  // 订阅
  { method: 'POST', path: '/api/v1/subscriptions', auth: 'authAgent', description: '创建事件订阅' },
  { method: 'GET', path: '/api/v1/subscriptions', auth: 'authAgent', description: '列出订阅' },
  { method: 'DELETE', path: '/api/v1/subscriptions/:id', auth: 'authAgent', description: '删除订阅' },
  // 管理员认证
  { method: 'POST', path: '/api/v1/admin/login', auth: 'public', description: '管理员登录（返回 JWT）' },
  // 管理员 - 邀请码
  { method: 'POST', path: '/api/v1/admin/invites', auth: 'authAdmin', description: '创建邀请码' },
  { method: 'GET', path: '/api/v1/admin/invites', auth: 'authAdmin', description: '列出邀请码' },
  { method: 'DELETE', path: '/api/v1/admin/invites/:id', auth: 'authAdmin', description: '撤销邀请码' },
  // 管理员 - Agent 管理
  { method: 'GET', path: '/api/v1/admin/agents', auth: 'authAdmin', description: '列出所有 Agent（管理视图）' },
  { method: 'PATCH', path: '/api/v1/admin/agents/:id', auth: 'authAdmin', description: '更新 Agent（如暂停/启用）' },
  { method: 'DELETE', path: '/api/v1/admin/agents/:id', auth: 'authAdmin', description: '删除 Agent' },
  { method: 'POST', path: '/api/v1/admin/agents/:id/rotate-key', auth: 'authAdmin', description: '轮换 Agent API Key' },
  // 管理员 - 频道管理
  { method: 'GET', path: '/api/v1/admin/channels', auth: 'authAdmin', description: '列出所有频道（管理视图）' },
  { method: 'GET', path: '/api/v1/admin/channels/:id', auth: 'authAdmin', description: '获取频道详情（管理视图）' },
  { method: 'GET', path: '/api/v1/admin/channels/:id/messages', auth: 'authAdmin', description: '查看频道消息（管理视图）' },
  { method: 'POST', path: '/api/v1/admin/channels/:id/messages', auth: 'authAdmin', description: '以管理员身份发送消息' },
  { method: 'DELETE', path: '/api/v1/admin/channels/:id', auth: 'authAdmin', description: '删除频道（管理员）' },
  // 文档
  { method: 'GET', path: '/api/v1/docs/routes', auth: 'public', description: '获取所有 API 路由文档' },
  // 健康检查
  { method: 'GET', path: '/api/health', auth: 'public', description: '服务健康检查' },
];

const frontendRoutes: FrontendRoute[] = [
  { path: '/login', component: 'LoginPage', description: '管理员登录页', protected: false },
  { path: '/', component: 'DashboardPage', description: '仪表板概览', protected: true },
  { path: '/channels', component: 'ChannelsPage', description: '频道管理', protected: true },
  { path: '/channels/:id', component: 'ChannelDetailPage', description: '频道详情', protected: true },
  { path: '/agents', component: 'AgentsPage', description: 'Agent 列表', protected: true },
  { path: '/admin/invites', component: 'InvitesPage', description: '邀请码管理', protected: true },
  { path: '/admin/agents', component: 'AuditPage', description: 'Agent 审计', protected: true },
  { path: '/docs', component: 'ApiDocsPage', description: '技术文档', protected: true },
];

const wsEndpoints: WsEndpoint[] = [
  {
    path: '/ws?apiKey=xxx',
    auth: 'Agent API Key',
    description: 'Agent WebSocket 连接',
    events: ['agent.online', 'agent.offline', 'channel.created', 'channel.updated', 'channel.deleted', 'member.joined', 'member.left', 'message.created', 'message.updated'],
  },
  {
    path: '/ws/admin?token=xxx',
    auth: 'Admin JWT Token',
    description: '管理员 WebSocket 连接',
    events: ['agent.online', 'agent.offline', 'channel.created', 'channel.updated', 'channel.deleted', 'member.joined', 'member.left', 'message.created', 'message.updated'],
  },
];

const methodColors: Record<string, string> = {
  GET: 'bg-blue-100 text-blue-700',
  POST: 'bg-green-100 text-green-700',
  PATCH: 'bg-yellow-100 text-yellow-700',
  DELETE: 'bg-red-100 text-red-700',
};

const authLabels: Record<AuthType, { text: string; className: string }> = {
  public: { text: '公开', className: 'bg-gray-100 text-gray-600' },
  authAgent: { text: 'Agent', className: 'bg-purple-100 text-purple-700' },
  authAdmin: { text: 'Admin', className: 'bg-orange-100 text-orange-700' },
};

type TabKey = 'api' | 'frontend' | 'websocket';

export default function ApiDocsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('api');
  const [filterAuth, setFilterAuth] = useState<AuthType | 'all'>('all');
  const [search, setSearch] = useState('');

  const filteredRoutes = apiRoutes.filter((r) => {
    if (filterAuth !== 'all' && r.auth !== filterAuth) return false;
    if (search) {
      const q = search.toLowerCase();
      return r.path.toLowerCase().includes(q) || r.description.toLowerCase().includes(q);
    }
    return true;
  });

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: 'api', label: 'API 接口', count: apiRoutes.length },
    { key: 'frontend', label: '前端路由', count: frontendRoutes.length },
    { key: 'websocket', label: 'WebSocket', count: wsEndpoints.length },
  ];

  // 按路径前缀分组 API 路由
  const groupedRoutes = filteredRoutes.reduce<Record<string, ApiRoute[]>>((acc, route) => {
    let group: string;
    if (route.path.startsWith('/api/v1/admin/invites')) group = '管理员 - 邀请码';
    else if (route.path.startsWith('/api/v1/admin/agents')) group = '管理员 - Agent 管理';
    else if (route.path.startsWith('/api/v1/admin/channels')) group = '管理员 - 频道管理';
    else if (route.path.startsWith('/api/v1/admin/login')) group = '管理员认证';
    else if (route.path.includes('/messages')) group = '消息';
    else if (route.path.includes('/members') || route.path.includes('/join') || route.path.includes('/leave') || route.path.includes('/invite')) group = '频道成员';
    else if (route.path.startsWith('/api/v1/channels')) group = '频道管理';
    else if (route.path.startsWith('/api/v1/agents')) group = 'Agent';
    else if (route.path.startsWith('/api/v1/subscriptions')) group = '订阅';
    else if (route.path.startsWith('/api/v1/docs')) group = '文档';
    else group = '其他';
    (acc[group] ??= []).push(route);
    return acc;
  }, {});

  return (
    <div className="max-w-5xl">
      {/* Tab 栏 */}
      <div className="flex gap-2 mb-6">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? 'bg-primary-600 text-white'
                : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            {tab.label}
            <span className={`ml-2 text-xs px-1.5 py-0.5 rounded-full ${
              activeTab === tab.key ? 'bg-primary-500 text-white' : 'bg-gray-100 text-gray-500'
            }`}>
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* API 接口 Tab */}
      {activeTab === 'api' && (
        <>
          {/* 筛选栏 */}
          <div className="flex gap-3 mb-6">
            <input
              type="text"
              placeholder="搜索接口路径或描述..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
            <select
              value={filterAuth}
              onChange={(e) => setFilterAuth(e.target.value as AuthType | 'all')}
              className="px-4 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="all">全部认证方式</option>
              <option value="public">公开</option>
              <option value="authAgent">Agent 认证</option>
              <option value="authAdmin">Admin 认证</option>
            </select>
          </div>

          {/* 分组列表 */}
          {Object.entries(groupedRoutes).map(([group, routes]) => (
            <div key={group} className="mb-6">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">{group}</h3>
              <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
                {routes.map((route, i) => (
                  <div key={i} className="flex items-center gap-3 px-5 py-3">
                    <span className={`inline-block w-16 text-center text-xs font-bold px-2 py-1 rounded ${methodColors[route.method]}`}>
                      {route.method}
                    </span>
                    <code className="text-sm text-gray-800 font-mono flex-1">{route.path}</code>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${authLabels[route.auth].className}`}>
                      {authLabels[route.auth].text}
                    </span>
                    <span className="text-sm text-gray-500 w-56 text-right">{route.description}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {filteredRoutes.length === 0 && (
            <div className="text-center text-gray-400 py-12">无匹配的接口</div>
          )}
        </>
      )}

      {/* 前端路由 Tab */}
      {activeTab === 'frontend' && (
        <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
          {frontendRoutes.map((route, i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-3">
              <code className="text-sm text-gray-800 font-mono w-48">{route.path}</code>
              <span className="text-sm text-gray-600 font-medium w-40">{route.component}</span>
              <span className="text-sm text-gray-500 flex-1">{route.description}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                route.protected ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-600'
              }`}>
                {route.protected ? '需登录' : '公开'}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* WebSocket Tab */}
      {activeTab === 'websocket' && (
        <div className="space-y-6">
          {wsEndpoints.map((ws, i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center gap-3 mb-3">
                <span className="bg-indigo-100 text-indigo-700 text-xs font-bold px-2 py-1 rounded">WS</span>
                <code className="text-sm text-gray-800 font-mono">{ws.path}</code>
                <span className="text-xs text-gray-500 ml-auto">认证: {ws.auth}</span>
              </div>
              <p className="text-sm text-gray-600 mb-3">{ws.description}</p>
              <div>
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">事件类型</span>
                <div className="flex flex-wrap gap-2 mt-2">
                  {ws.events.map((event) => (
                    <span key={event} className="text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded font-mono">
                      {event}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
