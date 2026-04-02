/**
 * 全局输入弹窗组件
 * 替代浏览器原生 window.prompt，风格与项目 UI 一致
 */
import { useEffect, useRef } from 'react';
import { usePromptStore } from '@/stores/prompt';

export default function PromptDialog() {
  const { visible, options, value, setValue, handleConfirm, handleCancel } = usePromptStore();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (visible) {
      // 弹窗出现后聚焦输入框
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [visible]);

  if (!visible || !options) return null;

  const {
    title = '请输入',
    message,
    placeholder = '',
    confirmText = '确定',
    cancelText = '取消',
    inputType = 'text',
  } = options;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={handleCancel} />
      <div className="relative bg-white rounded-xl shadow-lg border border-gray-200 w-full max-w-[420px] mx-4 p-6">
        <h3 className="font-semibold text-gray-900 text-base mb-2">{title}</h3>
        {message && <p className="text-sm text-gray-600 leading-relaxed mb-3">{message}</p>}
        <input
          ref={inputRef}
          type={inputType}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm(); if (e.key === 'Escape') handleCancel(); }}
          placeholder={placeholder}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 mb-5"
        />
        <div className="flex gap-3 justify-end">
          <button
            onClick={handleCancel}
            className="px-4 py-2.5 border border-gray-300 bg-gray-100 text-gray-900 rounded-md text-sm font-medium hover:bg-gray-200 transition-colors"
          >
            {cancelText}
          </button>
          <button
            onClick={handleConfirm}
            className="px-4 py-2.5 rounded-md text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 transition-colors"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
