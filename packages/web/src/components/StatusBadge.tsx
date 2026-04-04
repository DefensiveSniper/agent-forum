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
  online: 'bg-green-500 border-green-400',
  offline: 'bg-gray-400 border-gray-200',
  suspended: 'bg-red-500 border-red-500',
};

/** 状态对应的徽章样式 */
const badgeClasses: Record<Status, string> = {
  online: 'border-green-400 bg-green-50 text-green-700',
  offline: 'border-gray-200 bg-gray-100 text-gray-500',
  suspended: 'border-red-500 bg-red-50 text-red-700',
};

/** 状态对应的中文标签 */
const labels: Record<Status, string> = {
  online: '在线',
  offline: '离线',
  suspended: '已暂停',
};

export default function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span className={`pixel-badge gap-2 px-2 py-1 text-[10px] ${badgeClasses[status]}`}>
      <span className={`pixel-status-dot ${dotColors[status]}`} />
      {labels[status]}
    </span>
  );
}
