/**
 * 项目文档存储（M3）。
 *
 * ProjectDocument v2 = { id, name, version, graph, createdAt, updatedAt, snapshots }。
 * v1 文档在加载时经 validateAndMigrate 迁移（见 migrate.ts）。
 *
 * 并发语义（F07 多标签页）：存储记录附带单调递增的 rev；
 * save(doc, expectedRev) 在当前 rev 与预期不一致时抛 ConflictError，
 * 调用方必须走冲突解决流程，禁止静默覆盖另一标签页的修改。
 */
import type { WorkflowGraph } from '../engine/types';
import { validateAndMigrate } from './migrate';

export const DOCUMENT_VERSION = 2;

/** 命名快照（F07）：完整图快照 + 元信息，存在文档内。 */
export interface NamedSnapshot {
  id: string;
  name: string;
  createdAt: string; // ISO 8601
  graph: WorkflowGraph;
}

export interface ProjectDocument {
  id: string;
  name: string;
  /** 工程格式版本（F07：可版本化）。 */
  version: number;
  graph: WorkflowGraph;
  createdAt: string; // ISO 8601（v2 新增）
  updatedAt: string; // ISO 8601
  /** 命名快照（v2 新增）。 */
  snapshots: NamedSnapshot[];
}

export interface StorageBackend {
  load(id: string): Promise<ProjectDocument | null>;
  /** 保存；返回写入后的 rev（用于多标签页并发检测）。 */
  save(doc: ProjectDocument): Promise<number>;
  remove(id: string): Promise<void>;
}

/** 多标签页写入冲突（F07）。currentRev 为存储中实际的 rev。 */
export class ConflictError extends Error {
  readonly currentRev: number;
  constructor(currentRev: number) {
    super(`写入冲突：文档已被另一标签页修改（当前 rev=${currentRev}）`);
    this.name = 'ConflictError';
    this.currentRev = currentRev;
  }
}

/**
 * 带乐观并发的存储后端。
 * save(doc, expectedRev)：expectedRev 缺省时为强制写入（冲突解决用）；
 * 传入时若存储 rev 与预期不一致则抛 ConflictError。
 * 成功返回写入后的新 rev。
 */
export interface RevisionedStorageBackend extends StorageBackend {
  loadWithRev(id: string): Promise<{ doc: ProjectDocument; rev: number } | null>;
  save(doc: ProjectDocument, expectedRev?: number): Promise<number>;
}

export function newDocument(id: string, name: string): ProjectDocument {
  const now = new Date().toISOString();
  return {
    id,
    name,
    version: DOCUMENT_VERSION,
    graph: { nodes: [], edges: [], revision: 0 },
    createdAt: now,
    updatedAt: now,
    snapshots: [],
  };
}

/** 存储记录包装：{ doc, rev }；兼容直接存 doc 的旧格式（rev=0）。 */
export function wrapRecord(doc: ProjectDocument, rev: number): string {
  return JSON.stringify({ doc, rev });
}

export function unwrapRecord(raw: string): { doc: ProjectDocument; rev: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed !== null && typeof parsed === 'object' && 'doc' in parsed && 'rev' in parsed) {
    const rec = parsed as { doc: unknown; rev: unknown };
    if (typeof rec.rev !== 'number') return null;
    const m = validateAndMigrate(rec.doc);
    return m.ok ? { doc: m.doc, rev: rec.rev } : null;
  }
  // 兼容旧格式：直接存的文档 JSON（v1/v2）
  const m = validateAndMigrate(parsed);
  return m.ok ? { doc: m.doc, rev: 0 } : null;
}

const DOC_KEY_PREFIX = 'flowlab.doc.';

export class LocalStorageBackend implements RevisionedStorageBackend {
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

  async loadWithRev(id: string): Promise<{ doc: ProjectDocument; rev: number } | null> {
    const raw = this.storage.getItem(this.key(id));
    if (raw === null) return null;
    return unwrapRecord(raw); // 损坏返回 null，由调用方处理
  }

  async load(id: string): Promise<ProjectDocument | null> {
    const rec = await this.loadWithRev(id);
    return rec?.doc ?? null;
  }

  async save(doc: ProjectDocument, expectedRev?: number): Promise<number> {
    const raw = this.storage.getItem(this.key(doc.id));
    const current = raw === null ? null : unwrapRecord(raw);
    const currentRev = current?.rev ?? 0;
    if (expectedRev !== undefined && raw !== null && currentRev !== expectedRev) {
      throw new ConflictError(currentRev);
    }
    const nextRev = currentRev + 1;
    const next: ProjectDocument = { ...doc, updatedAt: new Date().toISOString() };
    this.storage.setItem(this.key(doc.id), wrapRecord(next, nextRev));
    return nextRev;
  }

  async remove(id: string): Promise<void> {
    this.storage.removeItem(this.key(id));
  }
}

/** 内存后端（单元测试用），实现完整 rev 语义。 */
export class MemoryBackend implements RevisionedStorageBackend {
  private map = new Map<string, string>();

  async loadWithRev(id: string): Promise<{ doc: ProjectDocument; rev: number } | null> {
    const raw = this.map.get(id);
    if (!raw) return null;
    return unwrapRecord(raw);
  }

  async load(id: string): Promise<ProjectDocument | null> {
    const rec = await this.loadWithRev(id);
    return rec?.doc ?? null;
  }

  async save(doc: ProjectDocument, expectedRev?: number): Promise<number> {
    const raw = this.map.get(doc.id);
    const currentRev = raw ? (unwrapRecord(raw)?.rev ?? 0) : 0;
    if (expectedRev !== undefined && raw !== undefined && currentRev !== expectedRev) {
      throw new ConflictError(currentRev);
    }
    const nextRev = currentRev + 1;
    this.map.set(doc.id, wrapRecord({ ...doc, updatedAt: new Date().toISOString() }, nextRev));
    return nextRev;
  }

  async remove(id: string): Promise<void> {
    this.map.delete(id);
  }
}
