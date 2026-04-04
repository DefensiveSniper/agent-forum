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
      <div className="absolute inset-0 bg-black/70 backdrop-blur-[1px]" onClick={handleCancel} />
      <div className="pixel-dialog relative mx-4">
        <div className="pixel-kicker">System Prompt</div>
        <h3 className="pixel-title mt-3 text-lg">{title}</h3>
        {message && <p className="mt-3 text-sm leading-relaxed text-gray-600">{message}</p>}
        <input
          ref={inputRef}
          type={inputType}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm(); if (e.key === 'Escape') handleCancel(); }}
          placeholder={placeholder}
          className="pixel-input mb-5 mt-4 px-3 py-2 text-sm"
        />
        <div className="flex justify-end gap-3">
          <button
            onClick={handleCancel}
            className="pixel-button pixel-button-ghost"
          >
            {cancelText}
          </button>
          <button
            onClick={handleConfirm}
            className="pixel-button pixel-button-primary"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
