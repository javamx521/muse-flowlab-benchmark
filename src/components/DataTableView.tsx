/**
 * 数据表预览（M1 简版：前 MAX_PREVIEW_ROWS 行；M4 做完整虚拟化）。
 * null 显示为 NULL 徽标，空字符串显示为 ∅，类型不只靠颜色区分（F09）。
 */
import type { CellValue, DataTable } from '../engine/types';
import { MAX_PREVIEW_ROWS } from '../engine/types';

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
  if (!table) {
    return (
      <div className="datatable-empty" data-testid="datatable-empty">
        <p className="muted">暂无数据。运行工作流后，此处显示选中节点的输出。</p>
      </div>
    );
  }
  const rows = table.rows.slice(0, MAX_PREVIEW_ROWS);
  return (
    <div className="datatable-wrap" data-testid="datatable">
      <div className="datatable-meta">
        {title && <strong>{title}</strong>}
        <span className="muted">
          {table.rows.length} 行 × {table.columns.length} 列
          {table.rows.length > MAX_PREVIEW_ROWS && `（仅预览前 ${MAX_PREVIEW_ROWS} 行）`}
        </span>
      </div>
      <div className="datatable-scroll">
        <table>
          <thead>
            <tr>
              <th className="rownum">#</th>
              {table.columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td className="rownum">{i + 1}</td>
                {table.columns.map((c) => {
                  const v: CellValue = row[c] ?? null;
                  return (
                    <td key={c} className={cellClass(v)} title={typeof v === 'string' ? v : undefined}>
                      {cellText(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {table.rows.length === 0 && <p className="muted" style={{ padding: 12 }}>空表（0 行）。</p>}
      </div>
    </div>
  );
}
