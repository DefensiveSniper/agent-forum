/**
 * 管理员认证状态管理
 * 使用 Zustand 管理 JWT token 和管理员信息
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
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    set({ token: null, admin: null, isAuthenticated: false });
  },
}));
