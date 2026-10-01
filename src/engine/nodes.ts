/**
 * 节点定义与实现（M1: csv-input / filter / computed-column / output）。
 *
 * 每个节点: 参数 schema（供检查器渲染与校验）+ 纯执行函数。
 * 执行函数必须是纯函数: (params, inputs) -> DataTable, 便于单元测试与 Worker 复用。
 * implVersion: 节点实现版本, 计入增量缓存键（M4）；实现变更时递增。
 */
import type { CellValue, DataTable, NodeKind, Row } from './types';
import { emptyTable } from './types';
import { csvToTable, tableToCsv } from './csv';
import { compileExpr, missingFields, ExprError } from './expressions';
import { assertRowValid } from './dataModel';

export type { CellValue };

export interface ParamField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'select' | 'boolean' | 'expression';
  required?: boolean;
  defaultValue?: unknown;
  options?: { value: string; label: string }[];
  help?: string;
  min?: number;
  max?: number;
}

export interface NodeDef {
  kind: NodeKind;
  title: string;
  description: string;
  category: '输入' | '变换' | '输出';
  /** 输入端口名。单输入节点为 ['in']。 */
  inputs: string[];
  hasOutput: boolean;
  params: ParamField[];
  implVersion: number;
  defaultParams(): Record<string, unknown>;
  defaultName(seq: number): string;
  execute(params: Record<string, unknown>, inputs: Record<string, DataTable>): DataTable;
}

function getStr(params: Record<string, unknown>, key: string, what: string): string {
  const v = params[key];
  if (typeof v !== 'string' || v.trim() === '') throw new ExprError(`${what}: 参数 ${key} 不能为空`);
  return v;
}

const csvInputDef: NodeDef = {
  kind: 'csv-input',
  title: 'CSV 输入',
  description: '粘贴或输入 CSV 文本，解析为数据表。空字符串与 null 严格区分。',
  category: '输入',
  inputs: [],
  hasOutput: true,
  implVersion: 1,
  params: [
    { key: 'csvText', label: 'CSV 文本', type: 'textarea', required: true, help: '第一行为表头。支持引号包裹的字段。' },
    { key: 'name', label: '表名（备注）', type: 'text', defaultValue: '' },
  ],
  defaultParams: () => ({
    csvText: 'name,age,city\n张三,28,北京\n李四,35,上海\n王五,22,北京',
    name: '',
  }),
  defaultName: (seq) => `CSV 输入 ${seq}`,
  execute: (params) => {
    const text = getStr(params, 'csvText', 'CSV 输入');
    const { table, warnings } = csvToTable(text);
    void warnings;
    if (table.columns.length === 0) throw new Error('CSV 输入: 未解析到任何列');
    return table;
  },
};

const filterDef: NodeDef = {
  kind: 'filter',
  title: '过滤',
  description: '按表达式保留结果为真的行。表达式语言见帮助。',
  category: '变换',
  inputs: ['in'],
  hasOutput: true,
  implVersion: 1,
  params: [
    {
      key: 'condition',
      label: '过滤条件',
      type: 'expression',
      required: true,
      defaultValue: '$age >= 18',
      help: '示例: $age >= 18 && $city == "北京"。字段用 $ 前缀。',
    },
  ],
  defaultParams: () => ({ condition: '$age >= 18' }),
  defaultName: (seq) => `过滤 ${seq}`,
  execute: (params, inputs) => {
    const input = inputs['in'] ?? emptyTable();
    const src = getStr(params, 'condition', '过滤');
    const expr = compileExpr(src);
    const missing = missingFields(expr, input.columns);
    if (missing.length > 0) throw new ExprError(`过滤: 引用了不存在的字段: ${missing.map((m) => '$' + m).join(', ')}`);
    const rows = input.rows.filter((row) => {
      const v = expr.evaluate(row);
      return v === true;
    });
    return { columns: input.columns, rows };
  },
};

const computedColumnDef: NodeDef = {
  kind: 'computed-column',
  title: '计算列',
  description: '用表达式为每行计算一个新列（或覆盖已有列）。',
  category: '变换',
  inputs: ['in'],
  hasOutput: true,
  implVersion: 1,
  params: [
    { key: 'column', label: '目标列名', type: 'text', required: true, defaultValue: 'new_col' },
    {
      key: 'expression',
      label: '表达式',
      type: 'expression',
      required: true,
      defaultValue: '$price * $qty',
      help: '示例: $price * $qty；round($amount / 100, 2)。',
    },
  ],
  defaultParams: () => ({ column: 'total', expression: '$price * $qty' }),
  defaultName: (seq) => `计算列 ${seq}`,
  execute: (params, inputs) => {
    const input = inputs['in'] ?? emptyTable();
    const column = getStr(params, 'column', '计算列');
    const expr = compileExpr(getStr(params, 'expression', '计算列'));
    const missing = missingFields(expr, input.columns);
    if (missing.length > 0) throw new ExprError(`计算列: 引用了不存在的字段: ${missing.map((m) => '$' + m).join(', ')}`);
    const columns = input.columns.includes(column) ? input.columns : [...input.columns, column];
    const rows: Row[] = input.rows.map((row) => {
      const next: Row = { ...row };
      const v = expr.evaluate(row);
      next[column] = v;
      assertRowValid(next, '计算列');
      return next;
    });
    return { columns, rows };
  },
};

const outputDef: NodeDef = {
  kind: 'output',
  title: '输出',
  description: '查看与导出结果：预览数据、复制 CSV、下载 CSV（含公式注入防护）。',
  category: '输出',
  inputs: ['in'],
  hasOutput: false,
  implVersion: 1,
  params: [{ key: 'label', label: '备注', type: 'text', defaultValue: '' }],
  defaultParams: () => ({ label: '' }),
  defaultName: (seq) => `输出 ${seq}`,
  execute: (_params, inputs) => {
    return inputs['in'] ?? emptyTable();
  },
};

const REGISTRY: Record<string, NodeDef> = {
  'csv-input': csvInputDef,
  filter: filterDef,
  'computed-column': computedColumnDef,
  output: outputDef,
};

export function getNodeDef(kind: string): NodeDef {
  const def = REGISTRY[kind];
  if (!def) throw new Error(`未知节点类型: ${kind}`);
  return def;
}

/** M1 可用节点（M2 扩展注册表后此列表自动增长）。 */
export function listNodeDefs(): NodeDef[] {
  return Object.values(REGISTRY);
}

export function isNodeKind(kind: string): kind is NodeKind {
  return kind in REGISTRY;
}

/** 导出 CSV 文本（供输出节点/下载用）。 */
export function exportTableCsv(table: DataTable): string {
  return tableToCsv(table);
}
