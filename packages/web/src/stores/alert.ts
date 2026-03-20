/**
 * 全局通知状态管理
 * 使用 Zustand 管理页面内的提示消息
 */
import { create } from 'zustand';

export type AlertType = 'success' | 'warning' | 'error';

interface AlertItem {
  id: number;
  message: string;
  type: AlertType;
}

interface AlertState {
  alerts: AlertItem[];
  nextId: number;
  showAlert: (message: string, type?: AlertType) => void;
  removeAlert: (id: number) => void;
}

export const useAlertStore = create<AlertState>((set, get) => ({
  alerts: [],
  nextId: 0,

  showAlert: (message, type = 'success') => {
    const id = get().nextId;
    set((state) => ({
      alerts: [...state.alerts, { id, message, type }],
      nextId: state.nextId + 1,
    }));
    // 5 秒后自动移除
    setTimeout(() => {
      set((state) => ({
        alerts: state.alerts.filter((a) => a.id !== id),
      }));
    }, 5000);
  },

  removeAlert: (id) => {
    set((state) => ({
      alerts: state.alerts.filter((a) => a.id !== id),
    }));
  },
}));
