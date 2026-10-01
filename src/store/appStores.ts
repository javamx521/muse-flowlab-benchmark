/**
 * 应用级单例：存储后端与项目注册表（M3）。
 *
 * - 浏览器优先用 IndexedDB；不可用时降级为 localStorage（并给出一致性说明）。
 * - 首次初始化时把 localStorage 旧数据一次性迁入 IndexedDB（幂等）。
 */
import { createProjectStore, createMemoryStorage } from '../lib/projects';
import type { AsyncProjectStore } from './indexedDb';
import {
  IndexedDBBackend,
  createIndexedDBProjectStore,
  indexedDBAvailable,
  migrateFromLocalStorage,
} from './indexedDb';
import { LocalStorageBackend } from './document';
import type { RevisionedStorageBackend } from './document';

let backend: RevisionedStorageBackend | null = null;

/** 存储后端单例。 */
export function getBackend(): RevisionedStorageBackend {
  if (!backend) {
    backend = indexedDBAvailable() ? new IndexedDBBackend() : new LocalStorageBackend();
  }
  return backend;
}

let storePromise: Promise<AsyncProjectStore> | null = null;

/** 项目注册表单例（异步）。 */
export function getProjectStore(): Promise<AsyncProjectStore> {
  if (!storePromise) {
    storePromise = (async (): Promise<AsyncProjectStore> => {
      const b = getBackend();
      if (!indexedDBAvailable()) {
        // 降级：用同步 localStorage 实现包一层异步适配
        const mem = typeof localStorage !== 'undefined' ? localStorage : createMemoryStorage();
        const ls = createProjectStore(mem);
        const adapt = (s: ReturnType<typeof createProjectStore>): AsyncProjectStore => ({
          list: async () => s.list(),
          search: async (kw: string) => s.search(kw),
          get: async (id: string) => s.get(id),
          create: async (name: string) => s.create(name),
          copy: async (id: string, name?: string) => {
            const src = s.get(id);
            if (!src) throw new Error(`项目不存在: ${id}`);
            const meta = s.create(name ?? `${src.name} 副本`);
            const doc = await b.load(id);
            if (doc) await b.save(JSON.parse(JSON.stringify({ ...doc, id: meta.id })) as typeof doc);
            return meta;
          },
          rename: async (id: string, name: string) => s.rename(id, name),
          remove: async (id: string) => {
            const ok = s.remove(id);
            if (ok) await b.remove(id);
            return ok;
          },
        });
        return adapt(ls);
      }
      const store = createIndexedDBProjectStore({
        copyDocument: async (srcId: string, dstId: string) => {
          const src = await b.load(srcId);
          if (src) {
            const clone = JSON.parse(JSON.stringify(src)) as typeof src;
            clone.id = dstId;
            await b.save(clone);
          }
        },
        removeDocument: (id: string) => b.remove(id),
      });
      await migrateFromLocalStorage(store, b);
      return store;
    })();
  }
  return storePromise;
}
