/**
 * 图表视图（SVG，无外部依赖）：柱状图 / 折线图 / 散点图。
 * 输入为 chart 节点的输出表（列为 x, y）。
 */
import type { DataTable } from '../engine/types';

interface Props {
  table: DataTable;
  chartType: string;
}

const W = 620;
const H = 300;
const PAD_L = 56;
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 40;

function fmtTick(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2).replace(/\.?0+$/, '');
}

export default function ChartView({ table, chartType }: Props) {
  const rows = table.rows;
  if (rows.length === 0) {
    return <p className="muted">暂无数据。</p>;
  }
  const ys = rows.map((r) => r['y']).filter((v): v is number => typeof v === 'number');
  if (ys.length === 0) {
    return <p className="muted">Y 列无数值数据。</p>;
  }
  const yMin = Math.min(0, ...ys);
  const yMax = Math.max(0, ...ys);
  const ySpan = yMax - yMin || 1;
  const yOf = (v: number) => PAD_T + (1 - (v - yMin) / ySpan) * (H - PAD_T - PAD_B);
  const innerW = W - PAD_L - PAD_R;

  if (chartType === 'scatter') {
    const xs = rows.map((r) => r['x']).filter((v): v is number => typeof v === 'number');
    if (xs.length === 0) return <p className="muted">散点图需要数值型 X 列。</p>;
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const xSpan = xMax - xMin || 1;
    const xOf = (v: number) => PAD_L + ((v - xMin) / xSpan) * innerW;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="散点图" data-testid="chart-svg">
        <line x1={PAD_L} y1={yOf(0)} x2={W - PAD_R} y2={yOf(0)} className="chart-axis" />
        <text x={8} y={yOf(yMax) + 4} className="chart-tick">{fmtTick(yMax)}</text>
        <text x={8} y={yOf(yMin) + 4} className="chart-tick">{fmtTick(yMin)}</text>
        <text x={PAD_L} y={H - 8} className="chart-tick">{fmtTick(xMin)}</text>
        <text x={W - PAD_R} y={H - 8} textAnchor="end" className="chart-tick">{fmtTick(xMax)}</text>
        {rows.map((r, i) => {
          const x = r['x'];
          const y = r['y'];
          if (typeof x !== 'number' || typeof y !== 'number') return null;
          return <circle key={i} cx={xOf(x)} cy={yOf(y)} r={4} className="chart-point"><title>({fmtTick(x)}, {fmtTick(y)})</title></circle>;
        })}
      </svg>
    );
  }

  // 柱状图 / 折线图：x 为类别，按行顺序排列
  const n = rows.length;
  const slot = innerW / n;
  const xOf = (i: number) => PAD_L + slot * i + slot / 2;
  const labels = rows.map((r) => {
    const x = r['x'];
    return x === null ? '（空）' : String(x);
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={chartType === 'line' ? '折线图' : '柱状图'} data-testid="chart-svg">
      <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H - PAD_B} className="chart-axis" />
      <line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} className="chart-axis" />
      <text x={8} y={yOf(yMax) + 4} className="chart-tick">{fmtTick(yMax)}</text>
      <text x={8} y={yOf(0) + 4} className="chart-tick">0</text>
      {chartType === 'bar'
        ? rows.map((r, i) => {
            const y = r['y'];
            if (typeof y !== 'number') return null;
            const bw = Math.min(48, slot * 0.6);
            const x0 = xOf(i) - bw / 2;
            const y0 = yOf(Math.max(0, y));
            const y1 = yOf(Math.min(0, y));
            return (
              <g key={i}>
                <rect x={x0} y={Math.min(y0, y1)} width={bw} height={Math.max(1, Math.abs(y1 - y0))} className="chart-bar">
                  <title>{labels[i]}: {fmtTick(y)}</title>
                </rect>
                {n <= 20 && (
                  <text x={xOf(i)} y={H - PAD_B + 16} textAnchor="middle" className="chart-tick">
                    {labels[i]!.length > 8 ? labels[i]!.slice(0, 8) + '…' : labels[i]}
                  </text>
                )}
              </g>
            );
          })
        : (() => {
            const pts = rows
              .map((r, i) => {
                const y = r['y'];
                return typeof y === 'number' ? `${xOf(i)},${yOf(y)}` : null;
              })
              .filter((p): p is string => p !== null);
            return (
              <g>
                <polyline points={pts.join(' ')} className="chart-line" />
                {rows.map((r, i) => {
                  const y = r['y'];
                  if (typeof y !== 'number') return null;
                  return <circle key={i} cx={xOf(i)} cy={yOf(y)} r={3.5} className="chart-point"><title>{labels[i]}: {fmtTick(y)}</title></circle>;
                })}
                {n <= 20 &&
                  rows.map((r, i) => (
                    <text key={i} x={xOf(i)} y={H - PAD_B + 16} textAnchor="middle" className="chart-tick">
                      {(labels[i]!.length > 8 ? labels[i]!.slice(0, 8) + '…' : labels[i]) ?? ''}
                    </text>
                  ))}
              </g>
            );
          })()}
    </svg>
  );
}
