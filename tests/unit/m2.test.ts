/**
 * M2 单测：12 种新节点、列推断扩展、图校验扩展、调试模式、多输出路由。
 */
import { describe, expect, it } from 'vitest';
import { getNodeDef, listNodeDefs, isSingleTable, normalizeOutputs } from '../../src/engine/nodes';
import { inferOutputColumns, inferInputColumns, validateGraph, canRun } from '../../src/engine/graph';
import { LocalBackend, RunManager } from '../../src/engine/executor';
import type { DataTable, Row, WorkflowGraph } from '../../src/engine/types';

function one(r: DataTable | Record<string, DataTable>): DataTable {
  if (!isSingleTable(r)) throw new Error('期望单表输出');
  return r;
}

function exec(kind: string, params: Record<string, unknown>, inputs: Record<string, DataTable> = {}): DataTable {
  return one(getNodeDef(kind).execute(params, inputs));
}

const T = (columns: string[], rows: Row[]): DataTable => ({ columns, rows });
const N = (id: string, kind: string, params: Record<string, unknown> = {}): WorkflowGraph['nodes'][number] => ({
  id,
  kind: kind as WorkflowGraph['nodes'][number]['kind'],
  name: id,
  params,
  position: { x: 0, y: 0 },
});

describe('M2 注册表', () => {
  it('16 种节点全部注册', () => {
    const kinds = listNodeDefs().map((d) => d.kind);
    for (const k of [
      'csv-input', 'json-input', 'synthetic-input', 'filter', 'computed-column',
      'select-columns', 'branch', 'join', 'union', 'dedupe', 'aggregate',
      'sort', 'limit', 'assert', 'chart', 'output',
    ]) {
      expect(kinds).toContain(k);
    }
    expect(kinds).toHaveLength(16);
  });

  it('branch 有两个具名输出，join 有两个具名输入', () => {
    expect(getNodeDef('branch').outputs).toEqual(['true', 'false']);
    expect(getNodeDef('join').inputs).toEqual(['in', 'in2']);
    expect(getNodeDef('union').inputs).toEqual(['in', 'in2']);
    expect(getNodeDef('chart').hasOutput).toBe(false);
  });

  it('normalizeOutputs / isSingleTable', () => {
    const t = T(['a'], [{ a: 1 }]);
    expect(isSingleTable(t)).toBe(true);
    expect(isSingleTable({ true: t, false: t })).toBe(false);
    const def = getNodeDef('filter');
    expect(normalizeOutputs(def, t)).toEqual({ out: t });
    const bdef = getNodeDef('branch');
    expect(normalizeOutputs(bdef, { true: t, false: t })).toEqual({ true: t, false: t });
  });
});

describe('M2 输入节点', () => {
  it('json-input 解析数组并补 null', () => {
    const out = exec('json-input', { jsonText: '[{"a":1,"b":"x"},{"a":2}]' });
    expect(out.columns).toEqual(['a', 'b']);
    expect(out.rows).toEqual([
      { a: 1, b: 'x' },
      { a: 2, b: null },
    ]);
  });

  it('json-input 接受单个对象', () => {
    const out = exec('json-input', { jsonText: '{"a":1}' });
    expect(out.rows).toHaveLength(1);
  });

  it('json-input 非法 JSON 报错', () => {
    expect(() => exec('json-input', { jsonText: '{bad' })).toThrow(/JSON 解析失败/);
  });

  it('json-input 非对象元素报错', () => {
    expect(() => exec('json-input', { jsonText: '[1,2]' })).toThrow(/必须为普通对象/);
  });

  it('json-input 嵌套对象报错', () => {
    expect(() => exec('json-input', { jsonText: '[{"a":{"x":1}}]' })).toThrow(/不支持的单元格类型/);
  });

  it('synthetic-input 固定种子可复现', () => {
    const p = { rows: 50, seed: 7, columns: 'id,name,age,active' };
    const a = exec('synthetic-input', p);
    const b = exec('synthetic-input', p);
    expect(a).toEqual(b);
    expect(a.columns).toEqual(['id', 'name', 'age', 'active']);
    expect(a.rows).toHaveLength(50);
    expect(a.rows[0]!['id']).toBe(1);
    expect(typeof a.rows[0]!['active']).toBe('boolean');
  });

  it('synthetic-input 不同种子结果不同', () => {
    const a = exec('synthetic-input', { rows: 10, seed: 1, columns: 'age' });
    const b = exec('synthetic-input', { rows: 10, seed: 2, columns: 'age' });
    expect(a.rows).not.toEqual(b.rows);
  });

  it('synthetic-input 非法行数报错', () => {
    expect(() => exec('synthetic-input', { rows: 0, seed: 1, columns: 'a' })).toThrow(/行数/);
    expect(() => exec('synthetic-input', { rows: 2.5, seed: 1, columns: 'a' })).toThrow(/行数/);
  });
});

describe('M2 变换节点', () => {
  const table = T(['name', 'age', 'city'], [
    { name: '张三', age: 28, city: '北京' },
    { name: '李四', age: 17, city: '上海' },
    { name: '王五', age: 35, city: '北京' },
  ]);

  it('select-columns 选择+重排+重命名', () => {
    const out = exec('select-columns', { columns: 'city,age', renames: 'age:年龄' }, { in: table });
    expect(out.columns).toEqual(['city', '年龄']);
    expect(out.rows[0]).toEqual({ city: '北京', 年龄: 28 });
  });

  it('select-columns 空选择保留全部', () => {
    const out = exec('select-columns', { columns: '', renames: '' }, { in: table });
    expect(out.columns).toEqual(['name', 'age', 'city']);
  });

  it('select-columns 不存在字段报错', () => {
    expect(() => exec('select-columns', { columns: 'nope', renames: '' }, { in: table })).toThrow(/不存在字段/);
  });

  it('select-columns 重命名冲突报错', () => {
    expect(() => exec('select-columns', { columns: '', renames: 'age:city' }, { in: table })).toThrow(/重名字段/);
  });

  it('branch 分流两表行数守恒', () => {
    const res = getNodeDef('branch').execute({ condition: '$age >= 18' }, { in: table });
    if (isSingleTable(res)) throw new Error('branch 应返回多表');
    expect(res['true']!.rows.map((r) => r['name'])).toEqual(['张三', '王五']);
    expect(res['false']!.rows.map((r) => r['name'])).toEqual(['李四']);
    expect(res['true']!.rows.length + res['false']!.rows.length).toBe(3);
  });

  it('branch 引用不存在字段报错', () => {
    expect(() => getNodeDef('branch').execute({ condition: '$nope > 1' }, { in: table })).toThrow(/不存在的字段/);
  });

  it('join inner 基本连接', () => {
    const left = T(['id', 'name'], [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
      { id: 3, name: 'c' },
    ]);
    const right = T(['id', 'city'], [
      { id: 1, city: '北京' },
      { id: 2, city: '上海' },
    ]);
    const out = exec('join', { joinType: 'inner', keys: 'id' }, { in: left, in2: right });
    expect(out.columns).toEqual(['id', 'name', 'city']);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]).toEqual({ id: 1, name: 'a', city: '北京' });
  });

  it('join left 保留左表无匹配行', () => {
    const left = T(['id', 'name'], [
      { id: 1, name: 'a' },
      { id: 3, name: 'c' },
    ]);
    const right = T(['id', 'city'], [{ id: 1, city: '北京' }]);
    const out = exec('join', { joinType: 'left', keys: 'id' }, { in: left, in2: right });
    expect(out.rows).toHaveLength(2);
    expect(out.rows[1]).toEqual({ id: 3, name: 'c', city: null });
  });

  it('join 列名冲突右表加 _right 后缀', () => {
    const left = T(['id', 'name'], [{ id: 1, name: '左' }]);
    const right = T(['id', 'name'], [{ id: 1, name: '右' }]);
    const out = exec('join', { joinType: 'inner', keys: 'id' }, { in: left, in2: right });
    expect(out.columns).toEqual(['id', 'name', 'name_right']);
    expect(out.rows[0]).toEqual({ id: 1, name: '左', name_right: '右' });
  });

  it('join 一对多产生全部匹配行', () => {
    const left = T(['id'], [{ id: 1 }]);
    const right = T(['id', 'v'], [
      { id: 1, v: 'x' },
      { id: 1, v: 'y' },
    ]);
    const out = exec('join', { joinType: 'inner', keys: 'id' }, { in: left, in2: right });
    expect(out.rows).toHaveLength(2);
  });

  it('join 空键不匹配', () => {
    const left = T(['id'], [{ id: null }]);
    const right = T(['id'], [{ id: null }]);
    const out = exec('join', { joinType: 'inner', keys: 'id' }, { in: left, in2: right });
    expect(out.rows).toHaveLength(0);
  });

  it('join 关联键类型冲突报错', () => {
    const left = T(['id'], [{ id: 1 }]);
    const right = T(['id'], [{ id: 'x' }]);
    expect(() => exec('join', { joinType: 'inner', keys: 'id' }, { in: left, in2: right })).toThrow(/类型冲突/);
  });

  it('join 数字与数字字符串类型冲突报错（严格同类型）', () => {
    const left = T(['id'], [{ id: 1 }]);
    const right = T(['id'], [{ id: '1' }]);
    expect(() => exec('join', { joinType: 'left', keys: 'id' }, { in: left, in2: right })).toThrow(/类型冲突/);
  });

  it('join 关联键缺失报错', () => {
    const left = T(['id'], [{ id: 1 }]);
    const right = T(['oid'], [{ oid: 1 }]);
    expect(() => exec('join', { joinType: 'inner', keys: 'id' }, { in: left, in2: right })).toThrow(/右表/);
  });

  it('union 合并并按左表列对齐', () => {
    const a = T(['x', 'y'], [{ x: 1, y: 'a' }]);
    const b = T(['y', 'x'], [{ y: 'b', x: 2 }]);
    const out = exec('union', {}, { in: a, in2: b });
    expect(out.columns).toEqual(['x', 'y']);
    expect(out.rows).toEqual([
      { x: 1, y: 'a' },
      { x: 2, y: 'b' },
    ]);
  });

  it('union 结构不兼容报错', () => {
    const a = T(['x'], [{ x: 1 }]);
    const b = T(['x', 'y'], [{ x: 1, y: 2 }]);
    expect(() => exec('union', {}, { in: a, in2: b })).toThrow(/结构不兼容/);
  });

  it('dedupe 按字段去重保留首次', () => {
    const t = T(['id', 'v'], [
      { id: 1, v: 'a' },
      { id: 1, v: 'b' },
      { id: 2, v: 'c' },
    ]);
    const out = exec('dedupe', { keys: 'id' }, { in: t });
    expect(out.rows).toEqual([
      { id: 1, v: 'a' },
      { id: 2, v: 'c' },
    ]);
  });

  it('dedupe 空字段按整行去重', () => {
    const t = T(['id'], [{ id: 1 }, { id: 1 }, { id: 2 }]);
    const out = exec('dedupe', { keys: '' }, { in: t });
    expect(out.rows).toHaveLength(2);
  });

  it('aggregate 分组聚合', () => {
    const t = T(['city', 'amount'], [
      { city: '北京', amount: 100 },
      { city: '北京', amount: 200 },
      { city: '上海', amount: 50 },
      { city: '上海', amount: null },
    ]);
    const out = exec(
      'aggregate',
      { groupBy: 'city', aggregations: 'total:sum(amount)\nn:count(*)\nmc:count(amount)\navg:avg(amount)\nmin:min(amount)\nmax:max(amount)' },
      { in: t },
    );
    expect(out.columns).toEqual(['city', 'total', 'n', 'mc', 'avg', 'min', 'max']);
    const bj = out.rows.find((r) => r['city'] === '北京')!;
    expect(bj).toMatchObject({ total: 300, n: 2, mc: 2, avg: 150, min: 100, max: 200 });
    const sh = out.rows.find((r) => r['city'] === '上海')!;
    expect(sh).toMatchObject({ total: 50, n: 2, mc: 1, avg: 50 });
  });

  it('aggregate 全局聚合（空分组）', () => {
    const t = T(['v'], [{ v: 10 }, { v: 20 }]);
    const out = exec('aggregate', { groupBy: '', aggregations: 'total:sum(v)' }, { in: t });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toEqual({ total: 30 });
  });

  it('aggregate 空表全局聚合返回一行', () => {
    const t = T(['v'], []);
    const out = exec('aggregate', { groupBy: '', aggregations: 'n:count(*)\ntotal:sum(v)' }, { in: t });
    expect(out.rows).toEqual([{ n: 0, total: 0 }]);
  });

  it('aggregate 非法聚合项报错', () => {
    const t = T(['v'], [{ v: 1 }]);
    expect(() => exec('aggregate', { groupBy: '', aggregations: 'bad' }, { in: t })).toThrow(/格式错误/);
    expect(() => exec('aggregate', { groupBy: '', aggregations: '' }, { in: t })).toThrow(/不能为空/);
  });

  it('aggregate 输出列重复报错', () => {
    const t = T(['v'], [{ v: 1 }]);
    expect(() => exec('aggregate', { groupBy: '', aggregations: 'a:sum(v)\na:count(*)' }, { in: t })).toThrow(/重复/);
  });

  it('sort 多字段稳定排序，null 最后', () => {
    const t = T(['city', 'age'], [
      { city: '北京', age: 30 },
      { city: '上海', age: null },
      { city: '北京', age: 20 },
      { city: '北京', age: null },
    ]);
    const out = exec('sort', { sortKeys: 'city asc\nage desc' }, { in: t });
    expect(out.rows.map((r) => [r['city'], r['age']])).toEqual([
      ['上海', null],
      ['北京', 30],
      ['北京', 20],
      ['北京', null],
    ]);
  });

  it('sort 同值保持原有顺序（稳定）', () => {
    const t = T(['k', 'seq'], [
      { k: 'a', seq: 1 },
      { k: 'a', seq: 2 },
      { k: 'a', seq: 3 },
    ]);
    const out = exec('sort', { sortKeys: 'k asc' }, { in: t });
    expect(out.rows.map((r) => r['seq'])).toEqual([1, 2, 3]);
  });

  it('sort 不存在字段报错', () => {
    const t = T(['a'], [{ a: 1 }]);
    expect(() => exec('sort', { sortKeys: 'nope desc' }, { in: t })).toThrow(/不存在字段/);
  });

  it('limit 取前 N 行', () => {
    const t = T(['a'], [{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(exec('limit', { n: 2 }, { in: t }).rows).toHaveLength(2);
  });

  it('limit 非法 N 报错', () => {
    const t = T(['a'], [{ a: 1 }]);
    expect(() => exec('limit', { n: 0 }, { in: t })).toThrow(/正整数/);
    expect(() => exec('limit', { n: 2.5 }, { in: t })).toThrow(/正整数/);
    expect(() => exec('limit', { n: 'x' }, { in: t })).toThrow(/正整数/);
  });

  it('assert 通过时透传', () => {
    const t = T(['age'], [{ age: 20 }, { age: 30 }]);
    const out = exec('assert', { condition: '$age >= 0' }, { in: t });
    expect(out.rows).toHaveLength(2);
  });

  it('assert 失败时报错并给出失败行号', () => {
    const t = T(['age'], [{ age: 20 }, { age: -1 }, { age: -2 }]);
    expect(() => exec('assert', { condition: '$age >= 0' }, { in: t })).toThrow(/数据断言失败: 2 行.*第 2、3 行/);
  });

  it('chart 柱状图按 x 分组求和', () => {
    const t = T(['city', 'amount'], [
      { city: '北京', amount: 100 },
      { city: '北京', amount: 200 },
      { city: '上海', amount: 50 },
    ]);
    const out = exec('chart', { chartType: 'bar', xColumn: 'city', yColumn: 'amount' }, { in: t });
    expect(out.columns).toEqual(['x', 'y']);
    expect(out.rows).toEqual([
      { x: '上海', y: 50 },
      { x: '北京', y: 300 },
    ]);
  });

  it('chart 散点图要求数值', () => {
    const t = T(['x', 'y'], [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    const out = exec('chart', { chartType: 'scatter', xColumn: 'x', yColumn: 'y' }, { in: t });
    expect(out.rows).toHaveLength(2);
    const bad = T(['x', 'y'], [{ x: 'a', y: 2 }]);
    expect(() => exec('chart', { chartType: 'scatter', xColumn: 'x', yColumn: 'y' }, { in: bad })).toThrow(/散点图要求/);
  });

  it('chart y 含非数值报错', () => {
    const t = T(['city', 'amount'], [{ city: '北京', amount: 'x' }]);
    expect(() => exec('chart', { chartType: 'bar', xColumn: 'city', yColumn: 'amount' }, { in: t })).toThrow(/非数值/);
  });
});

describe('M2 列推断（全节点/多输入）', () => {
  function g2(): WorkflowGraph {
    return {
      revision: 1,
      nodes: [
        N('j', 'json-input', { jsonText: '[{"a":1,"b":"x"}]' }),
        N('s', 'synthetic-input', { rows: 5, seed: 1, columns: 'id,age' }),
        N('sel', 'select-columns', { columns: 'b', renames: 'b:bb' }),
        N('agg', 'aggregate', { groupBy: 'bb', aggregations: 'n:count(*)' }),
        N('o', 'output', {}),
      ],
      edges: [
        { id: 'e1', source: 'j', target: 'sel' },
        { id: 'e2', source: 'sel', target: 'agg' },
        { id: 'e3', source: 'agg', target: 'o' },
      ],
    };
  }

  it('json/synthetic/select/aggregate 列推断', () => {
    const g = g2();
    expect(inferOutputColumns(g, 'j')).toEqual(['a', 'b']);
    expect(inferOutputColumns(g, 's')).toEqual(['id', 'age']);
    expect(inferOutputColumns(g, 'sel')).toEqual(['bb']);
    expect(inferOutputColumns(g, 'agg')).toEqual(['bb', 'n']);
    expect(inferOutputColumns(g, 'o')).toEqual(['bb', 'n']);
  });

  it('select-columns 引用不存在字段时回退为 null', () => {
    const g = g2();
    g.nodes.find((n) => n.id === 'sel')!.params = { columns: 'nope', renames: '' };
    expect(inferOutputColumns(g, 'sel')).toBeNull();
  });

  it('join 多输入列推断（含冲突重命名）', () => {
    const g: WorkflowGraph = {
      revision: 1,
      nodes: [
        N('l', 'csv-input', { csvText: 'id,name\n1,a\n' }),
        N('r', 'csv-input', { csvText: 'id,name\n1,b\n' }),
        N('j', 'join', { joinType: 'inner', keys: 'id' }),
      ],
      edges: [
        { id: 'e1', source: 'l', target: 'j', targetPort: 'in' },
        { id: 'e2', source: 'r', target: 'j', targetPort: 'in2' },
      ],
    };
    expect(inferOutputColumns(g, 'j')).toEqual(['id', 'name', 'name_right']);
    expect(inferInputColumns(g, 'j', 'in')).toEqual(['id', 'name']);
    expect(inferInputColumns(g, 'j', 'in2')).toEqual(['id', 'name']);
    expect(inferInputColumns(g, 'j')).toEqual(['id', 'name']); // 缺省首个端口
  });

  it('union 列推断沿用左表', () => {
    const g: WorkflowGraph = {
      revision: 1,
      nodes: [
        N('a', 'csv-input', { csvText: 'x,y\n1,2\n' }),
        N('b', 'csv-input', { csvText: 'y,x\n3,4\n' }),
        N('u', 'union', {}),
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'u', targetPort: 'in' },
        { id: 'e2', source: 'b', target: 'u', targetPort: 'in2' },
      ],
    };
    expect(inferOutputColumns(g, 'u')).toEqual(['x', 'y']);
  });

  it('branch/chart 列推断', () => {
    const g: WorkflowGraph = {
      revision: 1,
      nodes: [
        N('c', 'csv-input', { csvText: 'city,amount\n北京,100\n' }),
        N('b', 'branch', { condition: '$amount > 10' }),
        N('ch', 'chart', { chartType: 'bar', xColumn: 'city', yColumn: 'amount' }),
      ],
      edges: [
        { id: 'e1', source: 'c', target: 'b' },
        { id: 'e2', source: 'b', target: 'ch', sourcePort: 'false' },
      ],
    };
    expect(inferOutputColumns(g, 'b')).toEqual(['city', 'amount']);
    expect(inferOutputColumns(g, 'ch')).toEqual(['x', 'y']);
  });
});

describe('M2 图校验扩展', () => {
  it('join 缺少 in2 输入报错', () => {
    const g: WorkflowGraph = {
      revision: 1,
      nodes: [N('l', 'csv-input', { csvText: 'id\n1\n' }), N('j', 'join', { keys: 'id' })],
      edges: [{ id: 'e1', source: 'l', target: 'j', targetPort: 'in' }],
    };
    const { ok, issues } = canRun(g);
    expect(ok).toBe(false);
    expect(issues.some((i) => i.message.includes('缺少输入连线') && i.message.includes('in2'))).toBe(true);
  });

  it('非法输入端口报错', () => {
    const g: WorkflowGraph = {
      revision: 1,
      nodes: [N('l', 'csv-input', { csvText: 'id\n1\n' }), N('f', 'filter', { condition: '$id > 0' })],
      edges: [{ id: 'e1', source: 'l', target: 'f', targetPort: 'in2' }],
    };
    expect(canRun(g).ok).toBe(false);
    expect(validateGraph(g).some((i) => i.message.includes('非法的输入端口'))).toBe(true);
  });

  it('非法输出端口报错', () => {
    const g: WorkflowGraph = {
      revision: 1,
      nodes: [
        N('b', 'branch', { condition: '$id > 0' }),
        N('c', 'csv-input', { csvText: 'id\n1\n' }),
        N('o', 'output', {}),
      ],
      edges: [
        { id: 'e1', source: 'c', target: 'b' },
        { id: 'e2', source: 'b', target: 'o', sourcePort: 'maybe' },
      ],
    };
    expect(validateGraph(g).some((i) => i.message.includes('非法的输出端口'))).toBe(true);
  });

  it('单输入端口多条连线报错', () => {
    const g: WorkflowGraph = {
      revision: 1,
      nodes: [
        N('a', 'csv-input', { csvText: 'id\n1\n' }),
        N('b', 'csv-input', { csvText: 'id\n2\n' }),
        N('f', 'filter', { condition: '$id > 0' }),
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'f' },
        { id: 'e2', source: 'b', target: 'f' },
      ],
    };
    const issues = validateGraph(g);
    expect(issues.some((i) => i.message.includes('只允许一条'))).toBe(true);
    expect(canRun(g).ok).toBe(false);
  });

  it('union 结构不兼容在运行前识别', () => {
    const g: WorkflowGraph = {
      revision: 1,
      nodes: [
        N('a', 'csv-input', { csvText: 'x\n1\n' }),
        N('b', 'csv-input', { csvText: 'x,y\n1,2\n' }),
        N('u', 'union', {}),
        N('o', 'output', {}),
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'u', targetPort: 'in' },
        { id: 'e2', source: 'b', target: 'u', targetPort: 'in2' },
        { id: 'e3', source: 'u', target: 'o' },
      ],
    };
    const { ok, issues } = canRun(g);
    expect(ok).toBe(false);
    expect(issues.some((i) => i.message.includes('结构不兼容'))).toBe(true);
  });

  it('结果节点连接下游给出警告', () => {
    const g: WorkflowGraph = {
      revision: 1,
      nodes: [
        N('a', 'csv-input', { csvText: 'x\n1\n' }),
        N('o', 'output', {}),
        N('o2', 'output', {}),
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'o' },
        { id: 'e2', source: 'o', target: 'o2' },
      ],
    };
    const issues = validateGraph(g);
    expect(issues.some((i) => i.severity === 'warning' && i.message.includes('不应连接下游'))).toBe(true);
  });

  it('sort 引用不存在字段在运行前识别', () => {
    const g: WorkflowGraph = {
      revision: 1,
      nodes: [N('a', 'csv-input', { csvText: 'x\n1\n' }), N('s', 'sort', { sortKeys: 'nope desc' })],
      edges: [{ id: 'e1', source: 'a', target: 's' }],
    };
    const { ok, issues } = canRun(g);
    expect(ok).toBe(false);
    expect(issues.some((i) => i.message.includes('不存在的字段'))).toBe(true);
  });

  it('aggregate 聚合字段不存在在运行前识别', () => {
    const g: WorkflowGraph = {
      revision: 1,
      nodes: [N('a', 'csv-input', { csvText: 'x\n1\n' }), N('ag', 'aggregate', { groupBy: '', aggregations: 't:sum(nope)' })],
      edges: [{ id: 'e1', source: 'a', target: 'ag' }],
    };
    expect(canRun(g).ok).toBe(false);
  });
});

describe('M2 执行器：多输出与调试', () => {
  const csvText = 'name,age\n苹果,20\n香蕉,3\n';

  function branchGraph(): WorkflowGraph {
    return {
      revision: 1,
      nodes: [
        N('n1', 'csv-input', { csvText }),
        N('n2', 'branch', { condition: '$age >= 18' }),
        N('n3', 'output', {}),
        N('n4', 'output', {}),
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3', sourcePort: 'true' },
        { id: 'e3', source: 'n2', target: 'n4', sourcePort: 'false' },
      ],
    };
  }

  it('branch 双输出端到端：按源端口路由', async () => {
    const mgr = new RunManager(new LocalBackend());
    const record = await mgr.start(branchGraph());
    expect(record.nodeStates['n2']?.status).toBe('ok');
    // 主输出 = true 端口
    expect(record.outputs['n2']?.rows.map((r) => r['name'])).toEqual(['苹果']);
    // 全端口快照
    expect(record.portOutputs['n2']?.['true']?.rows).toHaveLength(1);
    expect(record.portOutputs['n2']?.['false']?.rows.map((r) => r['name'])).toEqual(['香蕉']);
    // 下游按源端口拿到各自的表
    expect(record.outputs['n3']?.rows).toHaveLength(1);
    expect(record.outputs['n4']?.rows).toHaveLength(1);
    expect(record.outputs['n4']?.rows[0]?.['name']).toBe('香蕉');
    mgr.dispose();
  });

  it('join 双输入端到端（in/in2 端口路由）', async () => {
    const g: WorkflowGraph = {
      revision: 1,
      nodes: [
        N('l', 'csv-input', { csvText: 'id,name\n1,a\n2,b\n' }),
        N('r', 'csv-input', { csvText: 'id,city\n1,北京\n2,上海\n' }),
        N('j', 'join', { joinType: 'inner', keys: 'id' }),
        N('o', 'output', {}),
      ],
      edges: [
        { id: 'e1', source: 'l', target: 'j', targetPort: 'in' },
        { id: 'e2', source: 'r', target: 'j', targetPort: 'in2' },
        { id: 'e3', source: 'j', target: 'o' },
      ],
    };
    const mgr = new RunManager(new LocalBackend());
    const record = await mgr.start(g);
    expect(record.nodeStates['j']?.status).toBe('ok');
    expect(record.outputs['o']?.rows).toEqual([
      { id: 1, name: 'a', city: '北京' },
      { id: 2, name: 'b', city: '上海' },
    ]);
    mgr.dispose();
  });

  it('调试模式：断点暂停 → 继续', async () => {
    const g: WorkflowGraph = {
      revision: 1,
      nodes: [
        N('n1', 'csv-input', { csvText }),
        { ...N('n2', 'filter', { condition: '$age >= 18' }), breakpoint: true },
        N('n3', 'output', {}),
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3' },
      ],
    };
    const paused: string[] = [];
    const mgr = new RunManager(new LocalBackend(), { onDebugPause: (id) => paused.push(id) });
    const promise = mgr.start(g, { debug: true });
    await waitFor(() => paused.includes('n2'));
    expect(mgr.debugPaused).toBe(true);
    mgr.resumeDebug();
    const record = await promise;
    expect(record.nodeStates['n2']?.status).toBe('ok');
    expect(record.nodeStates['n3']?.status).toBe('ok');
    expect(record.outputs['n3']?.rows).toHaveLength(1);
    mgr.dispose();
  });

  it('调试模式：单步执行', async () => {
    const g: WorkflowGraph = {
      revision: 1,
      nodes: [
        N('n1', 'csv-input', { csvText }),
        { ...N('n2', 'filter', { condition: '$age >= 18' }), breakpoint: true },
        N('n3', 'output', {}),
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3' },
      ],
    };
    const paused: string[] = [];
    const mgr = new RunManager(new LocalBackend(), { onDebugPause: (id) => paused.push(id) });
    const promise = mgr.start(g, { debug: true });
    await waitFor(() => paused.includes('n2'));
    // 单步：执行 n2，然后在 n3 前暂停
    mgr.stepDebug();
    await waitFor(() => paused.includes('n3'));
    expect(paused).toEqual(['n2', 'n3']);
    mgr.resumeDebug();
    const record = await promise;
    expect(record.nodeStates['n3']?.status).toBe('ok');
    mgr.dispose();
  });

  it('调试模式：外部暂停请求在节点边界生效', async () => {
    const g: WorkflowGraph = {
      revision: 1,
      nodes: [N('n1', 'csv-input', { csvText }), N('n2', 'filter', { condition: '$age >= 18' }), N('n3', 'output', {})],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3' },
      ],
    };
    const paused: string[] = [];
    const mgr = new RunManager(new LocalBackend(), { onDebugPause: (id) => paused.push(id) });
    mgr.pauseDebug(); // 启动前请求暂停
    const promise = mgr.start(g, { debug: true });
    await waitFor(() => paused.length > 0);
    expect(paused[0]).toBe('n1');
    mgr.resumeDebug();
    await promise;
    mgr.dispose();
  });

  it('非调试模式不受断点影响', async () => {
    const g: WorkflowGraph = {
      revision: 1,
      nodes: [N('n1', 'csv-input', { csvText }), { ...N('n2', 'filter', { condition: '$age >= 18' }), breakpoint: true }],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    };
    const paused: string[] = [];
    const mgr = new RunManager(new LocalBackend(), { onDebugPause: (id) => paused.push(id) });
    const record = await mgr.start(g); // 非调试
    expect(paused).toHaveLength(0);
    expect(record.nodeStates['n2']?.status).toBe('ok');
    mgr.dispose();
  });
});

/** 轮询等待条件成立（超时抛错）。 */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}
