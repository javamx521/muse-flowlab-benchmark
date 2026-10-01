/**
 * 计算 Worker：节点纯函数在此线程执行。
 * 注意：此文件不得引用 DOM / window，只能用引擎纯模块。
 */
import { getNodeDef } from './nodes';
import type { ExecuteRequest, ExecuteResponse } from './executor';

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as { type: string; seq: number; req: ExecuteRequest };
  if (msg.type !== 'execute') return;
  const { seq, req } = msg;
  const started = Date.now();
  const respond = (resp: ExecuteResponse) => {
    (self as unknown as { postMessage: (m: unknown) => void }).postMessage({ type: 'result', seq, resp });
  };
  try {
    const def = getNodeDef(req.kind);
    const table = def.execute(req.params, req.inputs);
    respond({ runId: req.runId, nodeId: req.nodeId, ok: true, table, durationMs: Date.now() - started });
  } catch (err) {
    respond({
      runId: req.runId,
      nodeId: req.nodeId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    });
  }
};
