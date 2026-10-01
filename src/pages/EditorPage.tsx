/**
 * 编辑器页面：工作台布局（M2）。
 * 左侧节点面板（按分组）/ 中央画布+小地图 / 右侧检查器+问题 / 底部结果面板 / 顶栏运行与调试控制。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Canvas, { NODE_W } from '../components/Canvas';
import Inspector from '../components/Inspector';
import DataTableView from '../components/DataTableView';
import ChartView from '../components/ChartView';
import { useEditor } from '../store/useEditor';
import { listNodeDefs, exportTableCsv, getNodeDef } from '../engine/nodes';
import { APP_VERSION } from '../lib/version';
import { projectStore } from '../lib/projects';
import type { NodeInstance, NodeKind, NodeRunStatus } from '../engine/types';

function downloadCsv(filename: string, text: string) {
  const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 小地图：全图缩略图 + 视口框。 */
function MiniMap(props: {
  nodes: NodeInstance[];
  viewport: { x: number; y: number; k: number };
  canvasW: number;
  canvasH: number;
}) {
  const { nodes, viewport, canvasW, canvasH } = props;
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + NODE_W);
    maxY = Math.max(maxY, n.position.y + 120);
  }
  const pad = 60;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  const mw = 168;
  const mh = 112;
  const k = Math.min(mw / (maxX - minX), mh / (maxY - minY));
  const ox = (mw - (maxX - minX) * k) / 2;
  const oy = (mh - (maxY - minY) * k) / 2;
  const tx = (x: number) => ox + (x - minX) * k;
  const ty = (y: number) => oy + (y - minY) * k;
  // 视口在世界坐标中的矩形
  const vx0 = -viewport.x / viewport.k;
  const vy0 = -viewport.y / viewport.k;
  const vx1 = (canvasW - viewport.x) / viewport.k;
  const vy1 = (canvasH - viewport.y) / viewport.k;
  return (
    <svg className="minimap" width={mw} height={mh} data-testid="minimap" aria-label="小地图">
      <rect x={0} y={0} width={mw} height={mh} className="minimap-bg" />
      {nodes.map((n) => (
        <rect key={n.id} x={tx(n.position.x)} y={ty(n.position.y)} width={NODE_W * k} height={90 * k} className="minimap-node" />
      ))}
      <rect
        x={tx(vx0)}
        y={ty(vy0)}
        width={(vx1 - vx0) * k}
        height={(vy1 - vy0) * k}
        className="minimap-viewport"
      />
    </svg>
  );
}

const CATEGORIES = ['输入', '变换', '输出'] as const;

export default function EditorPage() {
  const { id = '' } = useParams();
  const meta = projectStore.get(id);
  const { state, actions } = useEditor(id, undefined, meta?.name);
  const [tab, setTab] = useState<'output' | 'log'>('output');
  const [resultsOpen, setResultsOpen] = useState(true);
  const [placeSeq, setPlaceSeq] = useState(0);
  /** branch 等多输出节点的查看端口。 */
  const [viewPort, setViewPort] = useState<string | null>(null);
  const clipboardRef = useRef<ReturnType<typeof actions.copySelection>>(null);
  const canvasWrapRef = useRef<HTMLElement>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 });

  const doc = state.doc;
  const graph = doc?.graph ?? null;

  const nodeStatus = useMemo(() => {
    const m: Record<string, NodeRunStatus> = {};
    if (state.run) {
      for (const [nid, info] of Object.entries(state.run.nodeStates)) m[nid] = info.status;
    }
    return m;
  }, [state.run]);

  const breakpoints = useMemo(() => {
    const m: Record<string, boolean> = {};
    for (const n of graph?.nodes ?? []) if (n.breakpoint) m[n.id] = true;
    return m;
  }, [graph]);

  const selectedNode = useMemo(
    () => graph?.nodes.find((n) => n.id === state.selection[0]) ?? null,
    [graph, state.selection],
  );

  // 选中节点的输出：多输出节点可切换端口查看
  const selectedPorts = useMemo(() => {
    if (!selectedNode) return [];
    try {
      return getNodeDef(selectedNode.kind).outputs;
    } catch {
      return [];
    }
  }, [selectedNode]);
  const activePort = viewPort && selectedPorts.includes(viewPort) ? viewPort : (selectedPorts[0] ?? 'out');
  const selectedOutput = useMemo(() => {
    if (!state.run || !selectedNode) return null;
    const ports = state.run.portOutputs[selectedNode.id];
    if (ports && ports[activePort]) return ports[activePort]!;
    return state.run.outputs[selectedNode.id] ?? null;
  }, [state.run, selectedNode, activePort]);

  // 选中变化时重置端口选择
  useEffect(() => {
    setViewPort(null);
  }, [selectedNode?.id]);

  const errorIssues = state.issues.filter((i) => i.severity === 'error');
  const stale = state.run && doc && state.run.graphRevision !== doc.graph.revision;
  const isChart = selectedNode?.kind === 'chart';

  // 画布尺寸（小地图用）
  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setCanvasSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setCanvasSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // 快捷键：Delete 删除；Ctrl+C / Ctrl+V 复制粘贴
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection.length > 0) {
        e.preventDefault();
        actions.deleteSelection();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && state.selection.length > 0) {
        e.preventDefault();
        clipboardRef.current = actions.copySelection();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && clipboardRef.current) {
        e.preventDefault();
        actions.paste(clipboardRef.current.nodes, clipboardRef.current.edges);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selection]);

  // 参数/结构变化后刷新校验
  useEffect(() => {
    if (doc) actions.refreshIssues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.graph.revision, doc?.graph.nodes.length, doc?.graph.edges.length]);

  if (state.loading) return <div className="page"><p>加载中…</p></div>;
  if (state.loadError) return <div className="page"><p role="alert">加载失败：{state.loadError}</p></div>;
  if (!meta) {
    return (
      <main className="page">
        <h1>项目不存在</h1>
        <p>找不到该项目，它可能已被删除。深链接不会把项目数据同步到其他设备。</p>
        <Link to="/">返回项目列表</Link>
      </main>
    );
  }
  if (!doc || !graph) return <div className="page"><p>项目不存在。</p></div>;

  const addNode = (kind: NodeKind) => {
    const i = placeSeq;
    setPlaceSeq(i + 1);
    const col = i % 2;
    const row = Math.floor(i / 2) % 6;
    const baseX = Math.max(20, (-state.viewport.x + 120) / state.viewport.k) + col * 260;
    const baseY = Math.max(20, (-state.viewport.y + 60) / state.viewport.k) + row * 110;
    actions.addNode(kind, baseX, baseY);
  };

  const defs = listNodeDefs();
  const paused = state.debugPausedAt !== null;

  return (
    <div className="editor">
      <header className="topbar">
        <Link to="/" className="back">← 项目</Link>
        <strong data-testid="project-name">{doc.name}</strong>
        <span className="muted small" data-testid="save-status">
          {state.saveStatus === 'saved' && '已保存'}
          {state.saveStatus === 'saving' && '保存中…'}
          {state.saveStatus === 'error' && '保存失败'}
          {state.saveStatus === 'idle' && ''}
        </span>
        <span className="muted small">修订 r{graph.revision}</span>
        <div className="spacer" />
        <label className="debug-toggle" title="调试模式：单并发 + 断点/单步/暂停">
          <input
            data-testid="debug-toggle"
            type="checkbox"
            checked={state.debugMode}
            disabled={state.running}
            onChange={(e) => actions.setDebugMode(e.target.checked)}
          />{' '}
          调试
        </label>
        {!state.running ? (
          <button
            data-testid="run-btn"
            onClick={() => actions.run()}
            disabled={errorIssues.length > 0}
            title={errorIssues.length > 0 ? '存在校验错误，无法运行' : state.debugMode ? '以调试模式运行' : '运行工作流'}
          >
            {state.debugMode ? '调试运行' : '运行'}
          </button>
        ) : (
          <>
            <span className="muted small">运行中…</span>
            {state.debugMode && !paused && (
              <button data-testid="debug-pause-btn" onClick={() => actions.pauseDebug()} title="在下一个节点边界暂停">
                暂停
              </button>
            )}
            {paused && (
              <>
                <button data-testid="debug-resume-btn" onClick={() => actions.resumeDebug()} title="继续到下一个断点">
                  继续
                </button>
                <button data-testid="debug-step-btn" onClick={() => actions.stepDebug()} title="单步执行一个节点">
                  单步
                </button>
              </>
            )}
            <button data-testid="cancel-btn" onClick={() => actions.cancelRun()}>
              取消
            </button>
          </>
        )}
        {state.runHistory.length > 1 && (
          <select
            data-testid="run-history"
            value={state.run?.runId ?? ''}
            onChange={(e) => actions.selectRun(e.target.value || null)}
            title="运行快照：切换查看历史运行结果"
          >
            {state.runHistory.map((r) => (
              <option key={r.runId} value={r.runId}>
                {new Date(r.startedAt).toLocaleTimeString()} · r{r.graphRevision} · {r.cancelled ? '已取消' : '完成'}
              </option>
            ))}
          </select>
        )}
        <button
          data-testid="issues-btn"
          className={errorIssues.length > 0 ? 'danger' : undefined}
          onClick={() => setTab('log')}
          title="查看校验问题"
        >
          问题 {state.issues.length}
        </button>
      </header>

      <div className="workbench">
        <aside className="palette" aria-label="节点面板">
          <h3>添加节点</h3>
          {CATEGORIES.map((cat) => (
            <div key={cat} className="palette-group">
              <h4>{cat}</h4>
              {defs
                .filter((d) => d.category === cat)
                .map((d) => (
                  <button key={d.kind} data-testid={`add-${d.kind}`} onClick={() => addNode(d.kind)} title={d.description}>
                    + {d.title}
                  </button>
                ))}
            </div>
          ))}
          <div className="palette-tools">
            <button data-testid="auto-layout" onClick={() => actions.autoLayout()} title="按拓扑分层自动排列节点">
              自动布局
            </button>
          </div>
          <div className="palette-help">
            <p className="muted small">连线：从节点右侧端口拖到目标节点左侧端口。双击连线可删除。Delete 删除选中；Ctrl+C / Ctrl+V 复制粘贴。</p>
          </div>
        </aside>

        <main className="canvas-wrap" ref={canvasWrapRef}>
          <Canvas
            graph={graph}
            selection={state.selection}
            viewport={state.viewport}
            nodeStatus={nodeStatus}
            breakpoints={breakpoints}
            debugPausedAt={state.debugPausedAt}
            onSelect={actions.select}
            onMoveNode={actions.moveNode}
            onMoveNodes={actions.moveNodes}
            onConnect={actions.connect}
            onDeleteEdge={actions.deleteEdge}
            onViewportChange={actions.setViewport}
          />
          <MiniMap nodes={graph.nodes} viewport={state.viewport} canvasW={canvasSize.w} canvasH={canvasSize.h} />
        </main>

        <aside className="side">
          <Inspector
            node={selectedNode}
            onUpdateParam={actions.updateParam}
            onRename={actions.renameNode}
            onToggleBreakpoint={actions.toggleBreakpoint}
          />
        </aside>
      </div>

      <section className={resultsOpen ? 'results' : 'results collapsed'} aria-label="结果面板">
        <div className="results-tabs">
          <button
            data-testid="toggle-results"
            onClick={() => setResultsOpen((v) => !v)}
            title={resultsOpen ? '收起结果面板' : '展开结果面板'}
            aria-expanded={resultsOpen}
          >
            {resultsOpen ? '▾' : '▴'}
          </button>
          <button className={tab === 'output' ? 'active' : ''} onClick={() => setTab('output')} data-testid="tab-output">
            输出预览
          </button>
          <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')} data-testid="tab-log">
            运行与校验
          </button>
          {stale && (
            <span className="badge warn" data-testid="stale-badge">
              结果对应旧版本 r{state.run!.graphRevision}，当前 r{graph.revision}
            </span>
          )}
          {paused && state.debugPausedAt && (
            <span className="badge warn" data-testid="debug-paused-badge">
              调试已暂停：{graph.nodes.find((n) => n.id === state.debugPausedAt)?.name}
            </span>
          )}
          {tab === 'output' && selectedOutput && selectedNode && selectedPorts.length > 1 && (
            <span className="port-switch">
              {selectedPorts.map((p) => (
                <button
                  key={p}
                  data-testid={`view-port-${p}`}
                  className={p === activePort ? 'active' : ''}
                  onClick={() => setViewPort(p)}
                >
                  {p === 'true' ? '匹配' : p === 'false' ? '不匹配' : p}
                </button>
              ))}
            </span>
          )}
          {tab === 'output' && selectedOutput && selectedNode && !isChart && (
            <button
              data-testid="download-csv"
              onClick={() => downloadCsv(`${selectedNode.name}.csv`, exportTableCsv(selectedOutput))}
            >
              下载 CSV
            </button>
          )}
        </div>
        {tab === 'output' ? (
          isChart && selectedNode ? (
            <div className="chart-wrap" data-testid="chart-view">
              <ChartView table={selectedOutput ?? { columns: [], rows: [] }} chartType={String(selectedNode.params['chartType'] ?? 'bar')} />
            </div>
          ) : (
            <DataTableView table={selectedOutput} title={selectedNode ? `节点「${selectedNode.name}」输出` : undefined} />
          )
        ) : (
          <div className="runlog" data-testid="runlog">
            {state.issues.length === 0 && <p className="muted">无校验问题。</p>}
            {state.issues.map((issue, i) => (
              <button
                key={i}
                className={`issue ${issue.severity}`}
                data-testid={`issue-${i}`}
                onClick={() => actions.select([issue.nodeId])}
                title="点击跳转到节点"
              >
                [{issue.severity === 'error' ? '错误' : '警告'}] {issue.message}
              </button>
            ))}
            {state.run && (
              <table className="run-table">
                <thead>
                  <tr>
                    <th>节点</th>
                    <th>状态</th>
                    <th>输入行</th>
                    <th>输出行</th>
                    <th>耗时</th>
                    <th>错误</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(state.run.nodeStates).map(([nid, info]) => {
                    const n = graph.nodes.find((x) => x.id === nid);
                    return (
                      <tr key={nid} data-testid={`runrow-${nid}`}>
                        <td>{n?.name ?? nid}</td>
                        <td>{info.status}</td>
                        <td>{info.inputRows}</td>
                        <td>{info.outputRows}</td>
                        <td>{info.durationMs} ms</td>
                        <td className="err">{info.error ?? ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>

      <footer className="footer">
        <span className="muted small">
          FlowLab Studio v{APP_VERSION} · 本地运行 · M2 里程碑
        </span>
      </footer>
    </div>
  );
}
