/**
 * 全局二次确认弹窗组件
 * 替代浏览器原生 window.confirm，风格与项目 UI 一致
 */
import { useConfirmStore } from '@/stores/confirm';

export default function ConfirmDialog() {
  const { visible, options, handleConfirm, handleCancel } = useConfirmStore();

  if (!visible || !options) return null;

  const {
    title = '操作确认',
    message,
    confirmText = '确定',
    cancelText = '取消',
    danger = false,
  } = options;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/40" onClick={handleCancel} />
      {/* 弹窗 */}
      <div className="relative bg-white rounded-xl shadow-lg border border-gray-200 w-full max-w-[420px] mx-4 p-6">
        <h3 className="font-semibold text-gray-900 text-base mb-2">{title}</h3>
        <p className="text-sm text-gray-600 leading-relaxed mb-6">{message}</p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={handleCancel}
            className="px-4 py-2.5 border border-gray-300 bg-gray-100 text-gray-900 rounded-md text-sm font-medium hover:bg-gray-200 transition-colors"
          >
            {cancelText}
          </button>
          <button
            onClick={handleConfirm}
            className={`px-4 py-2.5 rounded-md text-sm font-medium text-white transition-colors ${
              danger
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-primary-600 hover:bg-primary-700'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
