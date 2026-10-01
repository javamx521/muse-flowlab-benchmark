/**
 * 运行编排（任务书 F04）:
 * - 图编辑模型与运行实例分离：start() 时固定 graph 快照与 revision；
 * - 每次运行分配 runId；节点状态机 pending → running → ok/failed/cancelled/skipped；
 * - 取消是真实的：backend.cancel() 终止实际任务；迟到消息按 runId 丢弃；
 * - 运行期间编辑画布不影响正在进行的计算（执行器持有启动时的图快照）。
 */
import type {
  DataTable,
  NodeInstance,
  NodeRunInfo,
  RunRecord,
  WorkflowGraph,
} from './types';
import { getNodeDef, normalizeOutputs, primaryOutputPort } from './nodes';
import { topoSort, upstreamNodeIds, canRun } from './graph';

export interface ExecuteRequest {
  runId: string;
  nodeId: string;
  nodeName: string;
  kind: string;
  params: Record<string, unknown>;
  inputs: Record<string, DataTable>;
}

export interface ExecuteResponse {
  runId: string;
  nodeId: string;
  ok: boolean;
  /** 主输出表（向后兼容；单输出节点用）。 */
  table?: DataTable;
  /** 全端口输出（多输出节点用；优先于 table）。 */
  tables?: Record<string, DataTable>;
  error?: string;
  durationMs: number;
}

/** 执行后端：浏览器用 WorkerBackend，单元测试用 LocalBackend。 */
export interface ExecutorBackend {
  execute(req: ExecuteRequest): Promise<ExecuteResponse>;
  /** 真实取消正在执行的任务。 */
  cancel(): void;
  dispose(): void;
}

/** 本地同步后端（单元测试 / 非浏览器环境）。 */
export class LocalBackend implements ExecutorBackend {
  private cancelled = false;

  async execute(req: ExecuteRequest): Promise<ExecuteResponse> {
    const started = Date.now();
    if (this.cancelled) {
      return { runId: req.runId, nodeId: req.nodeId, ok: false, error: '已取消', durationMs: 0 };
    }
    try {
      const def = getNodeDef(req.kind);
      const tables = normalizeOutputs(def, def.execute(req.params, req.inputs));
      return { runId: req.runId, nodeId: req.nodeId, ok: true, tables, durationMs: Date.now() - started };
    } catch (err) {
      return {
        runId: req.runId,
        nodeId: req.nodeId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      };
    }
  }

  cancel(): void {
    this.cancelled = true;
  }

  dispose(): void {
    this.cancelled = true;
  }
}

export interface RunCallbacks {
  onNodeState?: (nodeId: string, info: NodeRunInfo) => void;
  onRunEnd?: (record: RunRecord) => void;
  /** 调试模式暂停时触发（节点执行前）。 */
  onDebugPause?: (nodeId: string) => void;
}

export interface RunOptions {
  /** 调试模式：确定性单并发 + 支持断点/单步/暂停/继续。 */
  debug?: boolean;
}

let runSeq = 0;

export function newRunId(): string {
  runSeq += 1;
  return `run_${Date.now().toString(36)}_${runSeq}`;
}

/** 单次运行的编排器。 */
export class RunManager {
  private currentRunId: string | null = null;
  private cancelled = false;
  // 调试模式状态（F04）
  private debug = false;
  private debugWaiter: { resolve: () => void } | null = null;
  private stepOnce = false;
  private pauseRequested = false;

  constructor(
    private backend: ExecutorBackend,
    private callbacks: RunCallbacks = {},
  ) {}

  get runningRunId(): string | null {
    return this.currentRunId;
  }

  /** 是否处于调试暂停中。 */
  get debugPaused(): boolean {
    return this.debugWaiter !== null;
  }

  /** 取消当前运行：终止实际任务，节点标记为 cancelled。 */
  cancel(): void {
    if (!this.currentRunId) return;
    this.cancelled = true;
    // 调试暂停中取消：先放行等待，避免死锁
    this.debugWaiter?.resolve();
    this.debugWaiter = null;
    this.backend.cancel();
  }

  /** 调试：请求在下一个节点边界暂停。 */
  pauseDebug(): void {
    this.pauseRequested = true;
  }

  /** 调试：继续执行，直到下一个断点。 */
  resumeDebug(): void {
    this.stepOnce = false;
    this.debugWaiter?.resolve();
    this.debugWaiter = null;
  }

  /** 调试：单步执行一个节点后再次暂停。 */
  stepDebug(): void {
    this.stepOnce = true;
    this.debugWaiter?.resolve();
    this.debugWaiter = null;
  }

  /** 调试暂停检查：返回 true 表示本次应在节点执行前暂停。 */
  private shouldDebugPause(node: NodeInstance): boolean {
    if (!this.debug) return false;
    if (this.pauseRequested) {
      this.pauseRequested = false;
      return true;
    }
    if (this.stepOnce) {
      this.stepOnce = false;
      return true;
    }
    return node.breakpoint === true;
  }

  async start(graph: WorkflowGraph, opts: RunOptions = {}): Promise<RunRecord> {
    if (this.currentRunId) throw new Error('已有运行在进行中');
    this.debug = opts.debug === true;
    this.stepOnce = false;
    // start 前调用的 pauseDebug 应生效（不清）；非调试模式则清除残留
    if (!this.debug) this.pauseRequested = false;
    this.debugWaiter = null;

    const check = canRun(graph);
    if (!check.ok) {
      const first = check.issues.find((i) => i.severity === 'error');
      throw new Error(`图校验未通过: ${first?.message ?? '未知错误'}`);
    }
    const runId = newRunId();
    const revision = graph.revision;
    const startedAt = Date.now();
    // 固定启动时的图快照：运行期间编辑画布不影响本次计算
    const snapshot: WorkflowGraph = JSON.parse(JSON.stringify(graph)) as WorkflowGraph;

    const record: RunRecord = {
      runId,
      graphRevision: revision,
      startedAt,
      cancelled: false,
      nodeStates: {},
      outputs: {},
      portOutputs: {},
    };
    const nodeById = new Map<string, NodeInstance>(snapshot.nodes.map((n) => [n.id, n]));
    for (const n of snapshot.nodes) {
      record.nodeStates[n.id] = { status: 'pending', inputRows: 0, outputRows: 0, durationMs: 0 };
    }

    this.currentRunId = runId;
    this.cancelled = false;
    const emit = (nodeId: string, patch: Partial<NodeRunInfo>) => {
      const cur = record.nodeStates[nodeId];
      if (!cur) return;
      Object.assign(cur, patch);
      this.callbacks.onNodeState?.(nodeId, { ...cur });
    };

    const { order } = topoSort(snapshot);
    const failed = new Set<string>();

    try {
      for (const nodeId of order) {
        if (this.cancelled) {
          // 剩余节点标记为 cancelled
          for (const rest of order) {
            const st = record.nodeStates[rest];
            if (st && (st.status === 'pending' || st.status === 'running')) {
              emit(rest, { status: 'cancelled', finishedAt: Date.now() });
            }
          }
          record.cancelled = true;
          break;
        }
        const node = nodeById.get(nodeId);
        if (!node) continue;
        const upstreams = upstreamNodeIds(snapshot, nodeId);
        if (upstreams.some((u) => failed.has(u))) {
          failed.add(nodeId);
          emit(nodeId, { status: 'skipped', finishedAt: Date.now(), error: '上游节点失败，未执行' });
          continue;
        }
        const inputs: Record<string, DataTable> = {};
        let inputRows = 0;
        for (const edge of snapshot.edges.filter((e) => e.target === nodeId)) {
          const port = edge.targetPort ?? 'in';
          // 按源输出端口取表（branch 等多输出节点）
          const table = record.portOutputs[edge.source]?.[edge.sourcePort ?? 'out'];
          if (table) {
            inputs[port] = table;
            inputRows += table.rows.length;
          }
        }
        // 调试模式：节点边界暂停（断点 / 单步 / 外部暂停请求）
        if (this.shouldDebugPause(node)) {
          record.debugPausedAt = nodeId;
          emit(nodeId, { status: 'pending', startedAt: Date.now() });
          this.callbacks.onDebugPause?.(nodeId);
          await new Promise<void>((resolve) => {
            this.debugWaiter = { resolve };
          });
          this.debugWaiter = null;
          record.debugPausedAt = undefined;
          if (this.cancelled || this.currentRunId !== runId) break;
        }
        emit(nodeId, { status: 'running', inputRows, startedAt: Date.now() });
        const t0 = Date.now();
        const resp = await this.backend.execute({
          runId,
          nodeId,
          nodeName: node.name,
          kind: node.kind,
          params: node.params,
          inputs,
        });
        // 迟到/取消后的响应不得写入新状态
        if (this.currentRunId !== runId) break;
        if (this.cancelled || resp.error === '已取消') {
          failed.add(nodeId);
          record.cancelled = true;
          emit(nodeId, { status: 'cancelled', durationMs: Date.now() - t0, finishedAt: Date.now() });
          continue;
        }
        if (!resp.ok || (!resp.tables && !resp.table)) {
          failed.add(nodeId);
          emit(nodeId, {
            status: 'failed',
            durationMs: resp.durationMs,
            finishedAt: Date.now(),
            error: resp.error ?? '未知错误',
          });
          continue;
        }
        // 归一化多端口输出：portOutputs 存全端口，outputs 存主输出（向后兼容）
        const def = getNodeDef(node.kind);
        const tables = resp.tables ?? (resp.table ? { [primaryOutputPort(def)]: resp.table } : {});
        record.portOutputs[nodeId] = tables;
        const primary = tables[primaryOutputPort(def)];
        if (primary) record.outputs[nodeId] = primary;
        emit(nodeId, {
          status: 'ok',
          outputRows: primary?.rows.length ?? 0,
          durationMs: resp.durationMs,
          finishedAt: Date.now(),
        });
      }
    } finally {
      this.currentRunId = null;
    }

    record.finishedAt = Date.now();
    this.callbacks.onRunEnd?.(record);
    return record;
  }

  dispose(): void {
    this.backend.dispose();
    this.currentRunId = null;
  }
}
