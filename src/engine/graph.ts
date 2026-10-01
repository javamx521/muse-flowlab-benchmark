/**
 * 图算法（任务书 F03/F04）:
 * - 拓扑排序（Kahn 算法，确定性: 按节点 id 排序保证稳定顺序）；
 * - 环检测（含环路径报告）；
 * - 图校验: 缺失输入、悬空边、重复连线、表达式字段引用、输出节点等，
 *   返回可跳转到节点的 GraphIssue 列表。
 */
import type { Edge, GraphIssue, NodeInstance, WorkflowGraph } from './types';
import { getNodeDef } from './nodes';
import { compileExpr, missingFields, ExprError } from './expressions';
import { parseCsv } from './csv';

export interface TopoResult {
  order: string[];
  /** 环存在时非空: 环上的节点 id 序列。 */
  cycle: string[];
}

export function topoSort(graph: WorkflowGraph): TopoResult {
  const nodeIds = graph.nodes.map((n) => n.id).sort();
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) {
    indegree.set(id, 0);
    adj.set(id, []);
  }
  // 去重边，避免重复连线影响入度
  const seen = new Set<string>();
  for (const e of graph.edges) {
    const key = `${e.source}>${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!indegree.has(e.source) || !indegree.has(e.target)) continue; // 悬空边由校验报告
    adj.get(e.source)!.push(e.target);
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }
  const queue: string[] = nodeIds.filter((id) => (indegree.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    queue.sort();
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (order.length !== nodeIds.length) {
    return { order, cycle: findCycle(graph, nodeIds) };
  }
  return { order, cycle: [] };
}

/** DFS 找一条环路径（用于错误提示）。 */
function findCycle(graph: WorkflowGraph, nodeIds: string[]): string[] {
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of graph.edges) {
    if (adj.has(e.source) && adj.has(e.target)) adj.get(e.source)!.push(e.target);
  }
  const color = new Map<string, 0 | 1 | 2>(); // 0 未访问 1 栈中 2 完成
  const stack: string[] = [];
  const dfs = (id: string): string[] | null => {
    color.set(id, 1);
    stack.push(id);
    for (const next of (adj.get(id) ?? []).sort()) {
      const c = color.get(next) ?? 0;
      if (c === 1) {
        const idx = stack.indexOf(next);
        return [...stack.slice(idx), next];
      }
      if (c === 0) {
        const r = dfs(next);
        if (r) return r;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };
  for (const id of nodeIds) {
    if ((color.get(id) ?? 0) === 0) {
      const r = dfs(id);
      if (r) return r;
    }
  }
  return [];
}

/** 取节点的输入边（按端口分组）。 */
export function incomingEdges(graph: WorkflowGraph, nodeId: string): Edge[] {
  return graph.edges.filter((e) => e.target === nodeId);
}

/** 取节点的上游节点 id 列表（去重、排序）。 */
export function upstreamNodeIds(graph: WorkflowGraph, nodeId: string): string[] {
  const ids = new Set<string>();
  for (const e of graph.edges) if (e.target === nodeId) ids.add(e.source);
  return [...ids].sort();
}

/**
 * 静态推断节点的输出列（F03：运行前识别失效字段引用）。
 * 尽力而为：csv-input 解析表头；单输入变换节点沿用上游列；computed-column 追加目标列。
 * 无法确定时返回 null（此时不做字段存在性校验，错误由运行时报告）。
 * M2 扩展到全部 16 种节点与多输入端口。
 */
export function inferOutputColumns(graph: WorkflowGraph, nodeId: string, seen: Set<string> = new Set()): string[] | null {
  if (seen.has(nodeId)) return null; // 环保护
  seen.add(nodeId);
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  let def;
  try {
    def = getNodeDef(node.kind);
  } catch {
    return null;
  }
  void def;
  if (node.kind === 'csv-input') {
    const text = node.params['csvText'];
    if (typeof text !== 'string' || text.trim() === '') return null;
    try {
      const { headers } = parseCsv(text);
      return headers.length > 0 ? headers : null;
    } catch {
      return null;
    }
  }
  const ups = upstreamNodeIds(graph, nodeId);
  if (ups.length === 0) return null;
  const first = ups[0];
  if (first === undefined) return null;
  const upCols = inferOutputColumns(graph, first, seen);
  if (!upCols) return null;
  if (node.kind === 'computed-column') {
    const col = node.params['column'];
    if (typeof col === 'string' && col !== '' && !upCols.includes(col)) return [...upCols, col];
  }
  return upCols;
}

/** 推断节点的输入列（单输入节点 = 上游输出列）。 */
export function inferInputColumns(graph: WorkflowGraph, nodeId: string): string[] | null {
  const ups = upstreamNodeIds(graph, nodeId);
  const first = ups[0];
  if (first === undefined) return null;
  return inferOutputColumns(graph, first);
}

/** 校验整图，返回问题列表（运行前调用，F03）。 */
export function validateGraph(graph: WorkflowGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const nodeById = new Map<string, NodeInstance>(graph.nodes.map((n) => [n.id, n]));

  // 悬空边
  for (const e of graph.edges) {
    if (!nodeById.has(e.source)) {
      issues.push({ nodeId: e.target, severity: 'error', message: `连线 ${e.id} 的源节点不存在` });
    }
    if (!nodeById.has(e.target)) {
      issues.push({ nodeId: e.source, severity: 'error', message: `连线 ${e.id} 的目标节点不存在` });
    }
  }

  // 环
  const { cycle } = topoSort(graph);
  const cycleHead = cycle[0];
  if (cycle.length > 0 && cycleHead !== undefined) {
    issues.push({
      nodeId: cycleHead,
      severity: 'error',
      message: `图中存在环: ${cycle.map((id) => nodeById.get(id)?.name ?? id).join(' → ')}`,
    });
  }

  // 重复连线（同源同目标同端口）
  const edgeKeys = new Map<string, number>();
  for (const e of graph.edges) {
    const key = `${e.source}>${e.target}#${e.targetPort ?? 'in'}`;
    edgeKeys.set(key, (edgeKeys.get(key) ?? 0) + 1);
  }
  for (const e of graph.edges) {
    const key = `${e.source}>${e.target}#${e.targetPort ?? 'in'}`;
    if ((edgeKeys.get(key) ?? 0) > 1) {
      issues.push({ nodeId: e.target, severity: 'warning', message: `存在重复连线（${nodeById.get(e.source)?.name ?? e.source} → 此节点）` });
      break;
    }
  }

  // 逐节点校验
  for (const node of graph.nodes) {
    let def;
    try {
      def = getNodeDef(node.kind);
    } catch {
      issues.push({ nodeId: node.id, severity: 'error', message: `未知节点类型: ${node.kind}` });
      continue;
    }
    const incoming = incomingEdges(graph, node.id);

    // 必需输入缺失
    for (const port of def.inputs) {
      if (!incoming.some((e) => (e.targetPort ?? 'in') === port)) {
        issues.push({ nodeId: node.id, severity: 'error', message: `缺少输入连线（端口 ${port}）` });
      }
    }
    // 输入节点不应有输入连线
    if (def.inputs.length === 0 && incoming.length > 0) {
      issues.push({ nodeId: node.id, severity: 'warning', message: '输入节点不应连接上游' });
    }

    // 必填参数
    for (const p of def.params) {
      const v = node.params[p.key];
      if (p.required && (v === undefined || v === null || (typeof v === 'string' && v.trim() === ''))) {
        issues.push({ nodeId: node.id, severity: 'error', field: p.key, message: `参数「${p.label}」不能为空` });
      }
    }

    // 表达式检查：语法 +（列可静态推断时）字段存在性
    for (const p of def.params) {
      if (p.type === 'expression' && typeof node.params[p.key] === 'string') {
        const src = (node.params[p.key] as string).trim();
        if (src === '') continue;
        try {
          const expr = compileExpr(src);
          const inputCols = inferInputColumns(graph, node.id);
          if (inputCols) {
            const missing = missingFields(expr, inputCols);
            if (missing.length > 0) {
              issues.push({
                nodeId: node.id,
                severity: 'error',
                field: p.key,
                message: `表达式引用了不存在的字段: ${missing.map((m) => '$' + m).join(', ')}`,
              });
            }
          }
        } catch (err) {
          issues.push({
            nodeId: node.id,
            severity: 'error',
            field: p.key,
            message: `表达式错误: ${err instanceof ExprError ? err.message : String(err)}`,
          });
        }
      }
    }
  }

  return issues;
}

/** 图是否可运行（无 error 级别问题）。 */
export function canRun(graph: WorkflowGraph): { ok: boolean; issues: GraphIssue[] } {
  const issues = validateGraph(graph);
  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}
