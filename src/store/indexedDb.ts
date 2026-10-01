/**
 * IndexedDB 持久化（F07，D-004）。
 *
 * - 数据库名 `flowlab-studio`；对象仓库 `flowlab.documents`（文档+rev）、
 *   `flowlab.projects`（项目元数据）、`flowlab.meta`（迁移标记等）。
 *   只读写本项目命名空间，不清理同域其他应用数据。
 * - 文档写入带乐观并发 rev（见 document.ts ConflictError）。
 * - 首次使用时把 localStorage 中的旧数据一次性迁移进来（幂等，有标记）。
 */
import type { ProjectMeta } from '../lib/projects';
import { validateProjectName } from '../lib/projects';
import { PROJECTS_KEY } from '../lib/storageKeys';
import { ConflictError, unwrapRecord, wrapRecord } from './document';
import type { ProjectDocument, RevisionedStorageBackend } from './document';
import { validateAndMigrate } from './migrate';

export const IDB_DB_NAME = 'flowlab-studio';
const DOC_STORE = 'flowlab.documents';
const PROJ_STORE = 'flowlab.projects';
const META_STORE = 'flowlab.meta';
const MIGRATION_FLAG = 'migrated-from-localstorage-v1';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DOC_STORE)) db.createObjectStore(DOC_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(PROJ_STORE)) db.createObjectStore(PROJ_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
    req.onblocked = () => reject(new Error('IndexedDB 打开被阻塞（可能有旧标签页占用）'));
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store)) as IDBRequest<T>;
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 操作失败'));
  });
}

export function indexedDBAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined';
  } catch {
    return false;
  }
}

interface DocRow {
  id: string;
  payload: string;
}

export class IndexedDBBackend implements RevisionedStorageBackend {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openDb();
    return this.dbPromise;
  }

  async loadWithRev(id: string): Promise<{ doc: ProjectDocument; rev: number } | null> {
    const db = await this.db();
    const row = await tx<DocRow | undefined>(db, DOC_STORE, 'readonly', (s) => s.get(id));
    if (!row) return null;
    return unwrapRecord(row.payload);
  }

  async load(id: string): Promise<ProjectDocument | null> {
    const rec = await this.loadWithRev(id);
    return rec?.doc ?? null;
  }

  async save(doc: ProjectDocument, expectedRev?: number): Promise<number> {
    const db = await this.db();
    const row = await tx<DocRow | undefined>(db, DOC_STORE, 'readonly', (s) => s.get(doc.id));
    const currentRev = row ? (unwrapRecord(row.payload)?.rev ?? 0) : 0;
    if (expectedRev !== undefined && row !== undefined && currentRev !== expectedRev) {
      throw new ConflictError(currentRev);
    }
    const nextRev = currentRev + 1;
    const next: ProjectDocument = { ...doc, updatedAt: new Date().toISOString() };
    const out: DocRow = { id: doc.id, payload: wrapRecord(next, nextRev) };
    await tx(db, DOC_STORE, 'readwrite', (s) => s.put(out));
    return nextRev;
  }

  async remove(id: string): Promise<void> {
    const db = await this.db();
    await tx(db, DOC_STORE, 'readwrite', (s) => s.delete(id));
  }
}

/** 异步项目注册表（F07）：创建/重命名/复制/搜索/删除确认。 */
export interface AsyncProjectStore {
  list(): Promise<ProjectMeta[]>;
  search(keyword: string): Promise<ProjectMeta[]>;
  get(id: string): Promise<ProjectMeta | undefined>;
  create(name: string): Promise<ProjectMeta>;
  /** 复制项目：新 id + 深拷贝文档；默认不覆盖。 */
  copy(id: string, name?: string): Promise<ProjectMeta>;
  rename(id: string, name: string): Promise<ProjectMeta>;
  remove(id: string): Promise<boolean>;
}

export interface ProjectStoreDeps {
  /** 复制文档实现（由调用方注入，避免循环依赖）。 */
  copyDocument?: (srcId: string, dstId: string) => Promise<void>;
  removeDocument?: (id: string) => Promise<void>;
}

function sortMetas(all: ProjectMeta[]): ProjectMeta[] {
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createIndexedDBProjectStore(deps: ProjectStoreDeps = {}): AsyncProjectStore {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () => {
    if (!dbPromise) dbPromise = openDb();
    return dbPromise;
  };

  async function readAll(): Promise<ProjectMeta[]> {
    const d = await db();
    const rows = await tx<ProjectMeta[]>(d, PROJ_STORE, 'readonly', (s) => s.getAll());
    return rows.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string');
  }

  return {
    async list() {
      return sortMetas(await readAll());
    },
    async search(keyword: string) {
      const kw = keyword.trim().toLowerCase();
      const all = sortMetas(await readAll());
      if (kw === '') return all;
      return all.filter((p) => p.name.toLowerCase().includes(kw));
    },
    async get(id: string) {
      const d = await db();
      const row = await tx<ProjectMeta | undefined>(d, PROJ_STORE, 'readonly', (s) => s.get(id));
      return row && typeof row.id === 'string' ? row : undefined;
    },
    async create(name: string) {
      const valid = validateProjectName(name);
      const now = new Date().toISOString();
      const meta: ProjectMeta = { id: crypto.randomUUID(), name: valid, createdAt: now, updatedAt: now };
      const d = await db();
      await tx(d, PROJ_STORE, 'readwrite', (s) => s.put(meta));
      return meta;
    },
    async copy(id: string, name?: string) {
      const src = await this.get(id);
      if (!src) throw new Error(`项目不存在: ${id}`);
      const now = new Date().toISOString();
      const meta: ProjectMeta = {
        id: crypto.randomUUID(),
        name: validateProjectName(name ?? `${src.name} 副本`),
        createdAt: now,
        updatedAt: now,
      };
      const d = await db();
      await tx(d, PROJ_STORE, 'readwrite', (s) => s.put(meta));
      if (deps.copyDocument) await deps.copyDocument(id, meta.id);
      return meta;
    },
    async rename(id: string, name: string) {
      const valid = validateProjectName(name);
      const cur = await this.get(id);
      if (!cur) throw new Error(`项目不存在: ${id}`);
      const next = { ...cur, name: valid, updatedAt: new Date().toISOString() };
      const d = await db();
      await tx(d, PROJ_STORE, 'readwrite', (s) => s.put(next));
      return next;
    },
    async remove(id: string) {
      const cur = await this.get(id);
      if (!cur) return false;
      const d = await db();
      await tx(d, PROJ_STORE, 'readwrite', (s) => s.delete(id));
      if (deps.removeDocument) await deps.removeDocument(id);
      return true;
    },
  };
}

/**
 * 一次性迁移 localStorage 旧数据 → IndexedDB（幂等）。
 * 返回迁移的项目数；失败返回 0（调用方降级继续）。
 */
export async function migrateFromLocalStorage(
  projectStore: AsyncProjectStore,
  backend: RevisionedStorageBackend,
): Promise<number> {
  try {
    const db = await openDb();
    const flag = await tx<{ k: string } | undefined>(db, META_STORE, 'readonly', (s) => s.get(MIGRATION_FLAG));
    if (flag) return 0;
    let moved = 0;
    try {
      const raw = localStorage.getItem(PROJECTS_KEY);
      if (raw) {
        const metas = JSON.parse(raw) as ProjectMeta[];
        if (Array.isArray(metas)) {
          for (const m of metas) {
            if (!m || typeof m.id !== 'string' || typeof m.name !== 'string') continue;
            const exists = await projectStore.get(m.id);
            if (!exists) {
              await tx(db, PROJ_STORE, 'readwrite', (s) => s.put({ ...m } as ProjectMeta));
            }
            const docRaw = localStorage.getItem(`flowlab.doc.${m.id}`);
            if (docRaw) {
              const rec = unwrapRecord(docRaw);
              if (rec) {
                const r = validateAndMigrate(rec.doc);
                if (r.ok) {
                  await backend.save({ ...r.doc, id: m.id, name: m.name });
                  moved += 1;
                }
              }
            }
          }
        }
      }
    } finally {
      await tx(db, META_STORE, 'readwrite', (s) => s.put({ k: MIGRATION_FLAG, at: new Date().toISOString() }));
    }
    return moved;
  } catch {
    return 0;
  }
}
