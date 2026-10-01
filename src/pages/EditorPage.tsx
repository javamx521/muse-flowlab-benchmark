/**
 * 编辑器页面：工作台布局。
 * 左侧节点面板 / 中央画布 / 右侧检查器+问题 / 底部结果面板 / 顶栏运行控制。
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Canvas from '../components/Canvas';
import Inspector from '../components/Inspector';
import DataTableView from '../components/DataTableView';
import { useEditor } from '../store/useEditor';
import { listNodeDefs, exportTableCsv } from '../engine/nodes';
import { APP_VERSION } from '../lib/version';
import { projectStore } from '../lib/projects';
import type { NodeKind, NodeRunStatus } from '../engine/types';

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

export default function EditorPage() {
  const { id = '' } = useParams();
  const meta = projectStore.get(id);
  const { state, actions } = useEditor(id, undefined, meta?.name);
  const [tab, setTab] = useState<'output' | 'log'>('output');
  const [resultsOpen, setResultsOpen] = useState(true);
  const [placeSeq, setPlaceSeq] = useState(0);

  const doc = state.doc;
  const graph = doc?.graph ?? null;

  const nodeStatus = useMemo(() => {
    const m: Record<string, NodeRunStatus> = {};
    if (state.run) {
      for (const [nid, info] of Object.entries(state.run.nodeStates)) m[nid] = info.status;
    }
    return m;
  }, [state.run]);

  const selectedNode = useMemo(
    () => graph?.nodes.find((n) => n.id === state.selection[0]) ?? null,
    [graph, state.selection],
  );

  const selectedOutput = useMemo(() => {
    if (!state.run || !selectedNode) return null;
    return state.run.outputs[selectedNode.id] ?? null;
  }, [state.run, selectedNode]);

  const errorIssues = state.issues.filter((i) => i.severity === 'error');
  const stale = state.run && doc && state.run.graphRevision !== doc.graph.revision;

  // Delete 键删除选中节点
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection.length > 0) {
        e.preventDefault();
        actions.deleteSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, state.selection]);

  // 参数/结构变化后刷新校验
  useEffect(() => {
    if (doc) actions.refreshIssues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.graph.revision, doc?.graph.nodes.length, doc?.graph.edges.length]);

  if (state.loading) return <div className="page"><p>加载中…</p></div>;
  if (state.loadError) return <div className="page"><p role="alert">加载失败：{state.loadError}</p></div>;
  // 未知项目 id：明确 404，不静默创建（深链接不代表数据已同步到本设备）
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
    // 新节点按 2 列网格排布，保证默认可视区（画布约 780x270 @720p）内不重叠、不被结果面板遮挡；
    // 更复杂的自动布局（自适应缩放）留待后续里程碑
    const i = placeSeq;
    setPlaceSeq(i + 1);
    const col = i % 2;
    const row = Math.floor(i / 2) % 6;
    const baseX = Math.max(20, (-state.viewport.x + 120) / state.viewport.k) + col * 260;
    const baseY = Math.max(20, (-state.viewport.y + 60) / state.viewport.k) + row * 110;
    actions.addNode(kind, baseX, baseY);
  };

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
        <button
          data-testid="run-btn"
          onClick={() => actions.run()}
          disabled={state.running || errorIssues.length > 0}
          title={errorIssues.length > 0 ? '存在校验错误，无法运行' : '运行工作流'}
        >
          {state.running ? '运行中…' : '运行'}
        </button>
        {state.running && (
          <button data-testid="cancel-btn" onClick={() => actions.cancelRun()}>
            取消
          </button>
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
          {listNodeDefs().map((d) => (
            <button key={d.kind} data-testid={`add-${d.kind}`} onClick={() => addNode(d.kind)} title={d.description}>
              + {d.title}
            </button>
          ))}
          <div className="palette-help">
            <p className="muted small">连线：从节点右侧端口拖到目标节点左侧端口。双击连线可删除。Delete 键删除选中节点。</p>
          </div>
        </aside>

        <main className="canvas-wrap">
          <Canvas
            graph={graph}
            selection={state.selection}
            viewport={state.viewport}
            nodeStatus={nodeStatus}
            onSelect={actions.select}
            onMoveNode={actions.moveNode}
            onMoveNodes={actions.moveNodes}
            onConnect={actions.connect}
            onDeleteEdge={actions.deleteEdge}
            onViewportChange={actions.setViewport}
          />
        </main>

        <aside className="side">
          <Inspector node={selectedNode} onUpdateParam={actions.updateParam} onRename={actions.renameNode} />
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
          {tab === 'output' && selectedOutput && selectedNode && (
            <button
              data-testid="download-csv"
              onClick={() => downloadCsv(`${selectedNode.name}.csv`, exportTableCsv(selectedOutput))}
            >
              下载 CSV
            </button>
          )}
        </div>
        {tab === 'output' ? (
          <DataTableView table={selectedOutput} title={selectedNode ? `节点「${selectedNode.name}」输出` : undefined} />
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
          FlowLab Studio v{APP_VERSION} · 本地运行 · M1 里程碑
        </span>
      </footer>
    </div>
  );
}
