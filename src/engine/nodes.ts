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
import { assertRowValid, compareCells, keyHash } from './dataModel';

export type { CellValue };

export interface ParamField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'select' | 'boolean' | 'expression';
  required?: boolean;
  defaultValue?: unknown;
  options?: { value: string; label: string }[];
  help?: string;
  placeholder?: string;
  min?: number;
  max?: number;
}

export interface NodeDef {
  kind: NodeKind;
  title: string;
  description: string;
  category: '输入' | '变换' | '输出';
  /** 输入端口名。单输入节点为 ['in']；join/union 为 ['in', 'in2']。 */
  inputs: string[];
  /** 输出端口名。单输出节点为 ['out']；branch 为 ['true', 'false']。 */
  outputs: string[];
  hasOutput: boolean;
  params: ParamField[];
  implVersion: number;
  defaultParams(): Record<string, unknown>;
  defaultName(seq: number): string;
  /**
   * 执行节点。单输出节点返回 DataTable；多输出节点（如 branch）
   * 返回 port -> DataTable 的映射。
   */
  execute(params: Record<string, unknown>, inputs: Record<string, DataTable>): DataTable | Record<string, DataTable>;
}

/** 判断执行结果是否为单表（而非多端口映射）。 */
export function isSingleTable(result: DataTable | Record<string, DataTable>): result is DataTable {
  return (
    typeof result === 'object' &&
    result !== null &&
    Array.isArray((result as DataTable).columns) &&
    Array.isArray((result as DataTable).rows)
  );
}

/** 把执行结果归一化为 port -> DataTable（单表归入首个输出端口）。 */
export function normalizeOutputs(def: NodeDef, result: DataTable | Record<string, DataTable>): Record<string, DataTable> {
  if (isSingleTable(result)) {
    return { [def.outputs[0] ?? 'out']: result };
  }
  const out: Record<string, DataTable> = {};
  for (const p of def.outputs) {
    const t = (result as Record<string, DataTable>)[p];
    if (t) out[p] = t;
  }
  return out;
}

/** 节点的主输出端口名（单输出节点为 'out'；branch 为 'true'）。 */
export function primaryOutputPort(def: NodeDef): string {
  return def.outputs[0] ?? 'out';
}

function getStr(params: Record<string, unknown>, key: string, what: string): string {
  const v = params[key];
  if (typeof v !== 'string' || v.trim() === '') throw new ExprError(`${what}: 参数 ${key} 不能为空`);
  return v;
}

function getNum(params: Record<string, unknown>, key: string, what: string): number {
  const v = params[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ExprError(`${what}: 参数 ${key} 必须为数字`);
  return v;
}

/** 解析逗号分隔的字段名列表（去空、去重、保序）。 */
export function parseNameList(raw: unknown, what: string): string[] {
  if (raw === undefined || raw === null || raw === '') return [];
  if (typeof raw !== 'string') throw new ExprError(`${what}: 字段列表必须为文本`);
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (t !== '' && !out.includes(t)) out.push(t);
  }
  return out;
}

/** 确保输入表包含指定字段，否则抛错（字段存在性校验）。 */
function requireColumns(table: DataTable, cols: string[], what: string, which: string): void {
  for (const c of cols) {
    if (!table.columns.includes(c)) throw new ExprError(`${what}: ${which}不存在字段 ${c}`);
  }
}

function getInput(inputs: Record<string, DataTable>, port: string, what: string): DataTable {
  const t = inputs[port] ?? emptyTable();
  void what;
  return t;
}

const csvInputDef: NodeDef = {
  kind: 'csv-input',
  outputs: ['out'],
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
  outputs: ['out'],
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
  outputs: ['out'],
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
  outputs: ['out'],
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

/* ---------------- M2 新增的 12 种节点 ---------------- */

/** JSON 值转单元格：只允许 string/number/boolean/null。 */
function jsonToCell(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return v; // 有限性/安全整数由 assertRowValid 拒绝
  throw new ExprError(`JSON 输入: 不支持的单元格类型 ${Array.isArray(v) ? 'array' : typeof v}（只允许 string/number/boolean/null）`);
}

const jsonInputDef: NodeDef = {
  kind: 'json-input',
  outputs: ['out'],
  title: 'JSON 输入',
  description: '解析 JSON 数组（或单个对象），每项对象转为一行，键的并集为列。结构非法时报错。',
  category: '输入',
  inputs: [],
  hasOutput: true,
  implVersion: 1,
  params: [
    {
      key: 'jsonText',
      label: 'JSON 文本',
      type: 'textarea',
      required: true,
      defaultValue: '[{"name":"张三","age":28},{"name":"李四","age":35,"city":"上海"}]',
      help: '顶层为数组（每项为对象）或单个对象。缺失的键补 null。',
    },
  ],
  defaultParams: () => ({
    jsonText: '[{"name":"张三","age":28,"city":"北京"},{"name":"李四","age":35,"city":"上海"}]',
  }),
  defaultName: (seq) => `JSON 输入 ${seq}`,
  execute: (params) => {
    const text = getStr(params, 'jsonText', 'JSON 输入');
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ExprError('JSON 输入: JSON 解析失败，请检查文本格式');
    }
    const arr: unknown[] = Array.isArray(data) ? data : [data];
    const columns: string[] = [];
    for (const item of arr) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new ExprError('JSON 输入: 数组元素必须为普通对象');
      }
      for (const k of Object.keys(item as Record<string, unknown>)) {
        if (!columns.includes(k)) columns.push(k);
      }
    }
    const rows: Row[] = arr.map((item) => {
      const obj = item as Record<string, unknown>;
      const row: Row = {};
      for (const c of columns) row[c] = jsonToCell(obj[c]);
      assertRowValid(row, 'JSON 输入');
      return row;
    });
    return { columns, rows };
  },
};

/** 确定性伪随机数发生器（LCG，种子固定则序列固定）。 */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(1664525, x) + 1013904223) >>> 0;
    return x / 0x100000000;
  };
}

const NAME_POOL = ['张三', '李四', '王五', '赵六', '钱七', '孙八'];
const CITY_POOL = ['北京', '上海', '广州', '深圳', '杭州'];

/** 按列名启发式决定合成列类型（列名含 name/city→字符串；is_/active 等→布尔；id→行号；其余→数值）。 */
function synthColumnKind(name: string): 'id' | 'string' | 'boolean' | 'number' {
  const n = name.toLowerCase();
  if (n === 'id') return 'id';
  if (n.includes('name') || n.includes('city') || n.includes('label') || n.includes('title')) return 'string';
  if (n.startsWith('is_') || n.startsWith('has_') || ['active', 'enabled', 'flag'].includes(n)) return 'boolean';
  return 'number';
}

const syntheticInputDef: NodeDef = {
  kind: 'synthetic-input',
  outputs: ['out'],
  title: '合成数据',
  description: '按行数与随机种子生成确定性测试数据。相同种子结果完全相同，适合做性能基准。',
  category: '输入',
  inputs: [],
  hasOutput: true,
  implVersion: 1,
  params: [
    { key: 'rows', label: '行数', type: 'number', required: true, defaultValue: 100, min: 1, max: 1000000 },
    { key: 'seed', label: '随机种子', type: 'number', required: true, defaultValue: 42, help: '相同种子生成完全相同的数据。' },
    {
      key: 'columns',
      label: '列名（逗号分隔）',
      type: 'text',
      required: true,
      defaultValue: 'id,name,age,city,active',
      help: '列类型由列名推断：id→行号；含 name/city→文本；is_/active→布尔；其余→数值。',
    },
  ],
  defaultParams: () => ({ rows: 100, seed: 42, columns: 'id,name,age,city,active' }),
  defaultName: (seq) => `合成数据 ${seq}`,
  execute: (params) => {
    const n = getNum(params, 'rows', '合成数据');
    const seed = getNum(params, 'seed', '合成数据');
    if (!Number.isInteger(n) || n < 1 || n > 1000000) throw new ExprError('合成数据: 行数必须为 1~1000000 的整数');
    const columns = parseNameList(params['columns'], '合成数据');
    if (columns.length === 0) throw new ExprError('合成数据: 至少需要一列');
    const kinds = columns.map(synthColumnKind);
    const rand = lcg(Math.trunc(seed));
    const rows: Row[] = [];
    for (let i = 0; i < n; i++) {
      const row: Row = {};
      kinds.forEach((k, ci) => {
        const col = columns[ci]!;
        if (k === 'id') row[col] = i + 1;
        else if (k === 'string') {
          const pool = col.toLowerCase().includes('city') ? CITY_POOL : NAME_POOL;
          row[col] = pool[Math.floor(rand() * pool.length)]!;
        } else if (k === 'boolean') row[col] = rand() < 0.5;
        else row[col] = Math.floor(rand() * 1000);
      });
      rows.push(row);
    }
    return { columns, rows };
  },
};

const selectColumnsDef: NodeDef = {
  kind: 'select-columns',
  outputs: ['out'],
  title: '字段选择',
  description: '选择、重排、重命名字段。不存在的字段报错；重命名产生重名时报错。',
  category: '变换',
  inputs: ['in'],
  hasOutput: true,
  implVersion: 1,
  params: [
    {
      key: 'columns',
      label: '保留字段（逗号分隔，空=全部）',
      type: 'text',
      defaultValue: '',
      help: '按填写顺序重排字段。',
    },
    {
      key: 'renames',
      label: '重命名（每行「旧列名:新列名」）',
      type: 'textarea',
      defaultValue: '',
      help: '示例：\nage:年龄\ncity:城市',
    },
  ],
  defaultParams: () => ({ columns: '', renames: '' }),
  defaultName: (seq) => `字段选择 ${seq}`,
  execute: (params, inputs) => {
    const input = getInput(inputs, 'in', '字段选择');
    const picked = parseNameList(params['columns'], '字段选择');
    const cols = picked.length > 0 ? picked : [...input.columns];
    requireColumns(input, cols, '字段选择', '字段 ');
    const renames = new Map<string, string>();
    const rawRenames = params['renames'];
    if (typeof rawRenames === 'string' && rawRenames.trim() !== '') {
      for (const line of rawRenames.split('\n')) {
        const t = line.trim();
        if (t === '') continue;
        const idx = t.indexOf(':');
        if (idx < 0) throw new ExprError(`字段选择: 重命名格式错误「${t}」，应为 旧列名:新列名`);
        const from = t.slice(0, idx).trim();
        const to = t.slice(idx + 1).trim();
        if (from === '' || to === '') throw new ExprError(`字段选择: 重命名格式错误「${t}」`);
        if (!input.columns.includes(from)) throw new ExprError(`字段选择: 不存在的字段 ${from}`);
        renames.set(from, to);
      }
    }
    const outCols = cols.map((c) => renames.get(c) ?? c);
    const seen = new Set<string>();
    for (const c of outCols) {
      if (seen.has(c)) throw new ExprError(`字段选择: 重命名后存在重名字段 ${c}`);
      seen.add(c);
    }
    const rows: Row[] = input.rows.map((row) => {
      const o: Row = {};
      cols.forEach((c, i) => {
        o[outCols[i]!] = row[c] ?? null;
      });
      return o;
    });
    return { columns: outCols, rows };
  },
};

const branchDef: NodeDef = {
  kind: 'branch',
  outputs: ['true', 'false'],
  title: '条件分流',
  description: '按表达式把行分成匹配（true）与不匹配（false）两张表，行不丢失、不重复。',
  category: '变换',
  inputs: ['in'],
  hasOutput: true,
  implVersion: 1,
  params: [
    {
      key: 'condition',
      label: '分流条件',
      type: 'expression',
      required: true,
      defaultValue: '$age >= 18',
      help: '结果为 true 的行进入「匹配」输出，其余进入「不匹配」输出。',
    },
  ],
  defaultParams: () => ({ condition: '$age >= 18' }),
  defaultName: (seq) => `条件分流 ${seq}`,
  execute: (params, inputs) => {
    const input = getInput(inputs, 'in', '条件分流');
    const src = getStr(params, 'condition', '条件分流');
    const expr = compileExpr(src);
    const missing = missingFields(expr, input.columns);
    if (missing.length > 0) throw new ExprError(`条件分流: 引用了不存在的字段: ${missing.map((m) => '$' + m).join(', ')}`);
    const matched: Row[] = [];
    const unmatched: Row[] = [];
    for (const row of input.rows) {
      (expr.evaluate(row) === true ? matched : unmatched).push(row);
    }
    return {
      true: { columns: input.columns, rows: matched },
      false: { columns: input.columns, rows: unmatched },
    };
  },
};

const joinDef: NodeDef = {
  kind: 'join',
  outputs: ['out'],
  title: '表关联',
  description: '左右两表按关联键连接（inner/left）。严格同类型比较；空键不匹配；一对多产生全部匹配行。',
  category: '变换',
  inputs: ['in', 'in2'],
  hasOutput: true,
  implVersion: 1,
  params: [
    {
      key: 'joinType',
      label: '关联类型',
      type: 'select',
      defaultValue: 'inner',
      options: [
        { value: 'inner', label: '内连接（inner）' },
        { value: 'left', label: '左连接（left）' },
      ],
    },
    {
      key: 'keys',
      label: '关联键（逗号分隔）',
      type: 'text',
      required: true,
      defaultValue: 'id',
      help: '左右表需同名。右表键列不输出；右表其余同名列自动加 _right 后缀。',
    },
  ],
  defaultParams: () => ({ joinType: 'inner', keys: 'id' }),
  defaultName: (seq) => `表关联 ${seq}`,
  execute: (params, inputs) => {
    const left = getInput(inputs, 'in', '表关联');
    const right = getInput(inputs, 'in2', '表关联');
    const joinType = params['joinType'] === 'left' ? 'left' : 'inner';
    const keys = parseNameList(params['keys'], '表关联');
    if (keys.length === 0) throw new ExprError('表关联: 关联键不能为空');
    requireColumns(left, keys, '表关联', '左表');
    requireColumns(right, keys, '表关联', '右表');
    // 关联类型冲突：同一键名在左右表的非空值类型完全不相交时拒绝
    for (const k of keys) {
      const lt = new Set<string>();
      const rt = new Set<string>();
      for (const r of left.rows) {
        const v = r[k];
        if (v !== null) lt.add(typeof v);
      }
      for (const r of right.rows) {
        const v = r[k];
        if (v !== null) rt.add(typeof v);
      }
      if (lt.size > 0 && rt.size > 0 && [...lt].every((t) => !rt.has(t))) {
        throw new ExprError(`表关联: 关联键 ${k} 类型冲突（左表 ${[...lt].join('/')}，右表 ${[...rt].join('/')}）`);
      }
    }
    const rNonKey = right.columns.filter((c) => !keys.includes(c));
    const outCols = [...left.columns];
    const rOutName = new Map<string, string>();
    for (const c of rNonKey) {
      const name = outCols.includes(c) ? `${c}_right` : c;
      rOutName.set(c, name);
      outCols.push(name);
    }
    // 右表按复合键建桶（空键不参与匹配）
    const buckets = new Map<string, Row[]>();
    for (const r of right.rows) {
      const vals = keys.map((k) => r[k] ?? null);
      if (vals.some((v) => v === null)) continue;
      const h = keyHash(vals);
      const arr = buckets.get(h);
      if (arr) arr.push(r);
      else buckets.set(h, [r]);
    }
    const combine = (l: Row, r: Row | null): Row => {
      const o: Row = { ...l };
      for (const c of rNonKey) o[rOutName.get(c)!] = r ? (r[c] ?? null) : null;
      return o;
    };
    const rows: Row[] = [];
    for (const l of left.rows) {
      const vals = keys.map((k) => l[k] ?? null);
      const matched = vals.some((v) => v === null) ? [] : (buckets.get(keyHash(vals)) ?? []);
      if (matched.length === 0) {
        if (joinType === 'left') rows.push(combine(l, null));
      } else {
        for (const r of matched) rows.push(combine(l, r));
      }
    }
    return { columns: outCols, rows };
  },
};

const unionDef: NodeDef = {
  kind: 'union',
  outputs: ['out'],
  title: '合并',
  description: 'Union All：纵向拼接两表。列集合必须一致（顺序可不同，按左表列对齐），否则报错。',
  category: '变换',
  inputs: ['in', 'in2'],
  hasOutput: true,
  implVersion: 1,
  params: [],
  defaultParams: () => ({}),
  defaultName: (seq) => `合并 ${seq}`,
  execute: (_params, inputs) => {
    const a = getInput(inputs, 'in', '合并');
    const b = getInput(inputs, 'in2', '合并');
    const sa = new Set(a.columns);
    const sb = new Set(b.columns);
    if (sa.size !== sb.size || [...sa].some((c) => !sb.has(c))) {
      throw new ExprError(
        `合并: 两表结构不兼容（左表列: ${a.columns.join(', ') || '（空）'}；右表列: ${b.columns.join(', ') || '（空）'}）`,
      );
    }
    const pick = (row: Row): Row => {
      const o: Row = {};
      for (const c of a.columns) o[c] = row[c] ?? null;
      return o;
    };
    return { columns: [...a.columns], rows: [...a.rows.map(pick), ...b.rows.map(pick)] };
  },
};

const dedupeDef: NodeDef = {
  kind: 'dedupe',
  outputs: ['out'],
  title: '去重',
  description: '按指定字段去重，稳定保留首次出现的行。字段为空时按整行去重。',
  category: '变换',
  inputs: ['in'],
  hasOutput: true,
  implVersion: 1,
  params: [
    {
      key: 'keys',
      label: '去重字段（逗号分隔，空=整行）',
      type: 'text',
      defaultValue: '',
    },
  ],
  defaultParams: () => ({ keys: '' }),
  defaultName: (seq) => `去重 ${seq}`,
  execute: (params, inputs) => {
    const input = getInput(inputs, 'in', '去重');
    const keys = parseNameList(params['keys'], '去重');
    const cols = keys.length > 0 ? keys : [...input.columns];
    requireColumns(input, cols, '去重', '字段 ');
    const seen = new Set<string>();
    const rows: Row[] = [];
    for (const row of input.rows) {
      const h = keyHash(cols.map((c) => row[c] ?? null));
      if (seen.has(h)) continue;
      seen.add(h);
      rows.push(row);
    }
    return { columns: input.columns, rows };
  },
};

type AggFunc = 'count' | 'sum' | 'avg' | 'min' | 'max';

interface AggSpec {
  outCol: string;
  func: AggFunc;
  field: string;
}

/** 解析聚合项：每行「输出列:函数(字段)」，如 total:sum(amount)；计数支持 count(*)。 */
export function parseAggregations(text: string): AggSpec[] {
  const specs: AggSpec[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    const m = t.match(/^([^:()]+):(count|sum|avg|min|max)\(([^()]*)\)$/);
    if (!m) {
      throw new ExprError(`分组聚合: 聚合项格式错误「${t}」，应为 输出列:函数(字段)，如 total:sum(amount)`);
    }
    const outCol = m[1]!.trim();
    const func = m[2]! as AggFunc;
    const field = m[3]!.trim();
    if (outCol === '') throw new ExprError(`分组聚合: 输出列名不能为空「${t}」`);
    if (func !== 'count' && field === '') throw new ExprError(`分组聚合: ${func} 需要指定字段「${t}」`);
    specs.push({ outCol, func, field });
  }
  if (specs.length === 0) throw new ExprError('分组聚合: 至少需要一项聚合');
  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.outCol)) throw new ExprError(`分组聚合: 输出列名重复 ${s.outCol}`);
    seen.add(s.outCol);
  }
  return specs;
}

function assertFiniteNumberLocal(v: number, what: string): void {
  if (!Number.isFinite(v)) throw new ExprError(`${what}: 聚合产生非有限数值，已拒绝`);
}

const aggregateDef: NodeDef = {
  kind: 'aggregate',
  outputs: ['out'],
  title: '分组聚合',
  description: '按字段分组做 count/sum/avg/min/max 聚合。空分组键视为一组；sum/avg 忽略空值。',
  category: '变换',
  inputs: ['in'],
  hasOutput: true,
  implVersion: 1,
  params: [
    {
      key: 'groupBy',
      label: '分组字段（逗号分隔，空=全局聚合）',
      type: 'text',
      defaultValue: '',
    },
    {
      key: 'aggregations',
      label: '聚合项（每行「输出列:函数(字段)」）',
      type: 'textarea',
      required: true,
      defaultValue: 'n:count(*)',
      help: '示例：\ntotal:sum(amount)\navg_price:avg(price)\nn:count(*)\n函数：count/sum/avg/min/max。',
    },
  ],
  defaultParams: () => ({ groupBy: '', aggregations: 'n:count(*)' }),
  defaultName: (seq) => `分组聚合 ${seq}`,
  execute: (params, inputs) => {
    const input = getInput(inputs, 'in', '分组聚合');
    const groupBy = parseNameList(params['groupBy'], '分组聚合');
    requireColumns(input, groupBy, '分组聚合', '分组字段 ');
    const specs = parseAggregations(getStr(params, 'aggregations', '分组聚合'));
    for (const s of specs) {
      if (s.field !== '*' && !input.columns.includes(s.field)) {
        throw new ExprError(`分组聚合: 不存在的字段 ${s.field}`);
      }
    }
    const outCols = [...groupBy, ...specs.map((s) => s.outCol)];
    const groups = new Map<string, { keyVals: CellValue[]; rows: Row[] }>();
    for (const row of input.rows) {
      const keyVals = groupBy.map((c) => row[c] ?? null);
      const h = keyHash(keyVals);
      const g = groups.get(h);
      if (g) g.rows.push(row);
      else groups.set(h, { keyVals, rows: [row] });
    }
    if (groups.size === 0) groups.set(keyHash([]), { keyVals: [], rows: [] });
    const rows: Row[] = [];
    for (const g of groups.values()) {
      const o: Row = {};
      groupBy.forEach((c, i) => {
        o[c] = g.keyVals[i] ?? null;
      });
      for (const s of specs) {
        let v: CellValue;
        if (s.func === 'count') {
          v = s.field === '*' ? g.rows.length : g.rows.filter((r) => (r[s.field] ?? null) !== null).length;
        } else if (s.func === 'sum' || s.func === 'avg') {
          const nums = g.rows.map((r) => r[s.field] ?? null).filter((x): x is number => typeof x === 'number');
          if (s.func === 'sum') {
            const sum = nums.reduce((a, b) => a + b, 0);
            assertFiniteNumberLocal(sum, '分组聚合');
            v = sum;
          } else {
            v = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
          }
          if (typeof v === 'number') assertRowValid({ [s.outCol]: v }, '分组聚合');
        } else {
          let best: CellValue = null;
          for (const r of g.rows) {
            const x = r[s.field] ?? null;
            if (x === null) continue;
            if (best === null || (s.func === 'min' ? compareCells(x, best) < 0 : compareCells(x, best) > 0)) {
              best = x;
            }
          }
          v = best;
        }
        o[s.outCol] = v;
      }
      rows.push(o);
    }
    return { columns: outCols, rows };
  },
};

interface SortKey {
  field: string;
  dir: 1 | -1;
}

/** 解析排序键：每行「字段名 [asc|desc]」，默认 asc。 */
export function parseSortKeys(text: string): SortKey[] {
  const keys: SortKey[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    const m = t.match(/^(.+?)(?:\s+(asc|desc))?$/i);
    if (!m || !m[1] || m[1].trim() === '') throw new ExprError(`排序: 排序项格式错误「${t}」，应为 字段名 [asc|desc]`);
    keys.push({ field: m[1].trim(), dir: m[2]?.toLowerCase() === 'desc' ? -1 : 1 });
  }
  if (keys.length === 0) throw new ExprError('排序: 至少需要一个排序字段');
  return keys;
}

const sortDef: NodeDef = {
  kind: 'sort',
  outputs: ['out'],
  title: '排序',
  description: '多字段稳定排序。同值保持原有顺序；空值（null）始终排在最后。',
  category: '变换',
  inputs: ['in'],
  hasOutput: true,
  implVersion: 1,
  params: [
    {
      key: 'sortKeys',
      label: '排序字段（每行「字段名 asc|desc」）',
      type: 'textarea',
      required: true,
      defaultValue: 'age desc',
      help: '示例：\nage desc\nname asc',
    },
  ],
  defaultParams: () => ({ sortKeys: '' }),
  defaultName: (seq) => `排序 ${seq}`,
  execute: (params, inputs) => {
    const input = getInput(inputs, 'in', '排序');
    const keys = parseSortKeys(getStr(params, 'sortKeys', '排序'));
    requireColumns(input, keys.map((k) => k.field), '排序', '字段 ');
    const rows = [...input.rows];
    rows.sort((ra, rb) => {
      for (const k of keys) {
        const a = ra[k.field] ?? null;
        const b = rb[k.field] ?? null;
        // 空值始终最后（与方向无关）
        if (a === null && b === null) continue;
        if (a === null) return 1;
        if (b === null) return -1;
        const c = compareCells(a, b);
        if (c !== 0) return c * k.dir;
      }
      return 0;
    });
    return { columns: input.columns, rows };
  },
};

const limitDef: NodeDef = {
  kind: 'limit',
  outputs: ['out'],
  title: '行数限制',
  description: '取前 N 行。N 必须为正整数，否则报错。',
  category: '变换',
  inputs: ['in'],
  hasOutput: true,
  implVersion: 1,
  params: [{ key: 'n', label: '保留行数 N', type: 'number', required: true, defaultValue: 100, min: 1 }],
  defaultParams: () => ({ n: 100 }),
  defaultName: (seq) => `行数限制 ${seq}`,
  execute: (params, inputs) => {
    const input = getInput(inputs, 'in', '行数限制');
    const n = params['n'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      throw new ExprError('行数限制: N 必须为正整数');
    }
    return { columns: input.columns, rows: input.rows.slice(0, n) };
  },
};

const assertDef: NodeDef = {
  kind: 'assert',
  outputs: ['out'],
  title: '数据断言',
  description: '验证每行满足条件；失败时节点报错并给出不满足条件的行号，成功则透传。',
  category: '变换',
  inputs: ['in'],
  hasOutput: true,
  implVersion: 1,
  params: [
    {
      key: 'condition',
      label: '断言条件',
      type: 'expression',
      required: true,
      defaultValue: '$age >= 0',
      help: '每行求值，结果不为 true 即视为失败。',
    },
  ],
  defaultParams: () => ({ condition: '$age >= 0' }),
  defaultName: (seq) => `数据断言 ${seq}`,
  execute: (params, inputs) => {
    const input = getInput(inputs, 'in', '数据断言');
    const src = getStr(params, 'condition', '数据断言');
    const expr = compileExpr(src);
    const missing = missingFields(expr, input.columns);
    if (missing.length > 0) throw new ExprError(`数据断言: 引用了不存在的字段: ${missing.map((m) => '$' + m).join(', ')}`);
    const bad: number[] = [];
    input.rows.forEach((row, i) => {
      if (expr.evaluate(row) !== true) bad.push(i + 1);
    });
    if (bad.length > 0) {
      const preview = bad.slice(0, 10).join('、');
      throw new ExprError(`数据断言失败: ${bad.length} 行不满足条件（第 ${preview} 行${bad.length > 10 ? '…' : ''}）`);
    }
    return input;
  },
};

const chartDef: NodeDef = {
  kind: 'chart',
  outputs: ['out'],
  title: '图表',
  description: '终端节点：把 x/y 列映射为柱状图、折线图或散点图。柱状/折线按 x 分组对 y 求和。',
  category: '输出',
  inputs: ['in'],
  hasOutput: false,
  implVersion: 1,
  params: [
    {
      key: 'chartType',
      label: '图表类型',
      type: 'select',
      defaultValue: 'bar',
      options: [
        { value: 'bar', label: '柱状图' },
        { value: 'line', label: '折线图' },
        { value: 'scatter', label: '散点图' },
      ],
    },
    { key: 'xColumn', label: 'X 轴字段', type: 'text', required: true, defaultValue: '', placeholder: 'city' },
    { key: 'yColumn', label: 'Y 轴字段（数值）', type: 'text', required: true, defaultValue: '', placeholder: 'amount' },
  ],
  defaultParams: () => ({ chartType: 'bar', xColumn: '', yColumn: '' }),
  defaultName: (seq) => `图表 ${seq}`,
  execute: (params, inputs) => {
    const input = getInput(inputs, 'in', '图表');
    const chartType = params['chartType'] === 'line' ? 'line' : params['chartType'] === 'scatter' ? 'scatter' : 'bar';
    const xCol = getStr(params, 'xColumn', '图表');
    const yCol = getStr(params, 'yColumn', '图表');
    requireColumns(input, [xCol, yCol], '图表', '字段 ');
    if (chartType === 'scatter') {
      const rows: Row[] = input.rows.map((r, i) => {
        const x = r[xCol] ?? null;
        const y = r[yCol] ?? null;
        if (typeof x !== 'number' || typeof y !== 'number') {
          throw new ExprError(`图表: 散点图要求 ${xCol}/${yCol} 为数值（第 ${i + 1} 行不满足）`);
        }
        return { x, y };
      });
      return { columns: ['x', 'y'], rows };
    }
    const groups = new Map<string, { x: CellValue; sum: number }>();
    for (const r of input.rows) {
      const x = r[xCol] ?? null;
      const y = r[yCol] ?? null;
      if (typeof y !== 'number') throw new ExprError(`图表: ${yCol} 含非数值，无法按 ${xCol} 聚合`);
      const h = keyHash([x]);
      const g = groups.get(h);
      if (g) {
        g.sum += y;
        if (!Number.isFinite(g.sum)) throw new ExprError('图表: 聚合产生非有限数值，已拒绝');
      } else {
        groups.set(h, { x, sum: y });
      }
    }
    const rows = [...groups.values()]
      .sort((a, b) => compareCells(a.x, b.x))
      .map((g) => ({ x: g.x, y: g.sum }));
    return { columns: ['x', 'y'], rows };
  },
};

const REGISTRY: Record<string, NodeDef> = {
  'csv-input': csvInputDef,
  'json-input': jsonInputDef,
  'synthetic-input': syntheticInputDef,
  filter: filterDef,
  'computed-column': computedColumnDef,
  'select-columns': selectColumnsDef,
  branch: branchDef,
  join: joinDef,
  union: unionDef,
  dedupe: dedupeDef,
  aggregate: aggregateDef,
  sort: sortDef,
  limit: limitDef,
  assert: assertDef,
  chart: chartDef,
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
