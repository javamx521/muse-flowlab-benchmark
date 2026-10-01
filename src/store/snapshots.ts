/**
 * 命名快照与快照比较（F07）。
 *
 * 差异至少包含：节点、连线、参数、数据引用变化；纯布局（位置）差异独立展示。
 */
import type { Edge, NodeInstance, WorkflowGraph } from '../engine/types';

export interface NodeChange {
  id: string;
  name: string;
  /** 人类可读的变化描述，如 `参数 "n"：10 → 20`、`位置移动`、`改名`。 */
  changes: string[];
}

export interface GraphDiff {
  addedNodes: NodeInstance[];
  removedNodes: NodeInstance[];
  changedNodes: NodeChange[];
  addedEdges: Edge[];
  removedEdges: Edge[];
  /** 是否只有位置变化（布局差异独立展示）。 */
  layoutOnly: boolean;
}

function paramsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 扁平比较两个 params 对象，返回变化的顶层 key。 */
function changedParamKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  }
  return out;
}

function edgeKey(e: Edge): string {
  return `${e.source}:${e.sourcePort ?? 'out'}→${e.target}:${e.targetPort ?? 'in'}`;
}

/**
 * 比较两个图快照，返回结构化差异。
 * 数据引用变化 = 输入类节点（csv-input/json-input/synthetic-input）的 params 变化，
 * 在 changedNodes 中以 `数据源参数 "key" 变化` 标出。
 */
export function diffGraphs(before: WorkflowGraph, after: WorkflowGraph): GraphDiff {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));
  const addedNodes = after.nodes.filter((n) => !beforeNodes.has(n.id));
  const removedNodes = before.nodes.filter((n) => !afterNodes.has(n.id));
  const changedNodes: NodeChange[] = [];
  let semanticChange = false;

  for (const n of after.nodes) {
    const old = beforeNodes.get(n.id);
    if (!old) continue;
    const changes: string[] = [];
    if (old.name !== n.name) {
      changes.push(`改名：「${old.name}」→「${n.name}」`);
      semanticChange = true;
    }
    if (old.kind !== n.kind) {
      changes.push(`类型变化：${old.kind} → ${n.kind}`);
      semanticChange = true;
    }
    if (!paramsEqual(old.params, n.params)) {
      const keys = changedParamKeys(old.params, n.params);
      const isDataSource = n.kind === 'csv-input' || n.kind === 'json-input' || n.kind === 'synthetic-input';
      for (const k of keys) {
        changes.push(isDataSource ? `数据源参数 "${k}" 变化` : `参数 "${k}" 变化`);
      }
      semanticChange = true;
    }
    if (old.position.x !== n.position.x || old.position.y !== n.position.y) {
      changes.push('位置移动');
    }
    if ((old.breakpoint ?? false) !== (n.breakpoint ?? false)) {
      changes.push(n.breakpoint ? '设置断点' : '清除断点');
      semanticChange = true;
    }
    if (changes.length > 0) changedNodes.push({ id: n.id, name: n.name, changes });
  }

  const beforeEdges = new Map(before.edges.map((e) => [edgeKey(e), e]));
  const afterEdges = new Map(after.edges.map((e) => [edgeKey(e), e]));
  const addedEdges = after.edges.filter((e) => !beforeEdges.has(edgeKey(e)));
  const removedEdges = before.edges.filter((e) => !afterEdges.has(edgeKey(e)));
  if (addedEdges.length > 0 || removedEdges.length > 0) semanticChange = true;

  const layoutOnly =
    addedNodes.length === 0 &&
    removedNodes.length === 0 &&
    addedEdges.length === 0 &&
    removedEdges.length === 0 &&
    !semanticChange &&
    changedNodes.length > 0;

  return { addedNodes, removedNodes, changedNodes, addedEdges, removedEdges, layoutOnly };
}

/** 差异是否为空。 */
export function isDiffEmpty(d: GraphDiff): boolean {
  return (
    d.addedNodes.length === 0 &&
    d.removedNodes.length === 0 &&
    d.changedNodes.length === 0 &&
    d.addedEdges.length === 0 &&
    d.removedEdges.length === 0
  );
}

export function newSnapshotId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `s-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}
