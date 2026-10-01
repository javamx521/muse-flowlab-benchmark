/**
 * 编辑器状态（M3）。
 * useReducer 管理语义级 action；自动保存防抖 800ms，只有持久化成功后才标记"已保存"。
 * 运行通过 RunManager + WorkerBackend（浏览器）执行。
 *
 * M3 新增：
 * - F06 撤销/重做：语义编辑前压图快照（UndoHistory），连续拖拽合并为一条，
 *   新编辑清空 redo，纯选择/视口/运行不入历史；
 * - F07 多标签页：保存带乐观并发 rev，冲突时弹冲突解决对话框；
 * - F07 快照：命名快照的创建/删除/恢复（恢复可撤销）；
 * - F07 导出：exportProject() 返回工程 JSON。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type {
  GraphIssue,
  NodeInstance,
  NodeKind,
  NodeRunInfo,
  RunRecord,
  WorkflowGraph,
} from '../engine/types';
import { getNodeDef, isNodeKind } from '../engine/nodes';
import { canRun, topoSort } from '../engine/graph';
import { LocalBackend, RunManager } from '../engine/executor';
import { WorkerBackend } from '../engine/workerBackend';
import type { ExecutorBackend } from '../engine/executor';
import { newDocument } from './document';
import { ConflictError } from './document';
import type { ProjectDocument, RevisionedStorageBackend } from './document';
import { UndoHistory } from './history';
import { RunCache } from '../engine/cache';
import type { CacheStats } from '../engine/cache';
import { newSnapshotId } from './snapshots';
import type { NamedSnapshot } from './document';
import { serializeExport } from './exportImport';
import { getBackend } from './appStores';

export interface Viewport {
  x: number;
  y: number;
  k: number;
}

export interface ConflictInfo {
  currentRev: number;
  serverUpdatedAt: string;
}

export interface EditorState {
  doc: ProjectDocument | null;
  loading: boolean;
  loadError: string | null;
  selection: string[];
  viewport: Viewport;
  run: RunRecord | null;
  /** 最近运行历史（M2 运行快照），最多保留 5 条。 */
  runHistory: RunRecord[];
  running: boolean;
  /** 调试模式开关（F04）。 */
  debugMode: boolean;
  /** 调试暂停所在的节点 id。 */
  debugPausedAt: string | null;
  issues: GraphIssue[];
  saveStatus: 'saved' | 'saving' | 'error' | 'idle';
  seq: number;
  /** F06 撤销/重做可用性。 */
  canUndo: boolean;
  canRedo: boolean;
  /** F07 多标签页写入冲突；非 null 时自动保存暂停，等待用户解决。 */
  conflict: ConflictInfo | null;
  /** F08 增量缓存版本；清除缓存时递增以刷新统计显示。 */
  cacheVersion: number;
}

type Action =
  | { t: 'loaded'; doc: ProjectDocument }
  | { t: 'loadError'; error: string }
  | { t: 'setDoc'; doc: ProjectDocument }
  | { t: 'historySync'; canUndo: boolean; canRedo: boolean }
  | { t: 'addNode'; kind: NodeKind; x: number; y: number }
  | { t: 'moveNode'; id: string; x: number; y: number }
  | { t: 'moveNodes'; moves: { id: string; x: number; y: number }[] }
  | { t: 'deleteNodes'; ids: string[] }
  | { t: 'connect'; source: string; target: string; sourcePort?: string; targetPort?: string }
  | { t: 'deleteEdge'; edgeId: string }
  | { t: 'updateParam'; id: string; key: string; value: unknown }
  | { t: 'renameNode'; id: string; name: string }
  | { t: 'toggleBreakpoint'; id: string }
  | { t: 'select'; ids: string[] }
  | { t: 'setViewport'; viewport: Viewport }
  | { t: 'runStart'; debug: boolean }
  | { t: 'nodeState'; nodeId: string; info: NodeRunInfo }
  | { t: 'runEnd'; record: RunRecord }
  | { t: 'debugPause'; nodeId: string | null }
  | { t: 'setDebugMode'; debug: boolean }
  | { t: 'selectRun'; runId: string | null }
  | { t: 'paste'; nodes: NodeInstance[]; edges: { source: string; target: string; sourcePort?: string; targetPort?: string }[] }
  | { t: 'setIssues'; issues: GraphIssue[] }
  | { t: 'saveStatus'; status: EditorState['saveStatus'] }
  | { t: 'conflict'; info: ConflictInfo }
  | { t: 'conflictClear' }
  | { t: 'cacheCleared' }
  | { t: 'replaceGraph'; graph: WorkflowGraph }; // 撤销/重做/快照恢复/自动布局用

let nodeSeq = 0;
let edgeSeq = 0;

function bumpRevision(graph: WorkflowGraph): WorkflowGraph {
  return { ...graph, revision: graph.revision + 1 };
}

function reducer(state: EditorState, action: Action): EditorState {
  const doc = state.doc;
  switch (action.t) {
    case 'loaded':
      return {
        ...state, doc: action.doc, loading: false, loadError: null,
        seq: action.doc.graph.nodes.length, conflict: null, canUndo: false, canRedo: false,
      };
    case 'loadError':
      return { ...state, loading: false, loadError: action.error };
    case 'setDoc':
      return { ...state, doc: action.doc };
    case 'historySync':
      return { ...state, canUndo: action.canUndo, canRedo: action.canRedo };
    case 'conflict':
      return { ...state, conflict: action.info };
    case 'conflictClear':
      return { ...state, conflict: null };
    case 'cacheCleared':
      return { ...state, cacheVersion: state.cacheVersion + 1 };
    case 'select':
      return { ...state, selection: action.ids };
    case 'setViewport':
      return { ...state, viewport: action.viewport };
    case 'runStart':
      return { ...state, running: true, debugPausedAt: null };
    case 'debugPause':
      return { ...state, debugPausedAt: action.nodeId };
    case 'setDebugMode':
      return { ...state, debugMode: action.debug };
    case 'selectRun': {
      const rec = state.runHistory.find((r) => r.runId === action.runId) ?? null;
      return { ...state, run: rec };
    }
    case 'nodeState': {
      if (!state.run) return state;
      return { ...state, run: { ...state.run, nodeStates: { ...state.run.nodeStates, [action.nodeId]: action.info } } };
    }
    case 'runEnd': {
      const history = [action.record, ...state.runHistory.filter((r) => r.runId !== action.record.runId)].slice(0, 5);
      return { ...state, running: false, run: action.record, runHistory: history, debugPausedAt: null };
    }
    case 'setIssues':
      return { ...state, issues: action.issues };
    case 'saveStatus':
      return { ...state, saveStatus: action.status };
    case 'replaceGraph': {
      if (!doc) return state;
      return { ...state, doc: { ...doc, graph: action.graph }, selection: [] };
    }
    default:
      break;
  }
  if (!doc) return state;
  const graph = doc.graph;
  switch (action.t) {
    case 'addNode': {
      nodeSeq += 1;
      const def = getNodeDef(action.kind);
      const id = `n${Date.now().toString(36)}_${nodeSeq}`;
      const node: NodeInstance = {
        id,
        kind: action.kind,
        name: def.defaultName(state.seq + 1),
        params: def.defaultParams(),
        position: { x: action.x, y: action.y },
      };
      const next: WorkflowGraph = bumpRevision({ ...graph, nodes: [...graph.nodes, node] });
      return { ...state, doc: { ...doc, graph: next }, selection: [id], seq: state.seq + 1 };
    }
    case 'moveNode': {
      const next: WorkflowGraph = {
        ...graph,
        nodes: graph.nodes.map((n) => (n.id === action.id ? { ...n, position: { x: action.x, y: action.y } } : n)),
      };
      // 纯移动不增加 revision（M4 缓存：移动不使缓存失效）
      return { ...state, doc: { ...doc, graph: next } };
    }
    case 'moveNodes': {
      const moves = new Map(action.moves.map((m) => [m.id, m]));
      const next: WorkflowGraph = {
        ...graph,
        nodes: graph.nodes.map((n) => {
          const m = moves.get(n.id);
          return m ? { ...n, position: { x: m.x, y: m.y } } : n;
        }),
      };
      return { ...state, doc: { ...doc, graph: next } };
    }
    case 'deleteNodes': {
      const ids = new Set(action.ids);
      const next: WorkflowGraph = bumpRevision({
        ...graph,
        nodes: graph.nodes.filter((n) => !ids.has(n.id)),
        edges: graph.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
      });
      return { ...state, doc: { ...doc, graph: next }, selection: [] };
    }
    case 'connect': {
      if (action.source === action.target) return state;
      const sPort = action.sourcePort ?? 'out';
      const tPort = action.targetPort ?? 'in';
      // 同源/同目标/同端口的重复连线直接忽略
      const exists = graph.edges.some(
        (e) => e.source === action.source && e.target === action.target &&
          (e.sourcePort ?? 'out') === sPort && (e.targetPort ?? 'in') === tPort,
      );
      if (exists) return state;
      // 同一输入端口只允许一条连线：新连线替换旧连线（F02 重新连线）
      const filtered = graph.edges.filter(
        (e) => !(e.target === action.target && (e.targetPort ?? 'in') === tPort),
      );
      edgeSeq += 1;
      const next: WorkflowGraph = bumpRevision({
        ...graph,
        edges: [
          ...filtered,
          {
            id: `e${Date.now().toString(36)}_${edgeSeq}`,
            source: action.source,
            target: action.target,
            sourcePort: sPort === 'out' ? undefined : sPort,
            targetPort: tPort === 'in' ? undefined : tPort,
          },
        ],
      });
      return { ...state, doc: { ...doc, graph: next } };
    }
    case 'deleteEdge': {
      const next: WorkflowGraph = bumpRevision({ ...graph, edges: graph.edges.filter((e) => e.id !== action.edgeId) });
      return { ...state, doc: { ...doc, graph: next } };
    }
    case 'updateParam': {
      const next: WorkflowGraph = bumpRevision({
        ...graph,
        nodes: graph.nodes.map((n) =>
          n.id === action.id ? { ...n, params: { ...n.params, [action.key]: action.value } } : n,
        ),
      });
      return { ...state, doc: { ...doc, graph: next } };
    }
    case 'renameNode': {
      const next: WorkflowGraph = {
        ...graph,
        nodes: graph.nodes.map((n) => (n.id === action.id ? { ...n, name: action.name } : n)),
      };
      return { ...state, doc: { ...doc, graph: next } };
    }
    case 'toggleBreakpoint': {
      const next: WorkflowGraph = bumpRevision({
        ...graph,
        nodes: graph.nodes.map((n) =>
          n.id === action.id ? { ...n, breakpoint: n.breakpoint === true ? undefined : true } : n,
        ),
      });
      return { ...state, doc: { ...doc, graph: next } };
    }
    case 'paste': {
      // 粘贴：生成新 id，重建内部边，整体偏移避免重叠
      const idMap = new Map<string, string>();
      for (const n of action.nodes) {
        nodeSeq += 1;
        idMap.set(n.id, `n${Date.now().toString(36)}_${nodeSeq}`);
      }
      const nodes: NodeInstance[] = action.nodes.map((n) => ({
        ...n,
        id: idMap.get(n.id)!,
        params: JSON.parse(JSON.stringify(n.params)) as Record<string, unknown>,
        position: { x: n.position.x + 40, y: n.position.y + 40 },
      }));
      const sel = new Set(action.nodes.map((n) => n.id));
      const edges = action.edges
        .filter((e) => sel.has(e.source) && sel.has(e.target))
        .map((e) => {
          edgeSeq += 1;
          return {
            id: `e${Date.now().toString(36)}_${edgeSeq}`,
            source: idMap.get(e.source)!,
            target: idMap.get(e.target)!,
            sourcePort: e.sourcePort,
            targetPort: e.targetPort,
          };
        });
      const next: WorkflowGraph = bumpRevision({
        ...graph,
        nodes: [...graph.nodes, ...nodes],
        edges: [...graph.edges, ...edges],
      });
      return { ...state, doc: { ...doc, graph: next }, selection: nodes.map((n) => n.id), seq: state.seq + nodes.length };
    }
    default:
      return state;
  }
}

const initialState: EditorState = {
  doc: null,
  loading: true,
  loadError: null,
  selection: [],
  viewport: { x: 40, y: 40, k: 1 },
  run: null,
  runHistory: [],
  running: false,
  debugMode: false,
  debugPausedAt: null,
  issues: [],
  saveStatus: 'idle',
  seq: 0,
  canUndo: false,
  canRedo: false,
  conflict: null,
  cacheVersion: 0,
};

export interface EditorActions {
  addNode(kind: NodeKind, x?: number, y?: number): void;
  moveNode(id: string, x: number, y: number): void;
  moveNodes(moves: { id: string; x: number; y: number }[]): void;
  beginDrag(): void;
  endDrag(): void;
  deleteSelection(): void;
  connect(source: string, target: string, sourcePort?: string, targetPort?: string): void;
  deleteEdge(edgeId: string): void;
  updateParam(id: string, key: string, value: unknown): void;
  renameNode(id: string, name: string): void;
  toggleBreakpoint(id: string): void;
  copySelection(): { nodes: NodeInstance[]; edges: { source: string; target: string; sourcePort?: string; targetPort?: string }[] } | null;
  paste(nodes: NodeInstance[], edges: { source: string; target: string; sourcePort?: string; targetPort?: string }[]): void;
  autoLayout(): void;
  undo(): void;
  redo(): void;
  select(ids: string[]): void;
  setViewport(v: Viewport): void;
  setDebugMode(debug: boolean): void;
  run(opts?: { debug?: boolean }): Promise<void>;
  pauseDebug(): void;
  resumeDebug(): void;
  stepDebug(): void;
  cancelRun(): void;
  selectRun(runId: string | null): void;
  /** F08：读取增量缓存统计（命中/未命中/条目数/淘汰数）。 */
  cacheStats(): CacheStats;
  /** F08：清空增量缓存（释放内存）。 */
  clearCache(): void;
  refreshIssues(): void;
  saveNow(): Promise<void>;
  /** F07 快照 */
  createSnapshot(name: string): void;
  deleteSnapshot(snapshotId: string): void;
  restoreSnapshot(snapshotId: string): void;
  /** F07 导出：返回工程 JSON 文本。 */
  exportProject(): string | null;
  /** F07 冲突解决 */
  reloadServer(): Promise<void>;
  forceSave(): Promise<void>;
  saveAsCopy(newId: string): Promise<void>;
}

/** 自动布局：按拓扑分层，层内垂直排列（F02）。环内节点保持原位。 */
function layoutGraph(graph: WorkflowGraph): WorkflowGraph {
  const { order } = topoSort(graph);
  const layer = new Map<string, number>();
  for (const id of order) {
    let l = 0;
    for (const e of graph.edges) {
      if (e.target === id) l = Math.max(l, (layer.get(e.source) ?? 0) + 1);
    }
    layer.set(id, l);
  }
  const byLayer = new Map<number, string[]>();
  for (const id of order) {
    const l = layer.get(id) ?? 0;
    const arr = byLayer.get(l);
    if (arr) arr.push(id);
    else byLayer.set(l, [id]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, ids] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    ids.forEach((id, i) => pos.set(id, { x: 80 + l * 300, y: 80 + i * 160 }));
  }
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const p = pos.get(n.id);
      return p ? { ...n, position: p } : n;
    }),
  };
}

function makeBackend(): ExecutorBackend {
  if (typeof Worker !== 'undefined') {
    try {
      return new WorkerBackend();
    } catch {
      return new LocalBackend();
    }
  }
  return new LocalBackend();
}

export function useEditor(projectId: string, backend?: RevisionedStorageBackend, fallbackName?: string) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const storage = useMemo(() => backend ?? getBackend(), [backend]);
  const managerRef = useRef<RunManager | null>(null);
  const saveTimer = useRef<number | null>(null);
  const docRef = useRef<ProjectDocument | null>(null);
  docRef.current = state.doc;
  const historyRef = useRef<UndoHistory | null>(null);
  if (!historyRef.current) historyRef.current = new UndoHistory();
  const dragKeyRef = useRef<string | null>(null);
  const revRef = useRef<number>(0);
  const conflictRef = useRef<ConflictInfo | null>(null);
  conflictRef.current = state.conflict;
  // F08 增量缓存：编辑器会话级单例，跨运行复用；调试运行绕过（executor 内处理）
  const cacheRef = useRef<RunCache | null>(null);
  if (!cacheRef.current) cacheRef.current = new RunCache(50);

  if (!managerRef.current) {
    managerRef.current = new RunManager(makeBackend(), {
      onNodeState: (nodeId, info) => dispatch({ t: 'nodeState', nodeId, info }),
      onRunEnd: (record) => dispatch({ t: 'runEnd', record }),
      onDebugPause: (nodeId) => dispatch({ t: 'debugPause', nodeId }),
    });
  }

  const syncHistory = useCallback(() => {
    const h = historyRef.current!;
    dispatch({ t: 'historySync', canUndo: h.canUndo, canRedo: h.canRedo });
  }, []);

  /**
   * 语义编辑入口：先压历史再 dispatch。
   * coalesceKey 相同则合并（拖拽会话 / 连续键入）；maxAgeMs 限制合并时间窗口。
   */
  const edit = useCallback(
    (action: Action, label: string, coalesceKey: string | null = null, maxAgeMs: number | null = null) => {
      const doc = docRef.current;
      if (doc) {
        historyRef.current!.push(doc.graph, label, coalesceKey, maxAgeMs);
        syncHistory();
      }
      dispatch(action);
    },
    [syncHistory],
  );

  // 加载（含 rev，供多标签页冲突检测）
  useEffect(() => {
    let alive = true;
    historyRef.current!.clear();
    storage.loadWithRev(projectId).then(
      (rec) => {
        if (!alive) return;
        if (rec) {
          revRef.current = rec.rev;
          dispatch({ t: 'loaded', doc: rec.doc });
          dispatch({ t: 'setIssues', issues: canRun(rec.doc.graph).issues });
        } else {
          revRef.current = 0;
          const fresh = newDocument(projectId, fallbackName ?? '未命名项目');
          dispatch({ t: 'loaded', doc: fresh });
        }
        syncHistory();
      },
      (err) => {
        if (alive) dispatch({ t: 'loadError', error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      alive = false;
    };
  }, [projectId, storage, fallbackName, syncHistory]);

  /** 带乐观并发的保存；冲突时进入冲突解决流程，不静默覆盖。 */
  const doSave = useCallback(
    async (force = false) => {
      const doc = docRef.current;
      if (!doc) return;
      dispatch({ t: 'saveStatus', status: 'saving' });
      try {
        const rev = await storage.save(doc, force ? undefined : revRef.current);
        revRef.current = rev;
        dispatch({ t: 'saveStatus', status: 'saved' });
      } catch (err) {
        if (err instanceof ConflictError) {
          const server = await storage.loadWithRev(doc.id).catch(() => null);
          dispatch({
            t: 'conflict',
            info: { currentRev: err.currentRev, serverUpdatedAt: server?.doc.updatedAt ?? '' },
          });
        }
        dispatch({ t: 'saveStatus', status: 'error' });
      }
    },
    [storage],
  );

  // 自动保存（防抖）；冲突未解决时暂停自动保存，避免反复报错
  const scheduleSave = useCallback(() => {
    if (conflictRef.current) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    dispatch({ t: 'saveStatus', status: 'saving' });
    saveTimer.current = window.setTimeout(() => {
      void doSave(false);
    }, 800);
  }, [doSave]);

  const prevDocRef = useRef<ProjectDocument | null>(null);
  useEffect(() => {
    const d = state.doc;
    if (d && prevDocRef.current !== d) {
      prevDocRef.current = d;
      scheduleSave();
    }
  }, [state.doc, scheduleSave]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      managerRef.current?.dispose();
    };
  }, []);

  const actions: EditorActions = useMemo(
    () => ({
      addNode: (kind: NodeKind, x = 120, y = 120) => {
        if (!isNodeKind(kind)) return;
        edit({ t: 'addNode', kind, x, y }, '添加节点');
      },
      moveNode: (id, x, y) => edit({ t: 'moveNode', id, x, y }, '移动节点', dragKeyRef.current),
      moveNodes: (moves) => edit({ t: 'moveNodes', moves }, '移动节点', dragKeyRef.current),
      beginDrag: () => {
        dragKeyRef.current = `drag-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      },
      endDrag: () => {
        dragKeyRef.current = null;
      },
      deleteSelection: () => {
        if (state.selection.length > 0) edit({ t: 'deleteNodes', ids: state.selection }, '删除选中');
      },
      connect: (source, target, sourcePort, targetPort) =>
        edit({ t: 'connect', source, target, sourcePort, targetPort }, '连线'),
      deleteEdge: (edgeId) => edit({ t: 'deleteEdge', edgeId }, '删除连线'),
      updateParam: (id, key, value) =>
        edit({ t: 'updateParam', id, key, value }, '修改参数', `param:${id}:${key}`, 1500),
      renameNode: (id, name) => edit({ t: 'renameNode', id, name }, '重命名节点', `rename:${id}`, 1500),
      toggleBreakpoint: (id) => edit({ t: 'toggleBreakpoint', id }, '切换断点'),
      copySelection: () => {
        const doc = docRef.current;
        if (!doc || state.selection.length === 0) return null;
        const sel = new Set(state.selection);
        const nodes = doc.graph.nodes.filter((n) => sel.has(n.id));
        const edges = doc.graph.edges
          .filter((e) => sel.has(e.source) && sel.has(e.target))
          .map((e) => ({ source: e.source, target: e.target, sourcePort: e.sourcePort, targetPort: e.targetPort }));
        return { nodes, edges };
      },
      paste: (nodes, edges) => edit({ t: 'paste', nodes, edges }, '粘贴子图'),
      autoLayout: () => {
        const doc = docRef.current;
        if (!doc) return;
        const next = layoutGraph(doc.graph);
        edit({ t: 'replaceGraph', graph: { ...next, revision: next.revision + 1 } }, '自动布局');
      },
      undo: () => {
        const doc = docRef.current;
        const h = historyRef.current!;
        if (!doc || !h.canUndo) return;
        const prev = h.undo(doc.graph);
        if (prev) {
          dragKeyRef.current = null;
          dispatch({ t: 'replaceGraph', graph: prev });
          syncHistory();
        }
      },
      redo: () => {
        const doc = docRef.current;
        const h = historyRef.current!;
        if (!doc || !h.canRedo) return;
        const next = h.redo(doc.graph);
        if (next) {
          dragKeyRef.current = null;
          dispatch({ t: 'replaceGraph', graph: next });
          syncHistory();
        }
      },
      select: (ids) => dispatch({ t: 'select', ids }),
      setViewport: (v) => dispatch({ t: 'setViewport', viewport: v }),
      refreshIssues: () => {
        const doc = docRef.current;
        if (doc) dispatch({ t: 'setIssues', issues: canRun(doc.graph).issues });
      },
      saveNow: () => doSave(false),
      createSnapshot: (name: string) => {
        const doc = docRef.current;
        if (!doc) return;
        const snap: NamedSnapshot = {
          id: newSnapshotId(),
          name: name.trim() || `快照 ${doc.snapshots.length + 1}`,
          createdAt: new Date().toISOString(),
          graph: doc.graph,
        };
        dispatch({ t: 'setDoc', doc: { ...doc, snapshots: [...doc.snapshots, snap] } });
      },
      deleteSnapshot: (snapshotId: string) => {
        const doc = docRef.current;
        if (!doc) return;
        dispatch({ t: 'setDoc', doc: { ...doc, snapshots: doc.snapshots.filter((s) => s.id !== snapshotId) } });
      },
      restoreSnapshot: (snapshotId: string) => {
        const doc = docRef.current;
        if (!doc) return;
        const snap = doc.snapshots.find((s) => s.id === snapshotId);
        if (!snap) return;
        edit(
          { t: 'replaceGraph', graph: { ...snap.graph, revision: doc.graph.revision + 1 } },
          `恢复快照「${snap.name}」`,
        );
      },
      exportProject: () => {
        const doc = docRef.current;
        return doc ? serializeExport(doc) : null;
      },
      reloadServer: async () => {
        const rec = await storage.loadWithRev(projectId);
        if (rec) {
          revRef.current = rec.rev;
          historyRef.current!.clear();
          dispatch({ t: 'loaded', doc: rec.doc });
          dispatch({ t: 'setIssues', issues: canRun(rec.doc.graph).issues });
          syncHistory();
        }
        dispatch({ t: 'conflictClear' });
      },
      forceSave: async () => {
        await doSave(true);
        dispatch({ t: 'conflictClear' });
      },
      saveAsCopy: async (newId: string) => {
        const doc = docRef.current;
        if (!doc) return;
        const copy: ProjectDocument = {
          ...doc,
          id: newId,
          snapshots: doc.snapshots.map((s) => ({ ...s })),
        };
        const rev = await storage.save(copy);
        revRef.current = rev;
        historyRef.current!.clear();
        dispatch({ t: 'loaded', doc: copy });
        syncHistory();
        dispatch({ t: 'conflictClear' });
      },
      run: async (opts) => {
        const doc = docRef.current;
        if (!doc || state.running) return;
        const { ok, issues } = canRun(doc.graph);
        dispatch({ t: 'setIssues', issues });
        if (!ok) return;
        const debug = opts?.debug ?? state.debugMode;
        dispatch({ t: 'runStart', debug });
        await managerRef.current!.start(doc.graph, { debug, cache: cacheRef.current ?? undefined });
      },
      cacheStats: () => cacheRef.current!.stats(),
      clearCache: () => {
        cacheRef.current!.clear();
        dispatch({ t: 'cacheCleared' });
      },
      setDebugMode: (debug) => dispatch({ t: 'setDebugMode', debug }),
      pauseDebug: () => managerRef.current?.pauseDebug(),
      resumeDebug: () => {
        dispatch({ t: 'debugPause', nodeId: null });
        managerRef.current?.resumeDebug();
      },
      stepDebug: () => {
        dispatch({ t: 'debugPause', nodeId: null });
        managerRef.current?.stepDebug();
      },
      selectRun: (runId) => dispatch({ t: 'selectRun', runId }),
      cancelRun: () => managerRef.current?.cancel(),
    }),
    [state.running, state.selection, state.debugMode, storage, edit, syncHistory, doSave, projectId],
  );

  return { state, actions };
}
