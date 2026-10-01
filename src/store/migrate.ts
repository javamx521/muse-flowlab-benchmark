/**
 * 工程格式验证与版本迁移（F07）。
 *
 * - v1: { id, name, version: 1, graph, updatedAt }（M1/M2 时代）。
 * - v2: 新增 createdAt（缺省=updatedAt）、snapshots: NamedSnapshot[]（缺省=[]）。
 *
 * 规则：
 * - 结构验证失败 → 返回明确错误，不抛错、不清空原项目；
 * - 未知的新版本（version > CURRENT）→ 拒绝并提示；
 * - 迁移失败同样返回错误，调用方不得用半成品覆盖原文档。
 */
import type { Edge, NodeInstance, WorkflowGraph } from '../engine/types';
import type { NamedSnapshot, ProjectDocument } from './document';
import { DOCUMENT_VERSION } from './document';

export type MigrateResult = { ok: true; doc: ProjectDocument } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function checkNode(n: unknown): n is NodeInstance {
  if (!isRecord(n)) return false;
  if (typeof n['id'] !== 'string' || n['id'] === '') return false;
  if (typeof n['kind'] !== 'string') return false;
  if (typeof n['name'] !== 'string') return false;
  if (!isRecord(n['params'])) return false;
  const pos = n['position'];
  if (!isRecord(pos) || typeof pos['x'] !== 'number' || typeof pos['y'] !== 'number') return false;
  return true;
}

function checkEdge(e: unknown): e is Edge {
  if (!isRecord(e)) return false;
  return (
    typeof e['id'] === 'string' &&
    typeof e['source'] === 'string' &&
    typeof e['target'] === 'string'
  );
}

function checkGraph(g: unknown): g is WorkflowGraph {
  if (!isRecord(g)) return false;
  if (!Array.isArray(g['nodes']) || !Array.isArray(g['edges'])) return false;
  if (typeof g['revision'] !== 'number') return false;
  return g['nodes'].every(checkNode) && g['edges'].every(checkEdge);
}

function checkSnapshot(s: unknown): s is NamedSnapshot {
  if (!isRecord(s)) return false;
  return (
    typeof s['id'] === 'string' &&
    typeof s['name'] === 'string' &&
    typeof s['createdAt'] === 'string' &&
    checkGraph(s['graph'])
  );
}

/**
 * 验证并迁移任意来源的工程文档（本地存储 / 导入文件）。
 * 成功返回规范化的 v2 文档；失败返回人类可读的错误原因。
 */
export function validateAndMigrate(raw: unknown): MigrateResult {
  if (!isRecord(raw)) return { ok: false, error: '工程文件不是有效的 JSON 对象' };
  const version = raw['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: '缺少有效的工程格式版本（version）' };
  }
  if (version > DOCUMENT_VERSION) {
    return {
      ok: false,
      error: `工程格式版本 v${version} 高于当前支持的 v${DOCUMENT_VERSION}，请更新应用后重试`,
    };
  }
  if (typeof raw['id'] !== 'string' || raw['id'] === '') {
    return { ok: false, error: '工程缺少有效的 id' };
  }
  if (typeof raw['name'] !== 'string') {
    return { ok: false, error: '工程缺少有效的名称' };
  }
  if (!checkGraph(raw['graph'])) {
    return { ok: false, error: '工程图结构损坏（nodes/edges/revision 非法）' };
  }
  if (typeof raw['updatedAt'] !== 'string') {
    return { ok: false, error: '工程缺少有效的 updatedAt' };
  }

  // v1 → v2 迁移
  let createdAt = raw['updatedAt'] as string;
  let snapshots: NamedSnapshot[] = [];
  if (version >= 2) {
    if (typeof raw['createdAt'] !== 'string') {
      return { ok: false, error: 'v2 工程缺少有效的 createdAt' };
    }
    createdAt = raw['createdAt'] as string;
    const rawSnaps = raw['snapshots'];
    if (rawSnaps !== undefined) {
      if (!Array.isArray(rawSnaps) || !rawSnaps.every(checkSnapshot)) {
        return { ok: false, error: '工程快照数据损坏' };
      }
      snapshots = rawSnaps as NamedSnapshot[];
    }
  }

  const doc: ProjectDocument = {
    id: raw['id'] as string,
    name: raw['name'] as string,
    version: DOCUMENT_VERSION,
    graph: raw['graph'] as WorkflowGraph,
    createdAt,
    updatedAt: raw['updatedAt'] as string,
    snapshots,
  };
  return { ok: true, doc };
}
