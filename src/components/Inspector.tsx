/**
 * 节点检查器：按节点定义的 param schema 渲染参数表单。
 * 表达式字段附带函数白名单提示；修改即 dispatch updateParam。
 */
import type { NodeInstance } from '../engine/types';
import { getNodeDef, listNodeDefs } from '../engine/nodes';
import { listFunctions } from '../engine/expressions';
import type { ParamField } from '../engine/nodes';

interface Props {
  node: NodeInstance | null;
  onUpdateParam(id: string, key: string, value: unknown): void;
  onRename(id: string, name: string): void;
}

function FieldInput(props: { field: ParamField; value: unknown; onChange(v: unknown): void; testId: string }) {
  const { field, value, onChange, testId } = props;
  const str = typeof value === 'string' ? value : (value ?? '') as string;
  switch (field.type) {
    case 'textarea':
    case 'expression':
      return (
        <div className="field">
          <label htmlFor={testId}>{field.label}</label>
          <textarea
            id={testId}
            data-testid={testId}
            value={str}
            rows={field.type === 'expression' ? 3 : 6}
            spellCheck={false}
            className={field.type === 'expression' ? 'mono' : undefined}
            onChange={(e) => onChange(e.target.value)}
          />
          {field.help && <p className="help">{field.help}</p>}
          {field.type === 'expression' && (
            <details className="help">
              <summary>可用函数（{listFunctions().length} 个）</summary>
              <p className="mono small">{listFunctions().join(', ')}</p>
              <p>字段引用: $字段名（如 $age）；含空格的字段用 $"我的 字段"。</p>
            </details>
          )}
        </div>
      );
    case 'number':
      return (
        <div className="field">
          <label htmlFor={testId}>{field.label}</label>
          <input
            id={testId}
            data-testid={testId}
            type="number"
            value={typeof value === 'number' ? value : ''}
            min={field.min}
            max={field.max}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          />
          {field.help && <p className="help">{field.help}</p>}
        </div>
      );
    case 'select':
      return (
        <div className="field">
          <label htmlFor={testId}>{field.label}</label>
          <select id={testId} data-testid={testId} value={str} onChange={(e) => onChange(e.target.value)}>
            {(field.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {field.help && <p className="help">{field.help}</p>}
        </div>
      );
    case 'boolean':
      return (
        <div className="field">
          <label>
            <input
              data-testid={testId}
              type="checkbox"
              checked={value === true}
              onChange={(e) => onChange(e.target.checked)}
            />{' '}
            {field.label}
          </label>
          {field.help && <p className="help">{field.help}</p>}
        </div>
      );
    default:
      return (
        <div className="field">
          <label htmlFor={testId}>{field.label}</label>
          <input id={testId} data-testid={testId} type="text" value={str} onChange={(e) => onChange(e.target.value)} />
          {field.help && <p className="help">{field.help}</p>}
        </div>
      );
  }
}

export default function Inspector({ node, onUpdateParam, onRename }: Props) {
  if (!node) {
    return (
      <div className="inspector" data-testid="inspector-empty">
        <h3>检查器</h3>
        <p className="muted">点击画布上的节点以编辑参数；从左侧面板添加节点。</p>
        <h4>节点类型（M1：{listNodeDefs().length} 种）</h4>
        <ul className="node-list">
          {listNodeDefs().map((d) => (
            <li key={d.kind}>
              <strong>{d.title}</strong>
              <span className="muted"> — {d.description}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  let def;
  try {
    def = getNodeDef(node.kind);
  } catch {
    return <div className="inspector"><p>未知节点类型</p></div>;
  }
  return (
    <div className="inspector" data-testid="inspector">
      <h3>检查器</h3>
      <div className="field">
        <label htmlFor="node-name">节点名称</label>
        <input
          id="node-name"
          data-testid="node-name"
          type="text"
          value={node.name}
          onChange={(e) => onRename(node.id, e.target.value)}
        />
      </div>
      <p className="muted small">
        类型：{def.title} · {def.category}
      </p>
      {def.params.map((f) => (
        <FieldInput
          key={f.key}
          field={f}
          testId={`param-${f.key}`}
          value={node.params[f.key] ?? f.defaultValue}
          onChange={(v) => onUpdateParam(node.id, f.key, v)}
        />
      ))}
    </div>
  );
}
