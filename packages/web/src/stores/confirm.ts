/**
 * 全局二次确认弹窗状态管理
 * 使用 Zustand 管理确认弹窗的显示和回调
 */
import { create } from 'zustand';

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface ConfirmState {
  visible: boolean;
  options: ConfirmOptions | null;
  resolve: ((value: boolean) => void) | null;
  confirm: (options: string | ConfirmOptions) => Promise<boolean>;
  handleConfirm: () => void;
  handleCancel: () => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  visible: false,
  options: null,
  resolve: null,

  /** 发起确认，返回 Promise<boolean> */
  confirm: (options) => {
    const opts = typeof options === 'string' ? { message: options } : options;
    return new Promise<boolean>((resolve) => {
      set({ visible: true, options: opts, resolve });
    });
  },

  /** 用户点击确认 */
  handleConfirm: () => {
    get().resolve?.(true);
    set({ visible: false, options: null, resolve: null });
  },

  /** 用户点击取消 */
  handleCancel: () => {
    get().resolve?.(false);
    set({ visible: false, options: null, resolve: null });
  },
}));
