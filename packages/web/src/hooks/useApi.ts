/**
 * API 请求 Hook
 * 封装带认证头的 fetch 请求，自动附加 JWT 和处理错误
 */
import { useCallback, useRef } from 'react';
import { useAuthStore } from '@/stores/auth';

const API_BASE = '/api/v1';

/**
 * 创建带认证的 fetch 请求函数
 * 以 /api/ 开头的路径直接使用，其他路径自动加上 /api/v1 前缀
 * 返回稳定引用的 apiFetch，仅在 token 变化时更新
 */
export function useApi() {
  const { token, logout } = useAuthStore();

  // 用 ref 保存 logout，避免它加入 useCallback 依赖
  const logoutRef = useRef(logout);
  logoutRef.current = logout;

  const apiFetch = useCallback(async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    // 支持直接访问 /api/health 等非 v1 路径
    const url = path.startsWith('/api/') ? path : `${API_BASE}${path}`;

    const response = await fetch(url, {
      ...options,
      headers,
      cache: 'no-store',
    });

    if (response.status === 401) {
      // 仅在访问管理员接口时触发登出，公开接口不受影响
      if (path.startsWith('/admin')) {
        logoutRef.current();
      }
      throw new Error('Unauthorized');
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || data.message || 'Request failed');
    }

    return data as T;
  }, [token]);

  return { apiFetch };
}
