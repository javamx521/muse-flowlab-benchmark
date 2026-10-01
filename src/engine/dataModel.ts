/**
 * 数据语义（任务书 F03）:
 * - 空字符串 '' 与 null 严格区分；
 * - 数字与数字字符串严格区分（'42' !== 42）；
 * - 默认关联键采用严格同类型比较；null 键不互相匹配；
 * - 数值必须是有限数, 超出安全整数范围的整数拒绝写入；
 * - 金额示例用整数"分"计算, 不在显示层四舍五入掩盖误差。
 */
import type { CellValue, Row } from './types';

export function isNull(v: CellValue): boolean {
  return v === null;
}

export function isNumber(v: CellValue): v is number {
  return typeof v === 'number';
}

export function isString(v: CellValue): v is string {
  return typeof v === 'string';
}

export function isBoolean(v: CellValue): v is boolean {
  return typeof v === 'boolean';
}

/** 断言数值合法: 有限数。NaN / ±Infinity 拒绝。 */
export function assertFiniteNumber(v: number, what: string): void {
  if (!Number.isFinite(v)) {
    throw new Error(`${what}: 数值必须为有限数, 得到 ${String(v)}`);
  }
}

/**
 * 超出安全整数范围的整数: 明确拒绝（任务书 F03: 不得悄悄舍入）。
 * 返回 true 表示可安全表示。
 */
export function isSafeIntegerValue(v: number): boolean {
  return Number.isSafeInteger(v);
}

/** 严格同类型相等（关联键比较用）: 类型不同即不等；NaN 不存在于数据中。 */
export function strictEquals(a: CellValue, b: CellValue): boolean {
  if (a === null || b === null) return false; // 空键不互相匹配
  if (typeof a !== typeof b) return false;
  return a === b;
}

/** 严格比较键的哈希（用于关联/去重/分组）。 */
export function keyHash(values: CellValue[]): string {
  return values
    .map((v) => {
      if (v === null) return 'null:∅';
      if (typeof v === 'number') return `num:${String(v)}`;
      if (typeof v === 'string') return `str:${v.length}:${v}`;
      return `bool:${v ? 1 : 0}`;
    })
    .join('|');
}

/**
 * 单元格排序比较: null 最小；同类型内比较；跨类型按固定类型序
 * (null < boolean < number < string), 保证确定性。
 */
export function compareCells(a: CellValue, b: CellValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (ta === 'number') return (a as number) - (b as number);
  if (ta === 'string') return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
  // boolean
  return a === b ? 0 : a ? 1 : -1;
}

/** 严格数字解析: 只有纯数字字符串可转, 其余返回 null（不抛错, 由调用方决定）。 */
export function toNumberStrict(v: CellValue): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '') return null;
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 浅拷贝一行。 */
export function cloneRow(row: Row): Row {
  return { ...row };
}

/** 校验整行所有数值合法, 非法时抛错（节点执行边界用）。 */
export function assertRowValid(row: Row, nodeName: string): void {
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) {
        throw new Error(`节点「${nodeName}」: 字段 ${k} 产生非有限数值, 已拒绝写入`);
      }
      if (Number.isInteger(v) && !Number.isSafeInteger(v)) {
        throw new Error(`节点「${nodeName}」: 字段 ${k} 的整数超出安全范围, 已拒绝写入（不得悄悄舍入）`);
      }
    }
  }
}
