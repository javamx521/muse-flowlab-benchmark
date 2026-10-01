/**
 * 项目文档存储（M1）。
 *
 * ProjectDocument = { id, name, graph, updatedAt }。
 * StorageBackend 接口为异步，便于 M3 无缝切换到 IndexedDB；
 * M1 提供 LocalStorageBackend 实现（真实持久化，非内存假装）。
 */
import type { WorkflowGraph } from '../engine/types';

export const DOCUMENT_VERSION = 1;

export interface ProjectDocument {
  id: string;
  name: string;
  /** 工程格式版本（F07：可版本化，M3 提供迁移）。 */
  version: number;
  graph: WorkflowGraph;
  updatedAt: string; // ISO 8601
}

export interface StorageBackend {
  load(id: string): Promise<ProjectDocument | null>;
  save(doc: ProjectDocument): Promise<void>;
  remove(id: string): Promise<void>;
}

export function newDocument(id: string, name: string): ProjectDocument {
  return {
    id,
    name,
    version: DOCUMENT_VERSION,
    graph: { nodes: [], edges: [], revision: 0 },
    updatedAt: new Date().toISOString(),
  };
}

const DOC_KEY_PREFIX = 'flowlab.doc.';

export class LocalStorageBackend implements StorageBackend {
  constructor(
    private storage: {
      getItem(k: string): string | null;
      setItem(k: string, v: string): void;
      removeItem(k: string): void;
    } = localStorage,
  ) {}

  private key(id: string): string {
    return `${DOC_KEY_PREFIX}${id}`;
  }

  async load(id: string): Promise<ProjectDocument | null> {
    const raw = this.storage.getItem(this.key(id));
    if (raw === null) return null;
    try {
      const doc = JSON.parse(raw) as ProjectDocument;
      if (!doc || typeof doc.id !== 'string' || !doc.graph) return null;
      return doc;
    } catch {
      return null; // 损坏不抛错，由调用方处理
    }
  }

  async save(doc: ProjectDocument): Promise<void> {
    const next: ProjectDocument = { ...doc, updatedAt: new Date().toISOString() };
    this.storage.setItem(this.key(doc.id), JSON.stringify(next));
  }

  async remove(id: string): Promise<void> {
    this.storage.removeItem(this.key(id));
  }
}

/** 内存后端（单元测试用）。 */
export class MemoryBackend implements StorageBackend {
  private map = new Map<string, string>();

  async load(id: string): Promise<ProjectDocument | null> {
    const raw = this.map.get(id);
    if (!raw) return null;
    return JSON.parse(raw) as ProjectDocument;
  }

  async save(doc: ProjectDocument): Promise<void> {
    this.map.set(doc.id, JSON.stringify({ ...doc, updatedAt: new Date().toISOString() }));
  }

  async remove(id: string): Promise<void> {
    this.map.delete(id);
  }
}
