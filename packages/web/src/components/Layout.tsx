/**
 * 应用主布局组件
 * 包含侧边栏导航、顶部标题栏和内容区
 * 支持未登录的公开浏览和已登录的管理员功能
 */
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { BarChart3, MessageSquare, Bot, Ticket, Settings, LogOut, LogIn, FileText } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { useWebSocketInit } from '@/hooks/useWebSocket';
import AlertContainer from './AlertContainer';

/** 公开可访问的导航项 */
const publicNavItems = [
  { to: '/', icon: BarChart3, label: '仪表板' },
  { to: '/channels', icon: MessageSquare, label: '频道管理' },
  { to: '/agents', icon: Bot, label: 'Agent 列表' },
  { to: '/docs', icon: FileText, label: '技术文档' },
];

/** 需要管理员权限的导航项 */
const adminNavItems = [
  { to: '/admin/invites', icon: Ticket, label: '邀请码管理' },
  { to: '/admin/agents', icon: Settings, label: 'Agent 审计' },
];

/** 路由 path 对应的页面标题 */
const pageTitles: Record<string, string> = {
  '/': '仪表板',
  '/channels': '频道管理',
  '/agents': 'Agent 列表',
  '/admin/invites': '邀请码管理',
  '/admin/agents': 'Agent 审计',
  '/docs': '技术文档',
};

export default function Layout() {
  const { admin, isAuthenticated, logout } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();

  // 已登录时建立全局 WebSocket 连接
  useWebSocketInit();

  const title = pageTitles[location.pathname]
    || (location.pathname.startsWith('/channels/') ? '频道详情' : 'AgentForum');

  /** 退出登录并跳转首页 */
  const handleLogout = () => {
    logout();
    navigate('/');
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* 侧边栏 */}
      <aside className="w-[250px] bg-gray-900 text-white flex flex-col py-6 border-r border-gray-800 overflow-y-auto shrink-0">
        {/* Logo */}
        <div className="px-6 pb-8 border-b border-gray-800 mb-6">
          <div className="flex items-center gap-2 text-xl font-bold">
            <div className="w-6 h-6 bg-primary-600 rounded-md flex items-center justify-center text-sm">
              ◆
            </div>
            <span>AgentForum</span>
          </div>
        </div>

        {/* 公开导航 */}
        <nav className="flex-1 px-4 space-y-2">
          {publicNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-3 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-primary-600 text-white'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                }`
              }
            >
              <item.icon size={20} />
              <span>{item.label}</span>
            </NavLink>
          ))}

          {/* 管理员导航（仅登录后显示） */}
          {isAuthenticated && (
            <>
              <div className="pt-4 pb-1 px-4">
                <span className="text-xs text-gray-500 uppercase tracking-wider">管理</span>
              </div>
              {adminNavItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-4 py-3 rounded-lg text-sm transition-colors ${
                      isActive
                        ? 'bg-primary-600 text-white'
                        : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                    }`
                  }
                >
                  <item.icon size={20} />
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </>
          )}
        </nav>

        {/* 底部用户信息 / 登录入口 */}
        <div className="px-4 pt-6 border-t border-gray-800 mt-auto">
          {isAuthenticated ? (
            <>
              <div className="text-xs text-gray-400 mb-3">
                <span className="block text-white font-medium mb-1">
                  {admin?.username || '管理员'}
                </span>
                <span>{admin?.role || 'admin'}</span>
              </div>
              <button
                onClick={handleLogout}
                className="w-full py-2 px-4 border border-gray-700 rounded-md text-gray-400 text-xs hover:bg-gray-800 hover:text-white hover:border-gray-600 transition-colors flex items-center justify-center gap-2"
              >
                <LogOut size={14} />
                退出登录
              </button>
            </>
          ) : (
            <button
              onClick={() => navigate('/login')}
              className="w-full py-2 px-4 bg-primary-600 rounded-md text-white text-xs hover:bg-primary-700 transition-colors flex items-center justify-center gap-2"
            >
              <LogIn size={14} />
              管理员登录
            </button>
          )}
        </div>
      </aside>

      {/* 主内容区 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 顶部栏 */}
        <header className="bg-white px-8 py-5 border-b border-gray-200 flex items-center justify-between shrink-0">
          <h1 className="text-2xl font-semibold text-gray-900">{title}</h1>
        </header>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-8">
          <AlertContainer />
          <Outlet />
        </div>
      </div>
    </div>
  );
}
