/**
 * M4 增量缓存单元测试（F08）。
 * 全部真实断言：哈希语义、键构成、LRU、执行器集成（命中/失效/调试绕过）。
 */
import { describe, expect, it } from 'vitest';
import { hashDataTable, makeNodeCacheKey, RunCache, stableStringify } from '../../src/engine/cache';
import { LocalBackend, RunManager } from '../../src/engine/executor';
import type { ExecuteRequest, ExecuteResponse } from '../../src/engine/executor';
import { getNodeDef } from '../../src/engine/nodes';
import type { DataTable, WorkflowGraph } from '../../src/engine/types';

function table(rows: Record<string, unknown>[], columns: string[]): DataTable {
  return { columns, rows: rows as DataTable['rows'] };
}

describe('内容哈希', () => {
  it('确定性：同一表多次哈希一致', () => {
    const t = table([{ a: 1, b: 'x' }, { a: 2, b: null }], ['a', 'b']);
    expect(hashDataTable(t)).toBe(hashDataTable(t));
  });
  it('区分值与类型：1 / "1" / null / true 互不相同', () => {
    const h = (v: unknown) => hashDataTable(table([{ a: v }], ['a']));
    const set = new Set([h(1), h('1'), h(null), h(true), h(0), h(-0), h(NaN)]);
    expect(set.size).toBe(7);
  });
  it('行列顺序敏感；列名参与哈希', () => {
    const t1 = table([{ a: 1, b: 2 }], ['a', 'b']);
    const t2 = table([{ b: 2, a: 1 }], ['b', 'a']);
    const t3 = table([{ a: 1, c: 2 }], ['a', 'c']);
    expect(hashDataTable(t1)).not.toBe(hashDataTable(t2));
    expect(hashDataTable(t1)).not.toBe(hashDataTable(t3));
  });
});

describe('规范序列化与缓存键', () => {
  it('参数键顺序不影响', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableStringify({ o: { x: 1, y: [3, 2] } })).toBe(stableStringify({ o: { y: [3, 2], x: 1 } }));
  });
  const base = { kind: 'filter', implVersion: 1, params: { condition: '$a > 1' }, inputHashes: { in: 'abc' } };
  it('相同语义输入键相同', () => {
    expect(makeNodeCacheKey(base)).toBe(makeNodeCacheKey({ ...base, params: { condition: '$a > 1' } }));
  });
  it('参数变化 / 实现版本变化 / 输入变化都改变键', () => {
    const k0 = makeNodeCacheKey(base);
    expect(makeNodeCacheKey({ ...base, params: { condition: '$a > 2' } })).not.toBe(k0);
    expect(makeNodeCacheKey({ ...base, implVersion: 2 })).not.toBe(k0);
    expect(makeNodeCacheKey({ ...base, inputHashes: { in: 'abd' } })).not.toBe(k0);
  });
  it('键包含 kind 与 implVersion（节点实现版本可观测）', () => {
    const def = getNodeDef('filter');
    expect(typeof def.implVersion).toBe('number');
    expect(makeNodeCacheKey(base)).toContain('filter');
  });
});

describe('RunCache LRU', () => {
  it('超限淘汰最久未使用；统计正确', () => {
    const c = new RunCache(2);
    const t = table([], []);
    c.set('k1', { nodeId: 'n1', kind: 'filter', tables: { out: t } });
    c.set('k2', { nodeId: 'n2', kind: 'filter', tables: { out: t } });
    expect(c.get('k1')?.nodeId).toBe('n1'); // k1 变新
    c.set('k3', { nodeId: 'n3', kind: 'filter', tables: { out: t } }); // 淘汰 k2
    expect(c.get('k2')).toBeUndefined();
    expect(c.get('k1')?.nodeId).toBe('n1');
    expect(c.get('k3')?.nodeId).toBe('n3');
    const s = c.stats();
    expect(s.entries).toBe(2);
    expect(s.evictions).toBe(1);
    expect(s.hits).toBe(3);
    expect(s.misses).toBe(1);
    c.clear();
    expect(c.stats().entries).toBe(0);
  });
});

/** 计数后端：统计每个节点实际执行次数。 */
class CountingBackend extends LocalBackend {
  counts = new Map<string, number>();
  async execute(req: ExecuteRequest): Promise<ExecuteResponse> {
    this.counts.set(req.nodeId, (this.counts.get(req.nodeId) ?? 0) + 1);
    return super.execute(req);
  }
}

const CSV = 'name,price,qty\n苹果,1050,3\n香蕉,550,10\n';

function chain(): WorkflowGraph {
  return {
    revision: 1,
    nodes: [
      { id: 'n1', kind: 'csv-input', name: 'CSV', params: { csvText: CSV }, position: { x: 0, y: 0 } },
      { id: 'n2', kind: 'filter', name: '过滤', params: { condition: '$qty >= 5' }, position: { x: 0, y: 0 } },
      { id: 'n3', kind: 'computed-column', name: '小计', params: { column: 'total', expression: '$price * $qty' }, position: { x: 0, y: 0 } },
      { id: 'n4', kind: 'output', name: '输出', params: {}, position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  };
}

describe('执行器增量缓存集成', () => {
  it('第二次相同运行全部命中，不再执行', async () => {
    const backend = new CountingBackend();
    const cache = new RunCache();
    const mgr = new RunManager(backend);
    const r1 = await mgr.start(chain(), { cache });
    expect(r1.cacheHits).toBe(0);
    expect(backend.counts.get('n4')).toBe(1);

    const r2 = await mgr.start(chain(), { cache });
    expect(r2.cacheHits).toBe(4);
    for (const nid of ['n1', 'n2', 'n3', 'n4']) {
      expect(r2.nodeStates[nid]?.cacheHit).toBe(true);
      expect(backend.counts.get(nid)).toBe(1); // 未重新执行
    }
    // 命中结果与首次一致
    expect(r2.outputs['n4']).toEqual(r1.outputs['n4']);
  });

  it('修改中间节点参数：只失效该节点及其下游', async () => {
    const backend = new CountingBackend();
    const cache = new RunCache();
    const mgr = new RunManager(backend);
    await mgr.start(chain(), { cache });
    await mgr.start(chain(), { cache });

    const g = chain();
    g.nodes.find((n) => n.id === 'n2')!.params = { condition: '$qty >= 1' };
    const r3 = await mgr.start(g, { cache });
    expect(r3.cacheHits).toBe(1); // 只有 n1 命中
    expect(r3.nodeStates['n1']?.cacheHit).toBe(true);
    expect(backend.counts.get('n1')).toBe(1);
    expect(backend.counts.get('n2')).toBe(2);
    expect(backend.counts.get('n3')).toBe(2);
    expect(backend.counts.get('n4')).toBe(2);
    // 结果正确变化（$qty>=5 得 1 行，放宽到 $qty>=1 得 2 行）
    expect(r3.outputs['n4']?.rows.length).toBe(2);
  });

  it('只移动节点位置：缓存不失效', async () => {
    const backend = new CountingBackend();
    const cache = new RunCache();
    const mgr = new RunManager(backend);
    await mgr.start(chain(), { cache });

    const g = chain();
    for (const n of g.nodes) n.position = { x: n.position.x + 500, y: n.position.y + 300 };
    const r2 = await mgr.start(g, { cache });
    expect(r2.cacheHits).toBe(4);
    for (const nid of ['n1', 'n2', 'n3', 'n4']) expect(backend.counts.get(nid)).toBe(1);
  });

  it('修改源数据：全部失效重算', async () => {
    const backend = new CountingBackend();
    const cache = new RunCache();
    const mgr = new RunManager(backend);
    await mgr.start(chain(), { cache });

    const g = chain();
    g.nodes.find((n) => n.id === 'n1')!.params = { csvText: 'name,price,qty\n梨,700,8\n' };
    const r2 = await mgr.start(g, { cache });
    expect(r2.cacheHits).toBe(0);
    for (const nid of ['n1', 'n2', 'n3', 'n4']) expect(backend.counts.get(nid)).toBe(2);
  });

  it('调试模式绕过缓存', async () => {
    const backend = new CountingBackend();
    const cache = new RunCache();
    const mgr = new RunManager(backend);
    await mgr.start(chain(), { cache });
    const r2 = await mgr.start(chain(), { cache, debug: true });
    expect(r2.cacheHits).toBe(0);
    for (const nid of ['n1', 'n2', 'n3', 'n4']) {
      expect(r2.nodeStates[nid]?.cacheHit).not.toBe(true);
      expect(backend.counts.get(nid)).toBe(2);
    }
  });
});
