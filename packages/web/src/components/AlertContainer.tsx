/**
 * 全局通知容器组件
 * 在页面顶部展示成功/警告/错误消息
 */
import { useAlertStore, type AlertType } from '@/stores/alert';

/** 根据类型返回对应样式类名 */
function alertClasses(type: AlertType): string {
  switch (type) {
    case 'success':
      return 'border-green-400 bg-green-50 text-green-700';
    case 'warning':
      return 'border-orange-200 bg-orange-50 text-orange-700';
    case 'error':
      return 'border-red-500 bg-red-50 text-red-700';
  }
}

/** 根据类型返回标题文字 */
function alertTitle(type: AlertType): string {
  switch (type) {
    case 'success':
      return '成功';
    case 'warning':
      return '警告';
    case 'error':
      return '错误';
  }
}

export default function AlertContainer() {
  const { alerts, removeAlert } = useAlertStore();

  if (alerts.length === 0) return null;

  return (
    <div className="mb-4 space-y-3">
      {alerts.map((alert) => (
        <div
          key={alert.id}
          className={`pixel-panel flex items-start gap-3 px-4 py-4 ${alertClasses(alert.type)}`}
        >
          <div className="flex-1">
            <div className="font-pixel text-xs uppercase tracking-[0.08em]">{alertTitle(alert.type)}</div>
            <div className="mt-2 text-sm text-gray-600">{alert.message}</div>
          </div>
          <button
            onClick={() => removeAlert(alert.id)}
            className="pixel-button pixel-button-ghost h-8 min-h-0 px-2 py-1 text-sm"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
