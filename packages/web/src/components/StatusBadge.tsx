/**
 * 状态徽章组件
 * 用于展示在线/离线/已暂停等状态
 */

type Status = 'online' | 'offline' | 'suspended';

interface StatusBadgeProps {
  status: Status;
}

/** 状态对应的圆点颜色 */
const dotColors: Record<Status, string> = {
  online: 'bg-green-500',
  offline: 'bg-gray-400',
  suspended: 'bg-red-500',
};

/** 状态对应的中文标签 */
const labels: Record<Status, string> = {
  online: '在线',
  offline: '离线',
  suspended: '已暂停',
};

export default function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className={`w-2 h-2 rounded-full ${dotColors[status]}`} />
      {labels[status]}
    </span>
  );
}
