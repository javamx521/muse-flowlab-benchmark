/**
 * 数据表预览（M4 虚拟化）。
 * 十万行不全部创建 DOM：固定行高 + 滚动窗口渲染（overscan 上下各 8 行），
 * 上下用占位行撑出总高度。thead 吸顶。
 * null 显示为 NULL 徽标，空字符串显示为 ∅，类型不只靠颜色区分（F09）。
 */
import { useEffect, useRef, useState } from 'react';
import type { CellValue, DataTable } from '../engine/types';

const ROW_H = 28;
const OVERSCAN = 8;

function cellText(v: CellValue): string {
  if (v === null) return 'NULL';
  if (v === '') return '∅';
  return String(v);
}

function cellClass(v: CellValue): string {
  if (v === null) return 'cell-null';
  if (v === '') return 'cell-empty';
  if (typeof v === 'number') return 'cell-num';
  if (typeof v === 'boolean') return 'cell-bool';
  return 'cell-str';
}

export default function DataTableView({ table, title }: { table: DataTable | null; title?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(420);

  // 表格变化时回到顶部
  useEffect(() => {
    setScrollTop(0);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [table]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewH(el.clientHeight || 420);
    const ro = new ResizeObserver(() => setViewH(el.clientHeight || 420));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!table) {
    return (
      <div className="datatable-empty" data-testid="datatable-empty">
        <p className="muted">暂无数据。运行工作流后，此处显示选中节点的输出。</p>
      </div>
    );
  }

  const total = table.rows.length;
  const cols = table.columns;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visibleCount = Math.ceil(viewH / ROW_H) + OVERSCAN * 2;
  const end = Math.min(total, start + visibleCount);
  const topPad = start * ROW_H;
  const bottomPad = (total - end) * ROW_H;

  return (
    <div className="datatable-wrap" data-testid="datatable">
      <div className="datatable-meta">
        {title && <strong>{title}</strong>}
        <span className="muted" data-testid="datatable-count">
          {total} 行 × {cols.length} 列（虚拟化渲染当前 {end - start} 行）
        </span>
      </div>
      <div
        className="datatable-scroll virtualized"
        ref={scrollRef}
        data-testid="datatable-scroll"
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        <table>
          <thead>
            <tr>
              <th className="rownum">#</th>
              {cols.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {topPad > 0 && (
              <tr className="vspacer" aria-hidden="true">
                <td colSpan={cols.length + 1} style={{ height: topPad, padding: 0, border: 0 }} />
              </tr>
            )}
            {Array.from({ length: end - start }, (_, k) => {
              const i = start + k;
              const row = table.rows[i];
              if (!row) return null;
              return (
                <tr key={i} style={{ height: ROW_H }} data-testid={`datarow-${i}`}>
                  <td className="rownum">{i + 1}</td>
                  {cols.map((c) => {
                    const v: CellValue = row[c] ?? null;
                    return (
                      <td key={c} className={cellClass(v)} title={typeof v === 'string' ? v : undefined}>
                        {cellText(v)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {bottomPad > 0 && (
              <tr className="vspacer" aria-hidden="true">
                <td colSpan={cols.length + 1} style={{ height: bottomPad, padding: 0, border: 0 }} />
              </tr>
            )}
          </tbody>
        </table>
        {total === 0 && <p className="muted" style={{ padding: 12 }}>空表（0 行）。</p>}
      </div>
    </div>
  );
}
