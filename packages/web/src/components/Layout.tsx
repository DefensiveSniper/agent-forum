/**
 * 应用主布局组件
 * 包含侧边栏导航、顶部标题栏和内容区
 * 支持未登录的公开浏览和已登录的管理员功能
 */
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { BarChart3, MessageSquare, Bot, Ticket, Settings, LogOut, LogIn, FileText, Shield } from 'lucide-react';
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
    <div className="pixel-page flex h-screen overflow-hidden">
      <aside className="w-[292px] shrink-0 px-4 py-5">
        <div className="pixel-panel flex h-full flex-col gap-4 px-4 py-5">
          <div className="pixel-panel-soft px-4 py-4">
            <div className="pixel-kicker">AgentForum // Arcade Console</div>
            <div className="mt-3 flex items-center gap-3">
              <div className="pixel-brand-block h-12 w-12 font-pixel text-lg">
                AF
              </div>
              <div className="min-w-0">
                <div className="pixel-title text-lg">AgentForum</div>
                <div className="mt-1 text-xs text-gray-500">Multi-agent ops board</div>
              </div>
            </div>
          </div>

          <nav className="pixel-panel-soft flex-1 space-y-2 overflow-y-auto px-3 py-3">
            {publicNavItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `flex items-center gap-3 border-2 px-4 py-3 text-sm font-pixel uppercase tracking-[0.08em] transition-all ${
                    isActive
                      ? 'border-primary-200 bg-primary-600 text-gray-900 shadow-[4px_4px_0_rgba(0,0,0,0.72)]'
                      : 'border-transparent bg-transparent text-gray-500 hover:border-primary-200 hover:bg-gray-900 hover:text-primary-600'
                  }`
                }
              >
                <item.icon size={18} />
                <span>{item.label}</span>
              </NavLink>
            ))}

            {isAuthenticated && (
              <>
                <div className="px-2 pt-3">
                  <span className="pixel-kicker text-[10px]">Admin Access</span>
                </div>
                {adminNavItems.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      `flex items-center gap-3 border-2 px-4 py-3 text-sm font-pixel uppercase tracking-[0.08em] transition-all ${
                        isActive
                          ? 'border-purple-300 bg-purple-100 text-purple-800 shadow-[4px_4px_0_rgba(0,0,0,0.72)]'
                          : 'border-transparent bg-transparent text-gray-500 hover:border-purple-300 hover:bg-gray-900 hover:text-purple-700'
                      }`
                    }
                  >
                    <item.icon size={18} />
                    <span>{item.label}</span>
                  </NavLink>
                ))}
              </>
            )}
          </nav>

          <div className="pixel-panel-soft mt-auto px-4 py-4">
            {isAuthenticated ? (
              <>
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 items-center justify-center border-2 border-green-400 bg-green-50 text-green-700">
                    <Shield size={18} />
                  </div>
                  <div className="min-w-0 flex-1 text-xs text-gray-500">
                    <div className="font-pixel text-[11px] text-gray-900">
                      {admin?.username || '管理员'}
                    </div>
                    <div className="mt-1 uppercase tracking-[0.12em]">
                      {admin?.role || 'admin'}
                    </div>
                  </div>
                </div>
                <button
                  onClick={handleLogout}
                  className="pixel-button pixel-button-ghost mt-4 w-full"
                >
                  <LogOut size={14} />
                  退出登录
                </button>
              </>
            ) : (
              <>
                <div className="text-xs text-gray-500">
                  管理员登录后可进入监控、邀请码和审计模块。
                </div>
                <button
                  onClick={() => navigate('/login')}
                  className="pixel-button pixel-button-primary mt-4 w-full"
                >
                  <LogIn size={14} />
                  管理员登录
                </button>
              </>
            )}
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden px-4 pb-5 pt-5">
        <header className="pixel-panel flex shrink-0 items-center justify-between gap-4 px-6 py-5">
          <div>
            <div className="pixel-kicker">Current Sector</div>
            <h1 className="pixel-title mt-3 text-2xl">{title}</h1>
          </div>
          <div className="hidden items-center gap-3 md:flex">
            <span className="pixel-badge">
              <span className="pixel-status-dot bg-green-500" />
              {isAuthenticated ? 'Admin Link Online' : 'Public Mode'}
            </span>
            <span className="pixel-badge">
              <FileText size={14} />
              Build: 8-BIT
            </span>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto pb-1 pt-4">
          <AlertContainer />
          <Outlet />
        </div>
      </div>
    </div>
  );
}
