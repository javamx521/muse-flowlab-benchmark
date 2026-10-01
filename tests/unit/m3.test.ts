/**
 * M3 单元测试（F06 撤销/重做、F07 持久化/迁移/快照/冲突/导入导出）。
 *
 * 浏览器专属模块（indexedDb.ts / appStores.ts / useEditor.ts）由 E2E 真实覆盖，
 * 此处覆盖纯逻辑：history / migrate / snapshots / exportImport / rev 并发语义。
 */
import { describe, expect, it } from 'vitest';
import { UndoHistory, MAX_HISTORY } from '../../src/store/history';
import { validateAndMigrate } from '../../src/store/migrate';
import { diffGraphs, isDiffEmpty } from '../../src/store/snapshots';
import { serializeExport, parseImport, adoptImported, EXPORT_KIND } from '../../src/store/exportImport';
import { MemoryBackend, newDocument, ConflictError, DOCUMENT_VERSION } from '../../src/store/document';
import type { WorkflowGraph } from '../../src/engine/types';

function graph(revision: number, nodeNames: string[] = []): WorkflowGraph {
  return {
    revision,
    nodes: nodeNames.map((name, i) => ({
      id: `n${i}`,
      kind: 'output' as const,
      name,
      params: {},
      position: { x: i * 10, y: 0 },
    })),
    edges: [],
  };
}

describe('UndoHistory', () => {
  it('push/undo/redo 基本语义', () => {
    const h = new UndoHistory();
    const g0 = graph(0);
    const g1 = graph(1);
    expect(h.canUndo).toBe(false);
    h.push(g0, 'edit1');
    expect(h.canUndo).toBe(true);
    expect(h.undo(g1)).toBe(g0);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(true);
    expect(h.redo(g0)).toBe(g1);
    expect(h.canRedo).toBe(false);
  });

  it('空历史 undo/redo 返回 null', () => {
    const h = new UndoHistory();
    expect(h.undo(graph(0))).toBeNull();
    expect(h.redo(graph(0))).toBeNull();
  });

  it('至少保留 100 步，超限丢弃最旧', () => {
    const h = new UndoHistory();
    for (let i = 0; i < MAX_HISTORY + 20; i++) h.push(graph(i), `e${i}`);
    expect(h.undoDepth).toBe(MAX_HISTORY);
    // 最旧的 20 条已被丢弃：连续撤销 MAX_HISTORY 次应到达 graph(20)
    let cur = graph(MAX_HISTORY + 20);
    for (let i = 0; i < MAX_HISTORY; i++) {
      const prev = h.undo(cur);
      expect(prev).not.toBeNull();
      cur = prev!;
    }
    expect(cur.revision).toBe(20);
    expect(h.canUndo).toBe(false);
  });

  it('相同 coalesceKey 合并（一次连续拖拽 = 一条历史）', () => {
    const h = new UndoHistory();
    const g0 = graph(0);
    h.push(g0, 'move', 'drag-1');
    h.push(graph(1), 'move', 'drag-1');
    h.push(graph(2), 'move', 'drag-1');
    expect(h.undoDepth).toBe(1);
    expect(h.undo(graph(3))).toBe(g0);
  });

  it('不同 coalesceKey 不合并', () => {
    const h = new UndoHistory();
    h.push(graph(0), 'move', 'drag-1');
    h.push(graph(1), 'move', 'drag-2');
    expect(h.undoDepth).toBe(2);
  });

  it('maxAgeMs 窗口过期后不合并（连续键入）', () => {
    const h = new UndoHistory();
    h.push(graph(0), 'param', 'param:n1:k', 1500);
    // 模拟时间流逝：直接改 at（白盒，验证窗口语义）
    const past = (h as unknown as { past: { at: number }[] }).past;
    past[0]!.at -= 5000;
    h.push(graph(1), 'param', 'param:n1:k', 1500);
    expect(h.undoDepth).toBe(2);
  });

  it('新编辑清空 redo 分支', () => {
    const h = new UndoHistory();
    h.push(graph(0), 'e1');
    h.push(graph(1), 'e2');
    h.undo(graph(2));
    expect(h.canRedo).toBe(true);
    h.push(graph(2), 'e3');
    expect(h.canRedo).toBe(false);
  });

  it('clear 清空全部', () => {
    const h = new UndoHistory();
    h.push(graph(0), 'e1');
    h.clear();
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });
});

describe('validateAndMigrate', () => {
  const v1doc = {
    id: 'p1',
    name: '旧项目',
    version: 1,
    graph: { nodes: [], edges: [], revision: 3 },
    updatedAt: '2026-09-01T00:00:00.000Z',
  };

  it('v1 迁移到 v2：补 createdAt 与 snapshots', () => {
    const r = validateAndMigrate(v1doc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.version).toBe(DOCUMENT_VERSION);
    expect(r.doc.createdAt).toBe('2026-09-01T00:00:00.000Z');
    expect(r.doc.snapshots).toEqual([]);
    expect(r.doc.graph.revision).toBe(3);
  });

  it('v2 文档直接通过', () => {
    const v2 = { ...v1doc, version: 2, createdAt: '2026-09-02T00:00:00.000Z', snapshots: [] };
    const r = validateAndMigrate(v2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.createdAt).toBe('2026-09-02T00:00:00.000Z');
  });

  it('拒绝：非对象 / 缺 version / 版本过高', () => {
    expect(validateAndMigrate(null).ok).toBe(false);
    expect(validateAndMigrate({ id: 'x' }).ok).toBe(false);
    expect(validateAndMigrate({ ...v1doc, version: 99 }).ok).toBe(false);
  });

  it('拒绝：图结构损坏', () => {
    expect(validateAndMigrate({ ...v1doc, graph: { nodes: 'bad', edges: [], revision: 0 } }).ok).toBe(false);
    expect(
      validateAndMigrate({
        ...v1doc,
        graph: { nodes: [{ id: '', kind: 'output', name: 'n', params: {}, position: { x: 0, y: 0 } }], edges: [], revision: 0 },
      }).ok,
    ).toBe(false);
  });

  it('拒绝：v2 snapshots 损坏', () => {
    const bad = { ...v1doc, version: 2, createdAt: '2026-09-02T00:00:00.000Z', snapshots: [{ bad: 1 }] };
    const r = validateAndMigrate(bad);
    expect(r.ok).toBe(false);
  });
});

describe('diffGraphs', () => {
  it('空差异', () => {
    const g = graph(1, ['a']);
    expect(isDiffEmpty(diffGraphs(g, g))).toBe(true);
  });

  it('节点增删', () => {
    const d = diffGraphs(graph(1, ['a']), graph(2, ['a', 'b']));
    expect(d.addedNodes.map((n) => n.name)).toEqual(['b']);
    expect(d.removedNodes).toHaveLength(0);
    expect(d.layoutOnly).toBe(false);
  });

  it('参数变化与位置移动区分', () => {
    const before = graph(1, ['a']);
    const after = graph(2, ['a']);
    after.nodes[0]!.params = { n: 10 };
    const d1 = diffGraphs(before, after);
    expect(d1.changedNodes[0]!.changes).toContain('参数 "n" 变化');
    expect(d1.layoutOnly).toBe(false);

    const moved = graph(3, ['a']);
    moved.nodes[0]!.position = { x: 999, y: 0 };
    const d2 = diffGraphs(before, moved);
    expect(d2.changedNodes[0]!.changes).toEqual(['位置移动']);
    expect(d2.layoutOnly).toBe(true);
  });

  it('数据源参数变化单独标出', () => {
    const before: WorkflowGraph = {
      revision: 1,
      nodes: [{ id: 'n0', kind: 'csv-input', name: 'csv', params: { text: 'a' }, position: { x: 0, y: 0 } }],
      edges: [],
    };
    const after: WorkflowGraph = {
      revision: 2,
      nodes: [{ id: 'n0', kind: 'csv-input', name: 'csv', params: { text: 'b' }, position: { x: 0, y: 0 } }],
      edges: [],
    };
    const d = diffGraphs(before, after);
    expect(d.changedNodes[0]!.changes).toContain('数据源参数 "text" 变化');
  });

  it('连线增删', () => {
    const before = graph(1, ['a', 'b']);
    const after = graph(2, ['a', 'b']);
    after.edges = [{ id: 'e1', source: 'n0', target: 'n1' }];
    const d = diffGraphs(before, after);
    expect(d.addedEdges).toHaveLength(1);
    expect(d.removedEdges).toHaveLength(0);
  });
});

describe('RevisionedStorageBackend 并发语义（MemoryBackend）', () => {
  it('save 返回递增 rev；loadWithRev 取回', async () => {
    const b = new MemoryBackend();
    const r1 = await b.save(newDocument('p1', 'x'));
    const r2 = await b.save(newDocument('p1', 'x'));
    expect(r2).toBe(r1 + 1);
    const rec = await b.loadWithRev('p1');
    expect(rec?.rev).toBe(r2);
  });

  it('expectedRev 不一致时抛 ConflictError（不静默覆盖）', async () => {
    const b = new MemoryBackend();
    const doc = newDocument('p1', 'x');
    const rev1 = await b.save(doc);
    // 模拟另一标签页写入
    await b.save({ ...doc, name: 'other-tab' });
    await expect(b.save(doc, rev1)).rejects.toBeInstanceOf(ConflictError);
    // 冲突写入未生效
    const loaded = await b.load('p1');
    expect(loaded!.name).toBe('other-tab');
  });

  it('expectedRev 一致时写入成功；缺省为强制写入', async () => {
    const b = new MemoryBackend();
    const doc = newDocument('p1', 'x');
    const rev1 = await b.save(doc);
    const rev2 = await b.save({ ...doc, name: 'y' }, rev1);
    expect(rev2).toBe(rev1 + 1);
    await b.save({ ...doc, name: 'forced' });
    expect((await b.load('p1'))!.name).toBe('forced');
  });

  it('旧格式（直接存文档 JSON）兼容读取为 rev=0', async () => {
    const b = new MemoryBackend();
    // 白盒：直接写入旧格式
    const map = (b as unknown as { map: Map<string, string> }).map;
    const doc = newDocument('p1', 'x');
    map.set('p1', JSON.stringify(doc));
    const rec = await b.loadWithRev('p1');
    expect(rec?.rev).toBe(0);
    expect(rec?.doc.version).toBe(DOCUMENT_VERSION); // v1 旧文档被迁移
  });
});

describe('exportImport', () => {
  it('导出/解析往返一致', () => {
    const doc = newDocument('p1', '导出测试');
    const text = serializeExport(doc);
    const parsed = JSON.parse(text) as { kind: string };
    expect(parsed.kind).toBe(EXPORT_KIND);
    const r = parseImport(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.id).toBe('p1');
      expect(r.doc.name).toBe('导出测试');
    }
  });

  it('拒绝：非 JSON / 非导出文件 / 损坏文档', () => {
    expect(parseImport('not json').ok).toBe(false);
    expect(parseImport(JSON.stringify({ kind: 'other' })).ok).toBe(false);
    expect(
      parseImport(JSON.stringify({ kind: EXPORT_KIND, document: { id: 1 } })).ok,
    ).toBe(false);
  });

  it('adoptImported 分配新身份、保留内容', () => {
    const doc = newDocument('old', '名');
    const adopted = adoptImported(doc, 'new-id', '新名');
    expect(adopted.id).toBe('new-id');
    expect(adopted.name).toBe('新名');
    expect(adopted.graph).toEqual(doc.graph);
  });
});
