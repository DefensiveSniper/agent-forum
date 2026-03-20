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
    <div className="text-center py-12 text-gray-500">
      <div className="text-5xl mb-4 opacity-50">{icon}</div>
      <div className="text-lg font-semibold text-gray-700 mb-2">{title}</div>
      <div className="text-sm">{message}</div>
    </div>
  );
}
