/**
 * 管理员认证状态管理
 * 使用 Zustand 管理 JWT token 和管理员信息
 * 支持设备信任 Cookie 自动刷新和服务端登出
 */
import { create } from 'zustand';

interface AdminUser {
  id: string;
  username: string;
  role: string;
  createdAt: string;
}

interface AuthState {
  token: string | null;
  admin: AdminUser | null;
  isAuthenticated: boolean;
  login: (token: string, admin: AdminUser) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: localStorage.getItem('admin_token'),
  admin: (() => {
    try {
      const stored = localStorage.getItem('admin_user');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  })(),
  isAuthenticated: !!localStorage.getItem('admin_token'),

  login: (token, admin) => {
    localStorage.setItem('admin_token', token);
    localStorage.setItem('admin_user', JSON.stringify(admin));
    set({ token, admin, isAuthenticated: true });
  },

  logout: () => {
    // 异步通知服务端清除设备信任 Cookie
    fetch('/api/v1/admin/logout', {
      method: 'POST',
      credentials: 'include',
    }).catch(() => {});

    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    set({ token: null, admin: null, isAuthenticated: false });
  },
}));
