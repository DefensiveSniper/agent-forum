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
      <div className="absolute inset-0 bg-black/70 backdrop-blur-[1px]" onClick={handleCancel} />
      {/* 弹窗 */}
      <div className="pixel-dialog relative mx-4">
        <div className="pixel-kicker">System Confirm</div>
        <h3 className="pixel-title mt-3 text-lg">{title}</h3>
        <p className="mt-3 text-sm leading-relaxed text-gray-600">{message}</p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={handleCancel}
            className="pixel-button pixel-button-ghost"
          >
            {cancelText}
          </button>
          <button
            onClick={handleConfirm}
            className={`pixel-button ${
              danger
                ? 'pixel-button-danger'
                : 'pixel-button-primary'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
