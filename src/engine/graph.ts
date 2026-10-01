/**
 * 图算法（任务书 F03/F04）:
 * - 拓扑排序（Kahn 算法，确定性: 按节点 id 排序保证稳定顺序）；
 * - 环检测（含环路径报告）；
 * - 图校验: 缺失输入、悬空边、重复连线、表达式字段引用、输出节点等，
 *   返回可跳转到节点的 GraphIssue 列表。
 */
import type { Edge, GraphIssue, NodeInstance, WorkflowGraph } from './types';
import { getNodeDef, parseAggregations, parseNameList, parseSortKeys } from './nodes';
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

/** 按目标端口找上游节点 id（无连线时返回 null）。 */
function upstreamByPort(graph: WorkflowGraph, nodeId: string, port: string): string | null {
  const e = graph.edges.find((e) => e.target === nodeId && (e.targetPort ?? 'in') === port);
  return e ? e.source : null;
}

/**
 * 静态推断节点的输出列（F03：运行前识别失效字段引用）。
 * 覆盖全部 16 种节点与多输入端口；尽力而为，无法确定时返回 null
 * （此时不做字段存在性校验，错误由运行时报告）。
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

  // 无输入的源节点
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
  if (node.kind === 'json-input') {
    const text = node.params['jsonText'];
    if (typeof text !== 'string' || text.trim() === '') return null;
    try {
      const data: unknown = JSON.parse(text);
      const arr: unknown[] = Array.isArray(data) ? data : [data];
      const cols: string[] = [];
      for (const item of arr) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
        for (const k of Object.keys(item as Record<string, unknown>)) {
          if (!cols.includes(k)) cols.push(k);
        }
      }
      return cols.length > 0 ? cols : null;
    } catch {
      return null;
    }
  }
  if (node.kind === 'synthetic-input') {
    try {
      const cols = parseNameList(node.params['columns'], '合成数据');
      return cols.length > 0 ? cols : null;
    } catch {
      return null;
    }
  }

  // 单/双输入节点的上游列
  const inPort = def.inputs[0] ?? 'in';
  const upId = upstreamByPort(graph, nodeId, inPort);
  const upCols = upId ? inferOutputColumns(graph, upId, seen) : null;

  switch (node.kind) {
    case 'computed-column': {
      if (!upCols) return null;
      const col = node.params['column'];
      if (typeof col === 'string' && col !== '' && !upCols.includes(col)) return [...upCols, col];
      return upCols;
    }
    case 'select-columns': {
      if (!upCols) return null;
      try {
        const picked = parseNameList(node.params['columns'], '字段选择');
        const cols = picked.length > 0 ? picked : [...upCols];
        if (cols.some((c) => !upCols.includes(c))) return null;
        const renames = new Map<string, string>();
        const raw = node.params['renames'];
        if (typeof raw === 'string' && raw.trim() !== '') {
          for (const line of raw.split('\n')) {
            const t = line.trim();
            if (t === '') continue;
            const idx = t.indexOf(':');
            if (idx < 0) return null;
            const from = t.slice(0, idx).trim();
            const to = t.slice(idx + 1).trim();
            if (from === '' || to === '' || !upCols.includes(from)) return null;
            renames.set(from, to);
          }
        }
        const out = cols.map((c) => renames.get(c) ?? c);
        return new Set(out).size === out.length ? out : null;
      } catch {
        return null;
      }
    }
    case 'aggregate': {
      try {
        const groupBy = parseNameList(node.params['groupBy'], '分组聚合');
        const aggs = typeof node.params['aggregations'] === 'string' ? parseAggregations(node.params['aggregations']) : null;
        if (!aggs) return null;
        if (upCols && [...groupBy, ...aggs.filter((a) => a.field !== '*').map((a) => a.field)].some((c) => !upCols.includes(c))) {
          return null;
        }
        return [...groupBy, ...aggs.map((a) => a.outCol)];
      } catch {
        return null;
      }
    }
    case 'chart':
      return ['x', 'y'];
    case 'branch':
      return upCols;
    case 'join': {
      const rightId = upstreamByPort(graph, nodeId, 'in2');
      const rightCols = rightId ? inferOutputColumns(graph, rightId, seen) : null;
      if (!upCols || !rightCols) return null;
      try {
        const keys = parseNameList(node.params['keys'], '表关联');
        if (keys.length === 0 || keys.some((k) => !upCols.includes(k) || !rightCols.includes(k))) return null;
        const out = [...upCols];
        for (const c of rightCols) {
          if (keys.includes(c)) continue;
          out.push(out.includes(c) ? `${c}_right` : c);
        }
        return out;
      } catch {
        return null;
      }
    }
    case 'union': {
      // 结构兼容时输出左表列；不兼容由校验报告
      return upCols;
    }
    default:
      // filter / sort / dedupe / limit / assert / output：沿用输入列
      return upCols;
  }
}

/**
 * 推断节点的输入列。
 * @param port 目标输入端口（缺省为节点的首个输入端口；join 可传 'in2' 取右表列）。
 */
export function inferInputColumns(graph: WorkflowGraph, nodeId: string, port?: string): string[] | null {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  let def;
  try {
    def = getNodeDef(node.kind);
  } catch {
    return null;
  }
  const wantPort = port ?? def.inputs[0] ?? 'in';
  const upId = upstreamByPort(graph, nodeId, wantPort);
  if (!upId) return null;
  return inferOutputColumns(graph, upId);
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
    // 非法输入端口
    for (const e of incoming) {
      const p = e.targetPort ?? 'in';
      if (!def.inputs.includes(p)) {
        issues.push({ nodeId: node.id, severity: 'error', message: `非法的输入端口 ${p}（可用: ${def.inputs.join(', ') || '无'}）` });
      }
    }
    // 多条连线占用同一单连接输入端口（F02）
    const portCount = new Map<string, number>();
    for (const e of incoming) {
      const p = e.targetPort ?? 'in';
      portCount.set(p, (portCount.get(p) ?? 0) + 1);
    }
    for (const [p, c] of portCount) {
      if (c > 1) {
        issues.push({ nodeId: node.id, severity: 'error', message: `输入端口 ${p} 被 ${c} 条连线占用（每端口只允许一条）` });
      }
    }
    // 非法输出端口（检查本节点作为源的边）
    for (const e of graph.edges.filter((x) => x.source === node.id)) {
      const sp = e.sourcePort ?? 'out';
      if (!def.outputs.includes(sp)) {
        issues.push({ nodeId: node.id, severity: 'error', message: `非法的输出端口 ${sp}（可用: ${def.outputs.join(', ')}）` });
      }
    }
    // 结果节点是终端节点（F02）
    if ((node.kind === 'output' || node.kind === 'chart') && graph.edges.some((x) => x.source === node.id)) {
      issues.push({ nodeId: node.id, severity: 'warning', message: '结果节点不应连接下游' });
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
          const exprInputCols = inferInputColumns(graph, node.id);
          if (exprInputCols) {
            const missing = missingFields(expr, exprInputCols);
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

    // 结构化参数的字段引用检查（列可静态推断时）
    const inputCols = inferInputColumns(graph, node.id);
    if (inputCols) {
      const checkFields = (fields: string[], label: string) => {
        const missing = fields.filter((f) => !inputCols.includes(f));
        if (missing.length > 0) {
          issues.push({ nodeId: node.id, severity: 'error', message: `${label}引用了不存在的字段: ${missing.join(', ')}` });
        }
      };
      try {
        if (node.kind === 'select-columns') {
          const picked = parseNameList(node.params['columns'], '字段选择');
          if (picked.length > 0) checkFields(picked, '字段选择');
        } else if (node.kind === 'sort') {
          const raw = node.params['sortKeys'];
          if (typeof raw === 'string' && raw.trim() !== '') {
            checkFields(parseSortKeys(raw).map((k) => k.field), '排序');
          }
        } else if (node.kind === 'aggregate') {
          const groupBy = parseNameList(node.params['groupBy'], '分组聚合');
          if (groupBy.length > 0) checkFields(groupBy, '分组字段');
          const raw = node.params['aggregations'];
          if (typeof raw === 'string' && raw.trim() !== '') {
            const fields = parseAggregations(raw)
              .map((a) => a.field)
              .filter((f) => f !== '*');
            if (fields.length > 0) checkFields(fields, '聚合');
          }
        } else if (node.kind === 'chart') {
          const xc = node.params['xColumn'];
          const yc = node.params['yColumn'];
          const fields = [xc, yc].filter((f): f is string => typeof f === 'string' && f !== '');
          if (fields.length > 0) checkFields(fields, '图表');
        }
      } catch {
        // 解析失败由运行时报错，静态校验不重复报告
      }
      // join：关联键需在左右输入中都存在
      if (node.kind === 'join') {
        const leftCols = inferInputColumns(graph, node.id, 'in');
        const rightCols = inferInputColumns(graph, node.id, 'in2');
        try {
          const keys = parseNameList(node.params['keys'], '表关联');
          if (leftCols) {
            const missing = keys.filter((k) => !leftCols.includes(k));
            if (missing.length > 0) issues.push({ nodeId: node.id, severity: 'error', message: `关联键在左表不存在: ${missing.join(', ')}` });
          }
          if (rightCols) {
            const missing = keys.filter((k) => !rightCols.includes(k));
            if (missing.length > 0) issues.push({ nodeId: node.id, severity: 'error', message: `关联键在右表不存在: ${missing.join(', ')}` });
          }
        } catch {
          // 运行时报错
        }
      }
      // union：两表列集合必须一致（F03 合并结构不兼容运行前识别）
      if (node.kind === 'union') {
        const leftCols = inferInputColumns(graph, node.id, 'in');
        const rightCols = inferInputColumns(graph, node.id, 'in2');
        if (leftCols && rightCols) {
          const sl = new Set(leftCols);
          const sr = new Set(rightCols);
          if (sl.size !== sr.size || [...sl].some((c) => !sr.has(c))) {
            issues.push({
              nodeId: node.id,
              severity: 'error',
              message: `合并结构不兼容（左表列: ${leftCols.join(', ') || '（空）'}；右表列: ${rightCols.join(', ') || '（空）'}）`,
            });
          }
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
