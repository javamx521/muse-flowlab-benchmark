/**
 * 增量计算缓存（F08）。
 *
 * 设计要点（任务书 F08）：
 * - 缓存键 = 节点 kind + 节点实现版本(implVersion) + 语义参数规范序列化 + 各输入端口数据内容哈希。
 * - 不得仅依赖节点 ID：同样的节点 ID 在参数/输入变化后键必然变化。
 * - 节点位置（布局）不参与键：单纯移动节点不使缓存失效。
 * - 内容哈希用 FNV-1a（非加密、快速），按表对象 WeakMap 记忆化，每个表对象只计算一次；
 *   缓存命中时复用同一表对象引用，下游哈希可直接命中记忆，无需重新序列化。
 * - 调试模式绕过缓存（保证单步执行的确定性），见 executor。
 */

import type { DataTable } from './types';

/** 单表内容哈希记忆：表对象 -> 哈希。命中缓存时复用同一引用，下游无需重算。 */
const tableHashMemo = new WeakMap<DataTable, string>();

function mixHash(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h;
}

/**
 * 数据表内容哈希（FNV-1a 32bit）。
 * 覆盖列名、每格的值与类型（区分 1/"1"/null/-0/NaN）；行列顺序敏感。
 */
export function hashDataTable(table: DataTable): string {
  const memo = tableHashMemo.get(table);
  if (memo) return memo;
  let h = 0x811c9dc5;
  h = mixHash(h, table.columns.join('\x01'));
  h = mixHash(h, '\x02');
  for (const row of table.rows) {
    for (const c of table.columns) {
      const v = row[c];
      if (v === null || v === undefined) {
        h = mixHash(h, '\x00null');
      } else if (typeof v === 'number') {
        h = mixHash(h, Object.is(v, -0) ? 'num:-0' : Number.isNaN(v) ? 'num:NaN' : `num:${v}`);
      } else if (typeof v === 'boolean') {
        h = mixHash(h, v ? 'bool:1' : 'bool:0');
      } else {
        h = mixHash(h, `str:${v.length}:${v}`);
      }
      h = mixHash(h, '\x03');
    }
  }
  const out = (h >>> 0).toString(16).padStart(8, '0');
  tableHashMemo.set(table, out);
  return out;
}

/** 规范 JSON：递归排序键，保证同样语义参数得到同样字符串。 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  const s = JSON.stringify(value);
  return s === undefined ? 'null' : s;
}

export interface NodeCacheKeyInput {
  kind: string;
  implVersion: number;
  params: Record<string, unknown>;
  /** 输入端口 -> 该端口输入表的内容哈希（无输入时为空对象）。 */
  inputHashes: Record<string, string>;
}

/** 缓存键：flc1|<kind>|v<implVersion>|<规范参数>|<端口=哈希,…>。 */
export function makeNodeCacheKey(input: NodeCacheKeyInput): string {
  const ports = Object.keys(input.inputHashes)
    .sort()
    .map((p) => `${p}=${input.inputHashes[p]}`)
    .join(',');
  return `flc1|${input.kind}|v${input.implVersion}|${stableStringify(input.params)}|${ports}`;
}

export interface CacheEntry {
  key: string;
  nodeId: string;
  kind: string;
  /** 端口 -> 输出表（与执行器返回的同一引用）。 */
  tables: Record<string, DataTable>;
  hits: number;
  createdAt: number;
  lastHitAt: number;
}

export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
  evictions: number;
}

/**
 * 节点级增量缓存（LRU）。
 * 保留策略：最多 maxEntries 条，超限淘汰最久未命中；提供 clear() 手动释放。
 */
export class RunCache {
  private entries = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(private maxEntries = 50) {}

  get(key: string): CacheEntry | undefined {
    const e = this.entries.get(key);
    if (!e) {
      this.misses += 1;
      return undefined;
    }
    // LRU：命中移到末尾
    this.entries.delete(key);
    this.entries.set(key, e);
    e.hits += 1;
    e.lastHitAt = Date.now();
    this.hits += 1;
    return e;
  }

  set(key: string, entry: Omit<CacheEntry, 'key' | 'hits' | 'createdAt' | 'lastHitAt'>): void {
    if (this.entries.has(key)) this.entries.delete(key);
    const now = Date.now();
    this.entries.set(key, { ...entry, key, hits: 0, createdAt: now, lastHitAt: now });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
  }

  clear(): void {
    this.entries.clear();
  }

  stats(): CacheStats {
    return { entries: this.entries.size, hits: this.hits, misses: this.misses, evictions: this.evictions };
  }
}
