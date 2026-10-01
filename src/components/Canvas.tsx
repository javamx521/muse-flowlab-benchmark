/**
 * 工作流画布（SVG 实现，无外部依赖）：
 * - 节点拖拽（单选/多选）、端口连线（输出→输入拖拽）、背景平移、滚轮缩放；
 * - 双击连线删除；Delete 键删除选中（由 EditorPage 监听）；
 * - 节点描边颜色反映真实运行状态（F04：图上状态来自引擎事件）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NodeRunStatus, WorkflowGraph } from '../engine/types';
import { getNodeDef } from '../engine/nodes';
import type { Viewport } from '../store/useEditor';

export const NODE_W = 200;
export const NODE_HEADER_H = 36;
export const NODE_BODY_H = 44;

interface Props {
  graph: WorkflowGraph;
  selection: string[];
  viewport: Viewport;
  nodeStatus: Record<string, NodeRunStatus>;
  onSelect(ids: string[]): void;
  onMoveNode(id: string, x: number, y: number): void;
  onMoveNodes(moves: { id: string; x: number; y: number }[]): void;
  onConnect(source: string, target: string): void;
  onDeleteEdge(edgeId: string): void;
  onViewportChange(v: Viewport): void;
}

const STATUS_COLOR: Record<NodeRunStatus, string> = {
  pending: 'var(--node-border)',
  running: 'var(--accent)',
  ok: 'var(--ok)',
  failed: 'var(--danger)',
  cancelled: 'var(--warn)',
  skipped: 'var(--muted)',
};

function portPos(node: { position: { x: number; y: number } }, side: 'in' | 'out'): { x: number; y: number } {
  const y = node.position.y + NODE_HEADER_H + NODE_BODY_H / 2;
  return side === 'in' ? { x: node.position.x, y } : { x: node.position.x + NODE_W, y };
}

export default function Canvas(props: Props) {
  const { graph, selection, viewport, nodeStatus } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<null | {
    ids: string[];
    startWorld: { x: number; y: number };
    orig: Map<string, { x: number; y: number }>;
  }>(null);
  const [panning, setPanning] = useState<null | { sx: number; sy: number; vx: number; vy: number }>(null);
  const [connecting, setConnecting] = useState<null | { source: string; x: number; y: number }>(null);
  const dragRef = useRef(dragging);
  dragRef.current = dragging;
  const panRef = useRef(panning);
  panRef.current = panning;
  const connRef = useRef(connecting);
  connRef.current = connecting;

  const nodeById = useCallback(
    (id: string) => graph.nodes.find((n) => n.id === id),
    [graph.nodes],
  );

  const toWorld = useCallback(
    (sx: number, sy: number) => {
      const rect = svgRef.current!.getBoundingClientRect();
      return {
        x: (sx - rect.left - viewport.x) / viewport.k,
        y: (sy - rect.top - viewport.y) / viewport.k,
      };
    },
    [viewport],
  );

  const onNodeMouseDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault(); // 抑制原生拖拽/选区，接管为节点拖拽
    const ids = e.shiftKey ? (selection.includes(id) ? selection : [...selection, id]) : selection.includes(id) ? selection : [id];
    props.onSelect(ids);
    const w = toWorld(e.clientX, e.clientY);
    const orig = new Map<string, { x: number; y: number }>();
    for (const nid of ids) {
      const n = nodeById(nid);
      if (n) orig.set(nid, { ...n.position });
    }
    setDragging({ ids, startWorld: w, orig });
  };

  const onPortMouseDown = (e: React.MouseEvent, nodeId: string, side: 'in' | 'out') => {
    e.stopPropagation();
    e.preventDefault(); // 关键：抑制原生 HTML5 dragstart，否则连线拖拽的 mouseup 会被吞掉
    if (side === 'out') {
      const w = toWorld(e.clientX, e.clientY);
      setConnecting({ source: nodeId, x: w.x, y: w.y });
    }
  };

  const onPortMouseUp = (e: React.MouseEvent, nodeId: string, side: 'in' | 'out') => {
    e.stopPropagation();
    const c = connRef.current;
    if (c && side === 'in' && c.source !== nodeId) {
      props.onConnect(c.source, nodeId);
    }
    setConnecting(null);
  };

  const onBackgroundMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    props.onSelect([]);
    setPanning({ sx: e.clientX, sy: e.clientY, vx: viewport.x, vy: viewport.y });
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (d && svgRef.current) {
        const rect = svgRef.current.getBoundingClientRect();
        const wx = (e.clientX - rect.left - viewport.x) / viewport.k;
        const wy = (e.clientY - rect.top - viewport.y) / viewport.k;
        const dx = wx - d.startWorld.x;
        const dy = wy - d.startWorld.y;
        const moves = d.ids
          .map((id) => {
            const o = d.orig.get(id);
            return o ? { id, x: o.x + dx, y: o.y + dy } : null;
          })
          .filter((m): m is { id: string; x: number; y: number } => m !== null);
        props.onMoveNodes(moves);
        return;
      }
      const p = panRef.current;
      if (p) {
        props.onViewportChange({ ...viewport, x: p.vx + (e.clientX - p.sx), y: p.vy + (e.clientY - p.sy) });
        return;
      }
      const c = connRef.current;
      if (c && svgRef.current) {
        const rect = svgRef.current.getBoundingClientRect();
        setConnecting({
          source: c.source,
          x: (e.clientX - rect.left - viewport.x) / viewport.k,
          y: (e.clientY - rect.top - viewport.y) / viewport.k,
        });
      }
    };
    const up = () => {
      setDragging(null);
      setPanning(null);
      setConnecting(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, graph.nodes]);

  const onWheel = (e: React.WheelEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const k2 = Math.min(2.5, Math.max(0.3, viewport.k * (e.deltaY < 0 ? 1.1 : 0.9)));
      const wx = (mx - viewport.x) / viewport.k;
      const wy = (my - viewport.y) / viewport.k;
      props.onViewportChange({ k: k2, x: mx - wx * k2, y: my - wy * k2 });
    } else {
      props.onViewportChange({ ...viewport, x: viewport.x - e.deltaX, y: viewport.y - e.deltaY });
    }
  };

  const edgePath = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  };

  return (
    <svg
      ref={svgRef}
      data-testid="canvas"
      className="canvas"
      onMouseDown={onBackgroundMouseDown}
      onWheel={onWheel}
      role="application"
      aria-label="工作流画布"
    >
      <defs>
        <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="var(--grid-dot)" />
        </pattern>
      </defs>
      <g transform={`translate(${viewport.x},${viewport.y}) scale(${viewport.k})`}>
        <rect x={-5000} y={-5000} width={10000} height={10000} fill="url(#grid)" />
        {/* 连线 */}
        {graph.edges.map((e) => {
          const s = nodeById(e.source);
          const t = nodeById(e.target);
          if (!s || !t) return null;
          const p1 = portPos(s, 'out');
          const p2 = portPos(t, 'in');
          return (
            <path
              key={e.id}
              data-testid={`edge-${e.id}`}
              d={edgePath(p1.x, p1.y, p2.x, p2.y)}
              className="edge"
              onDoubleClick={(ev) => {
                ev.stopPropagation();
                props.onDeleteEdge(e.id);
              }}
            >
              <title>双击删除连线</title>
            </path>
          );
        })}
        {/* 连线中 */}
        {connecting &&
          (() => {
            const s = nodeById(connecting.source);
            if (!s) return null;
            const p1 = portPos(s, 'out');
            return <path d={edgePath(p1.x, p1.y, connecting.x, connecting.y)} className="edge edge-temp" />;
          })()}
        {/* 节点 */}
        {graph.nodes.map((n) => {
          let def;
          try {
            def = getNodeDef(n.kind);
          } catch {
            return null;
          }
          const selected = selection.includes(n.id);
          const status = nodeStatus[n.id] ?? 'pending';
          const { x, y } = n.position;
          const inP = portPos(n, 'in');
          const outP = portPos(n, 'out');
          return (
            <g key={n.id} data-testid={`node-${n.id}`} transform={`translate(${x},${y})`}>
              <rect
                width={NODE_W}
                height={NODE_HEADER_H + NODE_BODY_H}
                rx={10}
                className={`node ${selected ? 'selected' : ''}`}
                style={{ stroke: selected ? 'var(--accent)' : STATUS_COLOR[status] }}
                onMouseDown={(e) => onNodeMouseDown(e, n.id)}
              />
              <rect width={NODE_W} height={NODE_HEADER_H} rx={10} className="node-header" onMouseDown={(e) => onNodeMouseDown(e, n.id)} />
              <rect y={NODE_HEADER_H - 10} width={NODE_W} height={10} className="node-header" onMouseDown={(e) => onNodeMouseDown(e, n.id)} />
              <text x={12} y={23} className="node-title" onMouseDown={(e) => onNodeMouseDown(e, n.id)}>
                {n.name}
              </text>
              <text x={12} y={NODE_HEADER_H + 20} className="node-kind" onMouseDown={(e) => onNodeMouseDown(e, n.id)}>
                {def.title}
              </text>
              <text x={12} y={NODE_HEADER_H + 38} className="node-status" onMouseDown={(e) => onNodeMouseDown(e, n.id)}>
                {statusText(status)}
              </text>
              {def.inputs.length > 0 && (
                <circle
                  data-testid={`port-in-${n.id}`}
                  cx={inP.x - x}
                  cy={inP.y - y}
                  r={8}
                  className="port"
                  onMouseUp={(e) => onPortMouseUp(e, n.id, 'in')}
                />
              )}
              {def.hasOutput && (
                <circle
                  data-testid={`port-out-${n.id}`}
                  cx={outP.x - x}
                  cy={outP.y - y}
                  r={8}
                  className="port"
                  onMouseDown={(e) => onPortMouseDown(e, n.id, 'out')}
                />
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function statusText(s: NodeRunStatus): string {
  switch (s) {
    case 'pending':
      return '待运行';
    case 'running':
      return '运行中…';
    case 'ok':
      return '成功';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    case 'skipped':
      return '已跳过';
  }
}
