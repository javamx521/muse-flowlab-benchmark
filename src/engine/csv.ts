/**
 * CSV 解析与序列化（RFC 4180 风格）:
 * - 支持引号包裹、引号内逗号/换行、双引号转义；
 * - 支持 \r\n / \n；
 * - 空字段解析为 ''（空字符串）, 与 null 严格区分（F03）。
 *
 * 公式注入防护（F05）: 导出时, 以 = + - @ 或制表符/回车开头的字符串单元格
 * 默认加单引号前缀转义；纯负数（如 "-42"）属于正常数值文本, 不加前缀。
 */
import type { CellValue, DataTable } from './types';

export interface CsvParseResult {
  headers: string[];
  rows: Record<string, string>[];
  warnings: string[];
}

export function parseCsv(text: string): CsvParseResult {
  const warnings: string[] = [];
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += c;
        i += 1;
      }
    } else if (c === '"') {
      // 只有字段开头（field 为空且刚换行/文件头）的引号才进入引用模式；
      // 中间出现的引号按普通字符处理，避免整行解析错位。
      if (field === '') {
        inQuotes = true;
      } else {
        field += c;
      }
      i += 1;
    } else if (c === ',') {
      pushField();
      i += 1;
    } else if (c === '\r') {
      pushRow();
      i += text[i + 1] === '\n' ? 2 : 1;
    } else if (c === '\n') {
      pushRow();
      i += 1;
    } else {
      field += c;
      i += 1;
    }
  }
  pushRow();
  // 去掉末尾因换行产生的空行
  for (;;) {
    const last = rows[rows.length - 1];
    if (last !== undefined && last.length === 1 && last[0] === '') rows.pop();
    else break;
  }
  if (rows.length === 0) return { headers: [], rows: [], warnings: ['CSV 为空'] };
  const headers: string[] = rows[0] ?? [];
  const seen = new Set<string>();
  headers.forEach((h, idx) => {
    if (seen.has(h)) warnings.push(`第 ${idx + 1} 列列名重复: 「${h}」`);
    seen.add(h);
    if (h === '') warnings.push(`第 ${ idx + 1 } 列列名为空`);
  });
  const data: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const line: string[] = rows[r] ?? [];
    if (line.length !== headers.length) {
      warnings.push(`第 ${r + 1} 行列数(${line.length})与表头(${headers.length})不一致, 已按缺失补空/多余截断`);
    }
    const obj: Record<string, string> = {};
    headers.forEach((h, c) => {
      obj[h] = line[c] ?? '';
    });
    data.push(obj);
  }
  return { headers, rows: data, warnings };
}

/**
 * CSV 导入时的类型推断（列级）:
 * - 全空列 -> 保持 string（空字符串）；
 * - 非空值全部可解析为数字 -> number；
 * - 全部为 true/false（大小写不敏感） -> boolean；
 * - 否则 string。空字符串保持 ''，不转为 null。
 */
export function inferColumnType(values: string[]): 'number' | 'boolean' | 'string' {
  const nonEmpty = values.filter((v) => v !== '');
  if (nonEmpty.length === 0) return 'string';
  if (nonEmpty.every((v) => /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(v.trim()))) return 'number';
  if (nonEmpty.every((v) => /^(true|false)$/i.test(v.trim()))) return 'boolean';
  return 'string';
}

export function convertCell(raw: string, type: 'number' | 'boolean' | 'string'): CellValue {
  if (raw === '') return ''; // 空字符串保持, 与 null 区分
  if (type === 'number') {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : raw;
  }
  if (type === 'boolean') return /^true$/i.test(raw.trim());
  return raw;
}

export function csvToTable(text: string): { table: DataTable; warnings: string[] } {
  const { headers, rows, warnings } = parseCsv(text);
  const types = headers.map((h) => inferColumnType(rows.map((r) => r[h] ?? '')));
  const tableRows = rows.map((r) => {
    const row: Record<string, CellValue> = {};
    headers.forEach((h, idx) => {
      row[h] = convertCell(r[h] ?? '', types[idx] ?? 'string');
    });
    return row;
  });
  return { table: { columns: headers, rows: tableRows }, warnings };
}

const DANGEROUS_PREFIX = /^[=+\-@\t\r]/;

/**
 * 公式注入防护: 危险前缀的字符串加单引号转义。
 * 纯负数数值文本（如 "-42"、"-3.5"）视为正常数值, 不转义。
 */
export function escapeFormulaCell(v: CellValue): string {
  if (v === null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (!DANGEROUS_PREFIX.test(v)) return v;
  if (/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(v.trim())) return v; // 正常负数
  return `'${v}`;
}

function quoteField(s: string): string {
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function tableToCsv(table: DataTable): string {
  const lines: string[] = [];
  lines.push(table.columns.map(quoteField).join(','));
  for (const row of table.rows) {
    lines.push(table.columns.map((c) => quoteField(escapeFormulaCell(row[c] ?? null))).join(','));
  }
  return lines.join('\r\n');
}
