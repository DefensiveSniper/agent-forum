/**
 * 监控趋势图组件。
 * 使用轻量 SVG 折线图展示最近一段时间的指标变化。
 */
interface MonitoringTrendSeries {
  key: string;
  label: string;
  color: string;
}

interface MonitoringTrendPoint {
  label: string;
  [key: string]: string | number;
}

interface MonitoringTrendChartProps {
  title: string;
  subtitle: string;
  points: MonitoringTrendPoint[];
  series: MonitoringTrendSeries[];
  valueFormatter?: (value: number) => string;
  emptyMessage?: string;
}

/**
 * 将数值数组转换为 SVG 折线点串。
 * @param values - 当前序列的采样值
 * @param maxValue - 当前图表的最大值
 * @param width - 视图宽度
 * @param height - 视图高度
 */
function buildPolylinePoints(values: number[], maxValue: number, width: number, height: number) {
  if (values.length === 0) return '';

  return values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
    const normalized = maxValue > 0 ? value / maxValue : 0;
    const y = height - normalized * height;
    return `${x},${y}`;
  }).join(' ');
}

/**
 * 返回数组中间位置的标签，便于图表底部展示时间刻度。
 * @param points - 图表采样点
 */
function getMiddleLabel(points: MonitoringTrendPoint[]) {
  if (points.length === 0) return '--';
  return points[Math.floor(points.length / 2)].label;
}

/**
 * 监控趋势图组件本体。
 * @param props - 图表标题、序列与采样点
 */
export default function MonitoringTrendChart({
  title,
  subtitle,
  points,
  series,
  valueFormatter = (value) => value.toString(),
  emptyMessage = '暂无监控数据',
}: MonitoringTrendChartProps) {
  const width = 100;
  const height = 44;
  const maxValue = Math.max(
    1,
    ...series.flatMap((item) => points.map((point) => Number(point[item.key] || 0)))
  );

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          {series.map((item) => {
            const latestValue = points.length > 0 ? Number(points[points.length - 1][item.key] || 0) : 0;

            return (
              <div
                key={item.key}
                className="min-w-[112px] rounded-xl bg-slate-50 px-3 py-2"
              >
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                  {item.label}
                </div>
                <div className="mt-1 text-lg font-semibold text-slate-900">
                  {valueFormatter(latestValue)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {points.length === 0 ? (
        <div className="mt-5 flex h-44 items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-400">
          {emptyMessage}
        </div>
      ) : (
        <div className="mt-5">
          <div className="rounded-2xl border border-slate-100 bg-[linear-gradient(180deg,#f8fafc_0%,#ffffff_100%)] p-4">
            <svg viewBox={`0 0 ${width} ${height}`} className="h-44 w-full overflow-visible">
              {[0, 0.25, 0.5, 0.75, 1].map((offset) => {
                const y = height - offset * height;

                return (
                  <line
                    key={offset}
                    x1="0"
                    y1={y}
                    x2={width}
                    y2={y}
                    stroke="#e2e8f0"
                    strokeDasharray="2 2"
                    strokeWidth="0.6"
                  />
                );
              })}

              {series.map((item) => {
                const values = points.map((point) => Number(point[item.key] || 0));
                const polylinePoints = buildPolylinePoints(values, maxValue, width, height);
                const lastValue = values[values.length - 1] || 0;
                const lastX = values.length === 1 ? width / 2 : width;
                const lastY = height - ((maxValue > 0 ? lastValue / maxValue : 0) * height);

                return (
                  <g key={item.key}>
                    <polyline
                      fill="none"
                      points={polylinePoints}
                      stroke={item.color}
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <circle cx={lastX} cy={lastY} r="1.9" fill={item.color} />
                  </g>
                );
              })}
            </svg>
          </div>

          <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
            <span>{points[0]?.label || '--'}</span>
            <span>{getMiddleLabel(points)}</span>
            <span>{points[points.length - 1]?.label || '--'}</span>
          </div>
        </div>
      )}
    </section>
  );
}
