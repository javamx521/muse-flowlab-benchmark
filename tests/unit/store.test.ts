/**
 * 存储层单元测试（M1）：文档后端 save/load/remove 语义、损坏数据处理。
 * LocalStorageBackend 用内存 StorageLike 注入测试（与 localStorage 同接口）。
 */
import { describe, expect, it } from 'vitest';
import { LocalStorageBackend, MemoryBackend, newDocument, DOCUMENT_VERSION } from '../../src/store/document';
import type { StorageBackend } from '../../src/store/document';

function makeMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    /** 供测试直接写入损坏数据 */
    rawSet: (k: string, v: string) => void map.set(k, v),
    rawKey: (id: string) => `flowlab.doc.${id}`,
  };
}

const backends = (): [string, () => StorageBackend][] => [
  ['MemoryBackend', () => new MemoryBackend()],
  ['LocalStorageBackend', () => new LocalStorageBackend(makeMemoryStorage())],
];

describe.each(backends())('文档后端 %s', (_name, make) => {
  it('save 后 load 返回一致文档', async () => {
    const b = make();
    const doc = newDocument('p1', '测试项目');
    await b.save(doc);
    const loaded = await b.load('p1');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('p1');
    expect(loaded!.name).toBe('测试项目');
    expect(loaded!.version).toBe(DOCUMENT_VERSION);
    expect(loaded!.graph.revision).toBe(0);
  });

  it('load 不存在的 id 返回 null', async () => {
    const b = make();
    expect(await b.load('missing')).toBeNull();
  });

  it('remove 后 load 返回 null', async () => {
    const b = make();
    await b.save(newDocument('p2', 'x'));
    await b.remove('p2');
    expect(await b.load('p2')).toBeNull();
  });

  it('save 更新 updatedAt 且保留图内容', async () => {
    const b = make();
    const doc = newDocument('p3', 'y');
    doc.graph.nodes.push({ id: 'n1', kind: 'output', name: '输出', params: {}, position: { x: 1, y: 2 } });
    await b.save(doc);
    const loaded = await b.load('p3');
    expect(loaded!.graph.nodes).toHaveLength(1);
    expect(loaded!.graph.nodes[0]!.position).toEqual({ x: 1, y: 2 });
    expect(typeof loaded!.updatedAt).toBe('string');
  });
});

describe('LocalStorageBackend 损坏数据', () => {
  it('损坏的 JSON 返回 null 而不抛错、不清空', async () => {
    const storage = makeMemoryStorage();
    const b = new LocalStorageBackend(storage);
    storage.rawSet(storage.rawKey('bad'), '{not json');
    expect(await b.load('bad')).toBeNull();
    // 损坏数据仍在原位，未被静默覆盖
    expect(storage.getItem(storage.rawKey('bad'))).toBe('{not json');
  });

  it('结构不对的 JSON 返回 null', async () => {
    const storage = makeMemoryStorage();
    const b = new LocalStorageBackend(storage);
    storage.rawSet(storage.rawKey('bad2'), JSON.stringify({ foo: 1 }));
    expect(await b.load('bad2')).toBeNull();
  });
});

describe('newDocument', () => {
  it('默认值正确', () => {
    const d = newDocument('id1', '名');
    expect(d.graph).toEqual({ nodes: [], edges: [], revision: 0 });
    expect(d.version).toBe(DOCUMENT_VERSION);
  });
});
