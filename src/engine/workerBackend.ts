/**
 * Web Worker 执行后端（浏览器专用）。
 * CPU 密集计算在 Worker 内完成；取消时 terminate 并重建，迟到消息按 runId 丢弃。
 * 单元测试环境无 Worker，此文件由 E2E 真实浏览器覆盖（见 docs/REQUIREMENTS.md）。
 */
import type { ExecuteRequest, ExecuteResponse, ExecutorBackend } from './executor';

/** Web Worker 后端：CPU 密集计算在 Worker 内完成；取消时 terminate 重建。 */
export class WorkerBackend implements ExecutorBackend {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, (r: ExecuteResponse) => void>();
  private activeRunId: string | null = null;

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent) => {
        const msg = ev.data as { type: string; seq: number; resp: ExecuteResponse };
        if (msg.type !== 'result') return;
        const resolve = this.pending.get(msg.seq);
        if (resolve) {
          this.pending.delete(msg.seq);
          resolve(msg.resp);
        }
      };
      this.worker.onerror = (ev) => {
        // Worker 崩溃：让所有等待中的请求失败，而不是无限挂起
        const err = `Worker 错误: ${ev.message}`;
        for (const [, resolve] of this.pending) {
          resolve({ runId: this.activeRunId ?? '', nodeId: '', ok: false, error: err, durationMs: 0 });
        }
        this.pending.clear();
      };
    }
    return this.worker;
  }

  async execute(req: ExecuteRequest): Promise<ExecuteResponse> {
    const worker = this.ensureWorker();
    this.activeRunId = req.runId;
    const seq = ++this.seq;
    return new Promise<ExecuteResponse>((resolve) => {
      this.pending.set(seq, (resp) => {
        // 迟到消息（旧 runId）不得污染新运行
        if (resp.runId !== this.activeRunId) return;
        resolve(resp);
      });
      worker.postMessage({ type: 'execute', seq, req });
    });
  }

  cancel(): void {
    // 真实终止：旧 Worker 销毁，迟到消息随 pending 清空而丢弃
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const [, resolve] of this.pending) {
      resolve({ runId: this.activeRunId ?? '', nodeId: '', ok: false, error: '已取消', durationMs: 0 });
    }
    this.pending.clear();
    this.activeRunId = null;
  }

  dispose(): void {
    this.cancel();
  }
}

