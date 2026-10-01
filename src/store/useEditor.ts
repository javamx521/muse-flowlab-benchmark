/**
 * 编辑器状态（M1）。
 * useReducer 管理语义级 action；自动保存防抖 800ms，只有持久化成功后才标记"已保存"。
 * 运行通过 RunManager + WorkerBackend（浏览器）执行。
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
import { canRun } from '../engine/graph';
import { LocalBackend, RunManager } from '../engine/executor';
import { WorkerBackend } from '../engine/workerBackend';
import type { ExecutorBackend } from '../engine/executor';
import { LocalStorageBackend, newDocument } from './document';
import type { ProjectDocument, StorageBackend } from './document';

export interface Viewport {
  x: number;
  y: number;
  k: number;
}

export interface EditorState {
  doc: ProjectDocument | null;
  loading: boolean;
  loadError: string | null;
  selection: string[];
  viewport: Viewport;
  run: RunRecord | null;
  running: boolean;
  issues: GraphIssue[];
  saveStatus: 'saved' | 'saving' | 'error' | 'idle';
  seq: number;
}

type Action =
  | { t: 'loaded'; doc: ProjectDocument }
  | { t: 'loadError'; error: string }
  | { t: 'addNode'; kind: NodeKind; x: number; y: number }
  | { t: 'moveNode'; id: string; x: number; y: number }
  | { t: 'moveNodes'; moves: { id: string; x: number; y: number }[] }
  | { t: 'deleteNodes'; ids: string[] }
  | { t: 'connect'; source: string; target: string }
  | { t: 'deleteEdge'; edgeId: string }
  | { t: 'updateParam'; id: string; key: string; value: unknown }
  | { t: 'renameNode'; id: string; name: string }
  | { t: 'select'; ids: string[] }
  | { t: 'setViewport'; viewport: Viewport }
  | { t: 'runStart' }
  | { t: 'nodeState'; nodeId: string; info: NodeRunInfo }
  | { t: 'runEnd'; record: RunRecord }
  | { t: 'setIssues'; issues: GraphIssue[] }
  | { t: 'saveStatus'; status: EditorState['saveStatus'] }
  | { t: 'replaceGraph'; graph: WorkflowGraph }; // M3 快照/导入用

let nodeSeq = 0;
let edgeSeq = 0;

function bumpRevision(graph: WorkflowGraph): WorkflowGraph {
  return { ...graph, revision: graph.revision + 1 };
}

function reducer(state: EditorState, action: Action): EditorState {
  const doc = state.doc;
  switch (action.t) {
    case 'loaded':
      return { ...state, doc: action.doc, loading: false, loadError: null, seq: action.doc.graph.nodes.length };
    case 'loadError':
      return { ...state, loading: false, loadError: action.error };
    case 'select':
      return { ...state, selection: action.ids };
    case 'setViewport':
      return { ...state, viewport: action.viewport };
    case 'runStart':
      return { ...state, running: true };
    case 'nodeState': {
      if (!state.run) return state;
      return { ...state, run: { ...state.run, nodeStates: { ...state.run.nodeStates, [action.nodeId]: action.info } } };
    }
    case 'runEnd':
      return { ...state, running: false, run: action.record };
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
      const exists = graph.edges.some((e) => e.source === action.source && e.target === action.target);
      if (exists) return state;
      edgeSeq += 1;
      const next: WorkflowGraph = bumpRevision({
        ...graph,
        edges: [...graph.edges, { id: `e${Date.now().toString(36)}_${edgeSeq}`, source: action.source, target: action.target, targetPort: 'in' }],
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
  running: false,
  issues: [],
  saveStatus: 'idle',
  seq: 0,
};

export interface EditorActions {
  addNode(kind: NodeKind, x?: number, y?: number): void;
  moveNode(id: string, x: number, y: number): void;
  moveNodes(moves: { id: string; x: number; y: number }[]): void;
  deleteSelection(): void;
  connect(source: string, target: string): void;
  deleteEdge(edgeId: string): void;
  updateParam(id: string, key: string, value: unknown): void;
  renameNode(id: string, name: string): void;
  select(ids: string[]): void;
  setViewport(v: Viewport): void;
  run(): Promise<void>;
  cancelRun(): void;
  refreshIssues(): void;
  saveNow(): Promise<void>;
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

export function useEditor(projectId: string, backend?: StorageBackend, fallbackName?: string) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const storage = useMemo(() => backend ?? new LocalStorageBackend(), [backend]);
  const managerRef = useRef<RunManager | null>(null);
  const saveTimer = useRef<number | null>(null);
  const docRef = useRef<ProjectDocument | null>(null);
  docRef.current = state.doc;

  if (!managerRef.current) {
    managerRef.current = new RunManager(makeBackend(), {
      onNodeState: (nodeId, info) => dispatch({ t: 'nodeState', nodeId, info }),
      onRunEnd: (record) => dispatch({ t: 'runEnd', record }),
    });
  }

  // 加载
  useEffect(() => {
    let alive = true;
    storage.load(projectId).then(
      (doc) => {
        if (!alive) return;
        if (doc) {
          dispatch({ t: 'loaded', doc });
          dispatch({ t: 'setIssues', issues: canRun(doc.graph).issues });
        } else {
          const fresh = newDocument(projectId, fallbackName ?? '未命名项目');
          dispatch({ t: 'loaded', doc: fresh });
        }
      },
      (err) => {
        if (alive) dispatch({ t: 'loadError', error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      alive = false;
    };
  }, [projectId, storage, fallbackName]);

  // 自动保存（防抖）
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    dispatch({ t: 'saveStatus', status: 'saving' });
    saveTimer.current = window.setTimeout(() => {
      const doc = docRef.current;
      if (!doc) return;
      storage
        .save(doc)
        .then(() => dispatch({ t: 'saveStatus', status: 'saved' }))
        .catch(() => dispatch({ t: 'saveStatus', status: 'error' }));
    }, 800);
  }, [storage]);

  const prevGraphRef = useRef<WorkflowGraph | null>(null);
  useEffect(() => {
    const g = state.doc?.graph ?? null;
    if (g && prevGraphRef.current !== g) {
      prevGraphRef.current = g;
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
        dispatch({ t: 'addNode', kind, x, y });
      },
      moveNode: (id, x, y) => dispatch({ t: 'moveNode', id, x, y }),
      moveNodes: (moves) => dispatch({ t: 'moveNodes', moves }),
      deleteSelection: () => {
        if (state.selection.length > 0) dispatch({ t: 'deleteNodes', ids: state.selection });
      },
      connect: (source, target) => dispatch({ t: 'connect', source, target }),
      deleteEdge: (edgeId) => dispatch({ t: 'deleteEdge', edgeId }),
      updateParam: (id, key, value) => dispatch({ t: 'updateParam', id, key, value }),
      renameNode: (id, name) => dispatch({ t: 'renameNode', id, name }),
      select: (ids) => dispatch({ t: 'select', ids }),
      setViewport: (v) => dispatch({ t: 'setViewport', viewport: v }),
      refreshIssues: () => {
        const doc = docRef.current;
        if (doc) dispatch({ t: 'setIssues', issues: canRun(doc.graph).issues });
      },
      saveNow: async () => {
        const doc = docRef.current;
        if (!doc) return;
        dispatch({ t: 'saveStatus', status: 'saving' });
        try {
          await storage.save(doc);
          dispatch({ t: 'saveStatus', status: 'saved' });
        } catch {
          dispatch({ t: 'saveStatus', status: 'error' });
        }
      },
      run: async () => {
        const doc = docRef.current;
        if (!doc || state.running) return;
        const { ok, issues } = canRun(doc.graph);
        dispatch({ t: 'setIssues', issues });
        if (!ok) return;
        dispatch({ t: 'runStart' });
        await managerRef.current!.start(doc.graph);
      },
      cancelRun: () => managerRef.current?.cancel(),
    }),
    [state.running, state.selection, storage],
  );

  return { state, actions };
}
