/**
 * 空状态占位组件
 * 当列表/表格无数据时展示
 */

interface EmptyStateProps {
  icon: string;
  title: string;
  message: string;
}

export default function EmptyState({ icon, title, message }: EmptyStateProps) {
  return (
    <div className="pixel-empty-state pixel-panel-soft text-gray-500">
      <div>
        <div className="font-pixel text-4xl opacity-90">{icon}</div>
        <div className="pixel-title mt-4 text-lg">{title}</div>
        <div className="mt-3 text-sm text-gray-500">{message}</div>
      </div>
    </div>
  );
}
