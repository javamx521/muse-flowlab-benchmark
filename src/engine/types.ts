/**
 * FlowLab Studio 引擎核心类型。
 *
 * 数据单元格范围: string | number | boolean | null（见任务书 F03）。
 * number 必须是有限数；NaN / Infinity 不得进入数据表。
 */

export type CellValue = string | number | boolean | null;

/** 一行数据: 字段名 -> 单元格。 */
export type Row = Record<string, CellValue>;

/** 数据表: 列定义 + 行。列顺序固定。 */
export interface DataTable {
  columns: string[];
  rows: Row[];
  /** 数据版本: 输入数据变化时递增, 用于增量缓存键（M4）。 */
  dataVersion?: number;
}

/** 节点类型标识：16 种（F02）。 */
export type NodeKind =
  | 'csv-input'
  | 'json-input'
  | 'synthetic-input'
  | 'filter'
  | 'computed-column'
  | 'select-columns'
  | 'branch'
  | 'join'
  | 'union'
  | 'dedupe'
  | 'aggregate'
  | 'sort'
  | 'limit'
  | 'assert'
  | 'chart'
  | 'output';

export interface NodePosition {
  x: number;
  y: number;
}

/** 图上的一个节点实例。 */
export interface NodeInstance {
  id: string;
  kind: NodeKind;
  /** 用户可改的显示名。 */
  name: string;
  params: Record<string, unknown>;
  position: NodePosition;
  /** 调试断点（F04）：调试模式下运行到此节点前暂停。 */
  breakpoint?: boolean;
}

/**
 * 一条连线: 从 source 节点的输出端口到 target 节点的输入端口。
 * 单输出/单输入节点可省略端口（默认为 'out' / 'in'）。
 */
export interface Edge {
  id: string;
  source: string;
  target: string;
  /** 源输出端口（branch 等多输出节点用，如 'true'/'false'）。 */
  sourcePort?: string;
  /** 目标输入端口（join 等多输入节点用，如 'in'/'in2'）。 */
  targetPort?: string;
}

/** 工作流图。 */
export interface WorkflowGraph {
  nodes: NodeInstance[];
  edges: Edge[];
  /** 图修订号: 每次语义编辑递增, 用于运行隔离（F04）。 */
  revision: number;
}

/** 节点运行状态机（F04）。 */
export type NodeRunStatus =
  | 'pending'
  | 'running'
  | 'ok'
  | 'failed'
  | 'cancelled'
  | 'skipped'; // 因依赖失败而未执行

export interface NodeRunInfo {
  status: NodeRunStatus;
  /** 输入行数（按端口）。 */
  inputRows: number;
  outputRows: number;
  /** 执行耗时毫秒。 */
  durationMs: number;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

/** 一次运行的完整记录。 */
export interface RunRecord {
  runId: string;
  graphRevision: number;
  startedAt: number;
  finishedAt?: number;
  cancelled: boolean;
  nodeStates: Record<string, NodeRunInfo>;
  /**
   * 节点主输出快照（行数上限内）。
   * 单输出节点 = 唯一输出；branch = 'true' 端口（匹配表）。
   */
  outputs: Record<string, DataTable>;
  /** 全端口输出快照：nodeId -> port -> table（多输出/多输入调试用）。 */
  portOutputs: Record<string, Record<string, DataTable>>;
  /** 调试模式下当前暂停所在的节点 id（无暂停时缺省）。 */
  debugPausedAt?: string;
  /** 缓存命中证据（M4 填充）。 */
  cacheHits?: string[];
}

export const MAX_PREVIEW_ROWS = 500;

/** 图校验问题, 可跳转到节点（F03）。 */
export interface GraphIssue {
  nodeId: string;
  /** 字段级问题可附带字段名。 */
  field?: string;
  message: string;
  severity: 'error' | 'warning';
}

export function emptyTable(): DataTable {
  return { columns: [], rows: [] };
}

export function isNullish(v: CellValue): boolean {
  return v === null;
}
