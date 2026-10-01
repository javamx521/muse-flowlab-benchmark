/**
 * 语义级撤销/重做（F06）。
 *
 * 设计：
 * - 图快照栈：每次语义编辑前压入当前 WorkflowGraph；reducer 保证图不可变，
 *   因此直接存引用是安全的（不做深拷贝，避免大数据图卡顿）。
 * - 至少 100 步：上限 MAX_HISTORY=100，超限丢弃最旧。
 * - 一次连续拖拽 = 一条历史：调用方传入 coalesceKey（拖拽会话 id），
 *   相同 key 的连续 push 合并为一条。
 * - 新编辑清空 redo 分支；纯选择/视口/运行/日志不经过这里。
 */
import type { WorkflowGraph } from '../engine/types';

export const MAX_HISTORY = 100;

export interface HistoryEntry {
  graph: WorkflowGraph;
  label: string;
  at: number;
  coalesceKey: string | null;
}

export class UndoHistory {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];

  constructor(private readonly max: number = MAX_HISTORY) {}

  /**
   * 记录一次语义编辑。coalesceKey 相同时与上一条合并（连续拖拽/连续键入）。
   * maxAgeMs：合并的时间窗口（毫秒）；null 表示不限制（如拖拽会话内）。
   */
  push(graph: WorkflowGraph, label: string, coalesceKey: string | null = null, maxAgeMs: number | null = null): void {
    const now = Date.now();
    const last = this.past[this.past.length - 1];
    if (
      coalesceKey !== null &&
      last !== undefined &&
      last.coalesceKey === coalesceKey &&
      (maxAgeMs === null || now - last.at < maxAgeMs)
    ) {
      return; // 合并，不新增
    }
    this.past.push({ graph, label, at: now, coalesceKey });
    if (this.past.length > this.max) this.past.splice(0, this.past.length - this.max);
    // 新编辑清空 redo 分支（F06）
    this.future = [];
  }

  /** 撤销：返回上一步的图；无历史时返回 null。 */
  undo(current: WorkflowGraph): WorkflowGraph | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push({ graph: current, label: 'redo', at: Date.now(), coalesceKey: null });
    return prev.graph;
  }

  /** 重做：返回下一步的图；无未来时返回 null。 */
  redo(current: WorkflowGraph): WorkflowGraph | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push({ graph: current, label: 'undo', at: Date.now(), coalesceKey: null });
    return next.graph;
  }

  /** 切换项目/加载新文档时清空。 */
  clear(): void {
    this.past = [];
    this.future = [];
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get undoDepth(): number {
    return this.past.length;
  }

  get redoDepth(): number {
    return this.future.length;
  }
}
