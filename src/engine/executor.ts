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
import { getNodeDef } from './nodes';
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
  table?: DataTable;
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
      const table = def.execute(req.params, req.inputs);
      return { runId: req.runId, nodeId: req.nodeId, ok: true, table, durationMs: Date.now() - started };
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

  constructor(
    private backend: ExecutorBackend,
    private callbacks: RunCallbacks = {},
  ) {}

  get runningRunId(): string | null {
    return this.currentRunId;
  }

  /** 取消当前运行：终止实际任务，节点标记为 cancelled。 */
  cancel(): void {
    if (!this.currentRunId) return;
    this.cancelled = true;
    this.backend.cancel();
  }

  async start(graph: WorkflowGraph, opts: { debug?: boolean } = {}): Promise<RunRecord> {
    if (this.currentRunId) throw new Error('已有运行在进行中');
    void opts;

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
          const table = record.outputs[edge.source];
          if (table) {
            inputs[port] = table;
            inputRows += table.rows.length;
          }
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
        if (!resp.ok || !resp.table) {
          failed.add(nodeId);
          emit(nodeId, {
            status: 'failed',
            durationMs: resp.durationMs,
            finishedAt: Date.now(),
            error: resp.error ?? '未知错误',
          });
          continue;
        }
        record.outputs[nodeId] = resp.table;
        emit(nodeId, {
          status: 'ok',
          outputRows: resp.table.rows.length,
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
