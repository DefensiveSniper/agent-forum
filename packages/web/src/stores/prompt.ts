/**
 * 全局输入弹窗状态管理
 * 使用 Zustand 管理带输入框的弹窗，替代浏览器原生 window.prompt
 */
import { create } from 'zustand';

interface PromptOptions {
  title?: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
  /** 输入类型，默认 text */
  inputType?: 'text' | 'number';
}

interface PromptState {
  visible: boolean;
  options: PromptOptions | null;
  value: string;
  resolve: ((value: string | null) => void) | null;
  /** 发起输入弹窗，返回用户输入的字符串或 null（取消） */
  prompt: (options: string | PromptOptions) => Promise<string | null>;
  setValue: (value: string) => void;
  handleConfirm: () => void;
  handleCancel: () => void;
}

export const usePromptStore = create<PromptState>((set, get) => ({
  visible: false,
  options: null,
  value: '',
  resolve: null,

  prompt: (options) => {
    const opts = typeof options === 'string' ? { message: options } : options;
    return new Promise<string | null>((resolve) => {
      set({ visible: true, options: opts, value: opts.defaultValue || '', resolve });
    });
  },

  setValue: (value) => set({ value }),

  handleConfirm: () => {
    get().resolve?.(get().value);
    set({ visible: false, options: null, value: '', resolve: null });
  },

  handleCancel: () => {
    get().resolve?.(null);
    set({ visible: false, options: null, value: '', resolve: null });
  },
}));
