/**
 * 编辑器页面：工作台布局（M2）。
 * 左侧节点面板（按分组）/ 中央画布+小地图 / 右侧检查器+问题 / 底部结果面板 / 顶栏运行与调试控制。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Canvas, { NODE_W } from '../components/Canvas';
import Inspector from '../components/Inspector';
import DataTableView from '../components/DataTableView';
import ChartView from '../components/ChartView';
import CommandPalette, { type PaletteCommand } from '../components/CommandPalette';
import { useEditor } from '../store/useEditor';
import { listNodeDefs, exportTableCsv, getNodeDef } from '../engine/nodes';
import { APP_VERSION } from '../lib/version';
import { getProjectStore } from '../store/appStores';
import type { ProjectMeta } from '../lib/projects';
import { diffGraphs, isDiffEmpty } from '../store/snapshots';
import type { NamedSnapshot } from '../store/document';
import type { NodeInstance, NodeKind, NodeRunStatus } from '../engine/types';

function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadCsv(filename: string, text: string) {
  downloadText(filename, '\uFEFF' + text, 'text/csv;charset=utf-8');
}

/** 快照面板对话框（F07）：创建 / 比较 / 恢复 / 删除。 */
function SnapshotDialog(props: {
  snapshots: NamedSnapshot[];
  currentGraph: import('../engine/types').WorkflowGraph;
  onCreate(name: string): void;
  onDelete(id: string): void;
  onRestore(id: string): void;
  onClose(): void;
}) {
  const [name, setName] = useState('');
  const [compareId, setCompareId] = useState<string | null>(null);
  const compareSnap = props.snapshots.find((s) => s.id === compareId) ?? null;
  const diff = useMemo(
    () => (compareSnap ? diffGraphs(compareSnap.graph, props.currentGraph) : null),
    [compareSnap, props.currentGraph],
  );

  // 焦点管理：打开时聚焦到输入框，Esc 关闭（F09 无障碍）
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-overlay" data-testid="snapshot-dialog" role="dialog" aria-modal="true" aria-label="命名快照">
      <div className="modal">
        <h2>命名快照</h2>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            props.onCreate(name);
            setName('');
          }}
        >
          <input
            ref={inputRef}
            data-testid="snapshot-name"
            type="text"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            placeholder="快照名称"
            aria-label="快照名称"
          />
          <button type="submit" data-testid="snapshot-create">创建快照</button>
        </form>
        {props.snapshots.length === 0 && <p className="muted">还没有快照。</p>}
        <ul className="snapshot-list">
          {props.snapshots.map((s) => (
            <li key={s.id} data-testid={`snapshot-${s.id}`}>
              <strong>{s.name}</strong>
              <span className="muted small">
                {new Date(s.createdAt).toLocaleString('zh-CN', { hour12: false })} · {s.graph.nodes.length} 节点 / {s.graph.edges.length} 连线
              </span>
              <div className="row">
                <button type="button" onClick={() => setCompareId(compareId === s.id ? null : s.id)}>
                  {compareId === s.id ? '收起比较' : '与当前比较'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`恢复到快照「${s.name}」？当前未保存的修改可通过撤销找回。`)) {
                      props.onRestore(s.id);
                      props.onClose();
                    }
                  }}
                >
                  恢复
                </button>
                <button
                  type="button"
                  className="danger-text"
                  onClick={() => {
                    if (window.confirm(`删除快照「${s.name}」？`)) props.onDelete(s.id);
                  }}
                >
                  删除
                </button>
              </div>
              {compareId === s.id && diff && (
                <div className="diff-view" data-testid="snapshot-diff">
                  {isDiffEmpty(diff) && <p className="muted">与当前完全一致。</p>}
                  {diff.layoutOnly && <p className="muted">仅布局（节点位置）有差异。</p>}
                  {diff.addedNodes.length > 0 && (
                    <p>新增节点：{diff.addedNodes.map((n) => n.name).join('、')}</p>
                  )}
                  {diff.removedNodes.length > 0 && (
                    <p>删除节点：{diff.removedNodes.map((n) => n.name).join('、')}</p>
                  )}
                  {diff.changedNodes.map((c) => (
                    <p key={c.id}>「{c.name}」：{c.changes.join('；')}</p>
                  ))}
                  {(diff.addedEdges.length > 0 || diff.removedEdges.length > 0) && (
                    <p>连线变化：新增 {diff.addedEdges.length} 条，删除 {diff.removedEdges.length} 条</p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        <div className="row">
          <button type="button" onClick={props.onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/** 多标签页冲突解决对话框（F07）。 */
function ConflictDialog(props: {
  serverUpdatedAt: string;
  onReload(): void;
  onCopy(): void;
  onForce(): void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') e.stopPropagation(); // 冲突必须明确选择，不允许 Esc 绕过
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div className="modal-overlay" data-testid="conflict-dialog" role="alertdialog" aria-modal="true" aria-label="多标签页冲突">
      <div className="modal">
        <h2>检测到多标签页冲突</h2>
        <p>
          另一个标签页修改了此项目{props.serverUpdatedAt && <>（对方保存于 {new Date(props.serverUpdatedAt).toLocaleString('zh-CN', { hour12: false })}）</>}。
          为避免静默覆盖，自动保存已暂停，你的本地修改仍保留在当前页面。
        </p>
        <div className="column">
          <button type="button" data-testid="conflict-reload" onClick={props.onReload}>
            重新加载对方版本（丢弃本地未保存修改）
          </button>
          <button type="button" data-testid="conflict-copy" onClick={props.onCopy}>
            另存为副本（保留本地全部内容为新项目）
          </button>
          <button type="button" data-testid="conflict-force" onClick={props.onForce} className="danger-text">
            强制覆盖（用本地版本覆盖对方修改）
          </button>
        </div>
      </div>
    </div>
  );
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
  const navigate = useNavigate();
  // 项目元数据改为异步加载（M3：IndexedDB 注册表）
  const [meta, setMeta] = useState<ProjectMeta | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    getProjectStore()
      .then((s) => s.get(id))
      .then((m) => {
        if (alive) setMeta(m ?? null);
      })
      .catch(() => {
        if (alive) setMeta(null);
      });
    return () => {
      alive = false;
    };
  }, [id]);
  const { state, actions } = useEditor(id, undefined, meta?.name);
  const [tab, setTab] = useState<'output' | 'log'>('output');
  const [resultsOpen, setResultsOpen] = useState(true);
  const [placeSeq, setPlaceSeq] = useState(0);
  /** branch 等多输出节点的查看端口。 */
  const [viewPort, setViewPort] = useState<string | null>(null);
  const [snapOpen, setSnapOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const clipboardRef = useRef<ReturnType<typeof actions.copySelection>>(null);
  const canvasWrapRef = useRef<HTMLElement>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 });

  const doc = state.doc;
  const graph = doc?.graph ?? null;
  const graphRef = useRef(graph);
  graphRef.current = graph;

  // 命令面板命令注册（M5）
  const paletteCommands: PaletteCommand[] = useMemo(() => {
    const g = graphRef.current;
    return [
      { id: 'run', title: '运行工作流', shortcut: 'Ctrl+Enter', run: () => { if (!state.running) void actions.run(); } },
      { id: 'cancel-run', title: '取消运行', run: () => { if (state.running) actions.cancelRun(); } },
      { id: 'undo', title: '撤销', shortcut: 'Ctrl+Z', run: () => actions.undo() },
      { id: 'redo', title: '重做', shortcut: 'Ctrl+Shift+Z', run: () => actions.redo() },
      { id: 'save', title: '立即保存', shortcut: 'Ctrl+S', run: () => { void actions.saveNow(); } },
      { id: 'export', title: '导出工程 JSON', run: () => {
        const text = actions.exportProject();
        if (text) downloadText(`flowlab-${doc?.name ?? 'project'}.flowlab.json`, text, 'application/json');
      } },
      { id: 'snapshot', title: '命名快照…', run: () => setSnapOpen(true) },
      { id: 'clear-cache', title: '清除增量缓存', run: () => actions.clearCache() },
      { id: 'select-all', title: '全选节点', shortcut: 'Ctrl+A', run: () => { if (g) actions.select(g.nodes.map((n) => n.id)); } },
      { id: 'delete-selection', title: '删除选中节点', shortcut: 'Delete', run: () => actions.deleteSelection() },
      { id: 'shortcuts', title: '快捷键帮助…', shortcut: '?', run: () => setShortcutsOpen(true) },
      { id: 'toggle-results', title: '展开/收起结果面板', run: () => setResultsOpen((v) => !v) },
    ];
  }, [actions, doc?.name, state.running]);

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

  // 快捷键：Delete 删除；Ctrl+C / Ctrl+V 复制粘贴；Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 撤销重做；Ctrl+S 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        actions.undo();
      } else if ((mod && key === 'y') || (mod && e.shiftKey && key === 'z')) {
        e.preventDefault();
        actions.redo();
      } else if (mod && key === 's') {
        e.preventDefault();
        void actions.saveNow();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection.length > 0) {
        e.preventDefault();
        actions.deleteSelection();
      } else if (mod && key === 'c' && state.selection.length > 0) {
        e.preventDefault();
        clipboardRef.current = actions.copySelection();
      } else if (mod && key === 'v' && clipboardRef.current) {
        e.preventDefault();
        actions.paste(clipboardRef.current.nodes, clipboardRef.current.edges);
      } else if (mod && key === 'a') {
        e.preventDefault();
        const g = graphRef.current;
        if (g) actions.select(g.nodes.map((n) => n.id));
      } else if (mod && key === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (mod && key === 'enter') {
        e.preventDefault();
        if (!state.running) void actions.run();
      } else if (e.key === '?' && !mod) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
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

  if (meta === undefined || state.loading) return <div className="page"><p>加载中…</p></div>;
  if (state.loadError) return <div className="page"><p role="alert">加载失败：{state.loadError}</p></div>;
  if (!meta) {
    return (
      <main className="editor" data-testid="editor-page">
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
      <a href="#canvas-main" className="skip-link" data-testid="skip-link">
        跳到画布
      </a>
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
        <button
          data-testid="undo-btn"
          onClick={() => actions.undo()}
          disabled={!state.canUndo}
          title="撤销（Ctrl+Z）"
        >
          撤销
        </button>
        <button
          data-testid="redo-btn"
          onClick={() => actions.redo()}
          disabled={!state.canRedo}
          title="重做（Ctrl+Shift+Z）"
        >
          重做
        </button>
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
        <span
          className="sr-only"
          role="status"
          aria-live="polite"
          data-testid="run-status-live"
        >
          {state.running ? '工作流运行中' : state.run ? `运行完成：${state.run.nodeStates ? Object.keys(state.run.nodeStates).length : 0} 个节点` : '未运行'}
        </span>
        <button
          data-testid="palette-btn"
          onClick={() => setPaletteOpen(true)}
          title="命令面板（Ctrl+K）"
          aria-label="打开命令面板"
        >
          ⌘ 命令
        </button>
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
        <button
          data-testid="snapshot-btn"
          onClick={() => setSnapOpen(true)}
          title="命名快照：创建 / 比较 / 恢复"
        >
          快照
        </button>
        <button
          data-testid="export-btn"
          onClick={() => {
            const text = actions.exportProject();
            if (text) downloadText(`flowlab-${doc.name}.flowlab.json`, text, 'application/json');
          }}
          title="导出工程 JSON（含数据与快照，可在新浏览器导入恢复）"
        >
          导出
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

        <main className="canvas-wrap" ref={canvasWrapRef} id="canvas-main" tabIndex={-1}>
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
            onDragStart={actions.beginDrag}
            onDragEnd={actions.endDrag}
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

      {snapOpen && doc && (
        <SnapshotDialog
          snapshots={doc.snapshots}
          currentGraph={graph}
          onCreate={(name) => actions.createSnapshot(name)}
          onDelete={(sid) => actions.deleteSnapshot(sid)}
          onRestore={(sid) => actions.restoreSnapshot(sid)}
          onClose={() => setSnapOpen(false)}
        />
      )}
      {state.conflict && (
        <ConflictDialog
          serverUpdatedAt={state.conflict.serverUpdatedAt}
          onReload={() => actions.reloadServer()}
          onCopy={async () => {
            const store = await getProjectStore();
            const meta = await store.create(`${doc.name}（本地副本）`);
            await actions.saveAsCopy(meta.id);
            navigate(`/project/${meta.id}`);
          }}
          onForce={() => actions.forceSave()}
        />
      )}

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
              <>
                <p className="muted small" data-testid="cache-summary">
                  增量缓存：本次运行 {state.run.cacheHits} 个节点命中缓存
                  {(() => {
                    const s = actions.cacheStats();
                    return `（缓存中共 ${s.entries} 条 · 累计命中 ${s.hits} · 未命中 ${s.misses} · 淘汰 ${s.evictions}）`;
                  })()}
                  {' '}
                  <button data-testid="clear-cache" onClick={() => actions.clearCache()} title="清空增量缓存，释放内存；下次运行将重新计算">
                    清除缓存
                  </button>
                </p>
                <table className="run-table">
                  <thead>
                    <tr>
                      <th>节点</th>
                      <th>状态</th>
                      <th>缓存</th>
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
                          <td>{info.cacheHit ? <span className="badge ok" data-testid={`cache-hit-${nid}`}>命中</span> : '—'}</td>
                          <td>{info.inputRows}</td>
                          <td>{info.outputRows}</td>
                          <td>{info.durationMs} ms</td>
                          <td className="err">{info.error ?? ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}
      </section>

      <footer className="footer">
        <span className="muted small">
          FlowLab Studio v{APP_VERSION} · 本地运行 · M3 里程碑
        </span>
      </footer>

      <CommandPalette
        open={paletteOpen}
        commands={paletteCommands}
        onClose={() => setPaletteOpen(false)}
      />

      {shortcutsOpen && (
        <div
          className="cmd-palette-overlay"
          data-testid="shortcuts-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShortcutsOpen(false);
          }}
        >
          <div
            className="cmd-palette"
            role="dialog"
            aria-modal="true"
            aria-label="快捷键帮助"
            data-testid="shortcuts-dialog"
          >
            <div className="cmd-palette-input" style={{ fontWeight: 600 }}>
              快捷键
              <button
                data-testid="shortcuts-close"
                onClick={() => setShortcutsOpen(false)}
                style={{ float: 'right' }}
                aria-label="关闭快捷键帮助"
              >
                ✕
              </button>
            </div>
            <div className="cmd-palette-list">
              {[
                ['运行工作流', 'Ctrl+Enter'],
                ['命令面板', 'Ctrl+K'],
                ['撤销 / 重做', 'Ctrl+Z / Ctrl+Shift+Z'],
                ['保存', 'Ctrl+S'],
                ['全选节点', 'Ctrl+A'],
                ['删除选中', 'Delete'],
                ['复制 / 粘贴', 'Ctrl+C / Ctrl+V'],
                ['快捷键帮助', '?'],
              ].map(([name, keys]) => (
                <div key={name} className="cmd-palette-item">
                  <span>{name}</span>
                  <kbd>{keys}</kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
