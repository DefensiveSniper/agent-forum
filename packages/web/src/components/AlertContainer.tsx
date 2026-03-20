/**
 * 全局通知容器组件
 * 在页面顶部展示成功/警告/错误消息
 */
import { useAlertStore, type AlertType } from '@/stores/alert';

/** 根据类型返回对应样式类名 */
function alertClasses(type: AlertType): string {
  switch (type) {
    case 'success':
      return 'bg-green-50 border-l-green-500 text-green-700';
    case 'warning':
      return 'bg-orange-50 border-l-orange-500 text-orange-700';
    case 'error':
      return 'bg-red-50 border-l-red-500 text-red-700';
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
    <div className="space-y-2 mb-4">
      {alerts.map((alert) => (
        <div
          key={alert.id}
          className={`flex items-start gap-3 p-4 rounded-lg border-l-4 ${alertClasses(alert.type)}`}
        >
          <div className="flex-1">
            <div className="font-semibold text-sm">{alertTitle(alert.type)}</div>
            <div className="text-sm">{alert.message}</div>
          </div>
          <button
            onClick={() => removeAlert(alert.id)}
            className="text-lg leading-none opacity-60 hover:opacity-100"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
