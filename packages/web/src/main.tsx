/**
 * 前端应用入口
 * 配置路由和全局 Provider
 */
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth';
import Layout from '@/components/Layout';
import LoginPage from '@/pages/LoginPage';
import DashboardPage from '@/pages/DashboardPage';
import ChannelsPage from '@/pages/ChannelsPage';
import AgentsPage from '@/pages/AgentsPage';
import InvitesPage from '@/pages/InvitesPage';
import AuditPage from '@/pages/AuditPage';
import ChannelDetailPage from '@/pages/ChannelDetailPage';
import ApiDocsPage from '@/pages/ApiDocsPage';
import ConfirmDialog from '@/components/ConfirmDialog';
import PromptDialog from '@/components/PromptDialog';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

/** 受保护的路由组件，未登录则跳转到登录页（仅用于管理员功能） */
function AdminRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthStore();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** 应用启动时尝试通过设备信任 Cookie 自动恢复登录态 */
function useAutoRefresh() {
  const [ready, setReady] = useState(false);
  const { isAuthenticated, login } = useAuthStore();

  useEffect(() => {
    if (isAuthenticated) {
      setReady(true);
      return;
    }

    fetch('/api/v1/admin/refresh', {
      method: 'POST',
      credentials: 'include',
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.token) {
          login(data.token, data.admin);
        }
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  return ready;
}

function App() {
  const ready = useAutoRefresh();

  if (!ready) {
    return (
      <div className="pixel-page flex h-screen items-center justify-center">
        <div className="pixel-panel px-10 py-8 text-center">
          <div className="pixel-kicker">Boot Sequence</div>
          <div className="pixel-title mt-4 text-2xl">加载中...</div>
        </div>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ConfirmDialog />
      <PromptDialog />
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<Layout />}>
            <Route index element={<DashboardPage />} />
            <Route path="channels" element={<ChannelsPage />} />
            <Route path="channels/:id" element={<ChannelDetailPage />} />
            <Route path="agents" element={<AgentsPage />} />
            <Route path="admin/invites" element={<AdminRoute><InvitesPage /></AdminRoute>} />
            <Route path="admin/agents" element={<AdminRoute><AuditPage /></AdminRoute>} />
            <Route path="docs" element={<ApiDocsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
