/**
 * M1 引擎单元测试：CSV、表达式、节点、图算法、执行器、数据语义。
 * 全部使用真实断言；覆盖任务书 F03/F04/F05 的 M1 范围。
 */
import { describe, expect, it } from 'vitest';
import { parseCsv, csvToTable, tableToCsv, escapeFormulaCell } from '../../src/engine/csv';
import { compileExpr, ExprError, listFunctions } from '../../src/engine/expressions';
import { getNodeDef, listNodeDefs, isSingleTable } from '../../src/engine/nodes';
import type { DataTable } from '../../src/engine/types';

/** 取单表输出（多输出节点测试用 normalizeOutputs）。 */
function one(r: DataTable | Record<string, DataTable>): DataTable {
  if (!isSingleTable(r)) throw new Error('期望单表输出');
  return r;
}
import { topoSort, validateGraph, canRun, inferOutputColumns, inferInputColumns } from '../../src/engine/graph';
import { LocalBackend, RunManager } from '../../src/engine/executor';
import { strictEquals, keyHash, compareCells, toNumberStrict } from '../../src/engine/dataModel';
import type { CellValue, Row, WorkflowGraph } from '../../src/engine/types';

const ev = (src: string, row: Row = {}): CellValue => compileExpr(src).evaluate(row);

describe('CSV 解析', () => {
  it('解析基本 CSV 并推断类型', () => {
    const { table, warnings } = csvToTable('name,age,active\n张三,28,true\n李四,35,false\n');
    expect(warnings).toEqual([]);
    expect(table.columns).toEqual(['name', 'age', 'active']);
    expect(table.rows[0]).toEqual({ name: '张三', age: 28, active: true });
    expect(table.rows[1]).toEqual({ name: '李四', age: 35, active: false });
  });

  it('引号内逗号与换行', () => {
    const { table } = csvToTable('a,b\n"x,y","p\nq"\n');
    expect(table.rows[0]).toEqual({ a: 'x,y', b: 'p\nq' });
  });

  it('双引号转义', () => {
    const { table } = csvToTable('a\n"say ""hi"""\n');
    expect(table.rows[0]).toEqual({ a: 'say "hi"' });
  });

  it('空字符串保持为空字符串，不变 null', () => {
    const { table } = csvToTable('a,b\n,5\n');
    expect(table.rows[0]).toEqual({ a: '', b: 5 });
    expect(table.rows[0]!['a']).not.toBeNull();
  });

  it('列数不一致给出警告并补空', () => {
    const { table, warnings } = csvToTable('a,b,c\n1,2\n');
    expect(warnings.length).toBeGreaterThan(0);
    expect(table.rows[0]).toEqual({ a: 1, b: 2, c: '' });
  });

  it('重复列名给出警告', () => {
    const { warnings } = parseCsv('a,a\n1,2\n');
    expect(warnings.some((w) => w.includes('重复'))).toBe(true);
  });
});

describe('公式注入防护', () => {
  it('危险前缀加单引号转义', () => {
    expect(escapeFormulaCell('=1+1')).toBe("'=1+1");
    expect(escapeFormulaCell('+cmd')).toBe("'+cmd");
    expect(escapeFormulaCell('@x')).toBe("'@x");
  });

  it('正常负数不转义', () => {
    expect(escapeFormulaCell('-42')).toBe('-42');
    expect(escapeFormulaCell('-3.5')).toBe('-3.5');
    expect(escapeFormulaCell(-42)).toBe('-42');
  });

  it('导出 CSV 应用防护', () => {
    const csv = tableToCsv({ columns: ['a'], rows: [{ a: '=SUM(A1:A2)' }, { a: '-5' }] });
    expect(csv).toContain("'=SUM(A1:A2)");
    expect(csv).toContain('-5');
    expect(csv).not.toContain("'-5");
  });
});

describe('表达式语言', () => {
  it('算术与比较', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('10 / 4')).toBe(2.5);
    expect(ev('10 % 3')).toBe(1);
    expect(ev('2 > 1 && 3 < 4')).toBe(true);
  });

  it('字段访问与字符串比较', () => {
    const row = { age: 28, city: '北京' };
    expect(ev('$age >= 18', row)).toBe(true);
    expect(ev('$city == "北京"', row)).toBe(true);
    expect(ev('$city != "上海"', row)).toBe(true);
  });

  it('空值语义：null 参与运算得 null/false', () => {
    const row = { x: null as CellValue };
    expect(ev('$x + 1', row)).toBeNull();
    expect(ev('$x == null', row)).toBe(true);
    expect(ev('$x != null', row)).toBe(false);
    expect(ev('isNull($x)', row)).toBe(true);
  });

  it('数字与数字字符串严格区分', () => {
    expect(ev('42 == "42"')).toBe(false);
    expect(ev('42 != "42"')).toBe(true);
    expect(ev('toNumber("42") == 42')).toBe(true);
    expect(ev('toNumber("abc")', {})).toBeNull();
  });

  it('白名单函数', () => {
    expect(ev('abs(-3)')).toBe(3);
    expect(ev('round(3.14159, 2)')).toBe(3.14);
    expect(ev('upper("abc")')).toBe('ABC');
    expect(ev('contains("hello", "ell")')).toBe(true);
    expect(ev('if(1 > 2, "a", "b")')).toBe('b');
    expect(ev('coalesce(null, null, 5)')).toBe(5);
    expect(ev('len("你好")')).toBe(2);
    expect(listFunctions().length).toBeGreaterThanOrEqual(20);
  });

  it('拒绝未知函数与未知标识符', () => {
    expect(() => compileExpr('evil(1)')).toThrow(ExprError);
    expect(() => compileExpr('foo + 1')).toThrow(ExprError);
  });

  it('拒绝原型链/构造器越界', () => {
    expect(() => compileExpr('$__proto__')).toThrow(ExprError);
    expect(() => compileExpr('constructor')).toThrow(ExprError);
  });

  it('除零得 null 不抛错', () => {
    expect(ev('1 / 0')).toBeNull();
    expect(ev('1 % 0')).toBeNull();
  });

  it('长度与深度上限', () => {
    expect(() => compileExpr('1'.padEnd(2001, ' '))).toThrow(ExprError);
    expect(() => compileExpr('((((((((((((((((((((((((((((((((((1))))))))))))))))))))))))))))))))))')).toThrow(ExprError);
  });

  it('空表达式与非法字符拒绝', () => {
    expect(() => compileExpr('   ')).toThrow(ExprError);
    expect(() => compileExpr('1; DROP')).toThrow(ExprError);
    expect(() => compileExpr('`id`')).toThrow(ExprError);
  });

  it('未知字段引用抛错', () => {
    expect(() => ev('$nope + 1', { a: 1 })).toThrow(/未知字段/);
  });
});

describe('数据语义', () => {
  it('严格相等：跨类型不等，null 键不匹配', () => {
    expect(strictEquals(42, 42)).toBe(true);
    expect(strictEquals(42, '42')).toBe(false);
    expect(strictEquals(null, null)).toBe(false);
    expect(strictEquals('', null)).toBe(false);
  });

  it('keyHash 区分类型', () => {
    expect(keyHash([42])).not.toBe(keyHash(['42']));
    expect(keyHash([null])).not.toBe(keyHash(['']));
  });

  it('排序：null 最小，类型确定序', () => {
    const vals: CellValue[] = ['b', null, 2, 'a', 10, null, true];
    const sorted = [...vals].sort(compareCells);
    expect(sorted[0]).toBeNull();
    expect(sorted[1]).toBeNull();
  });

  it('严格数字解析', () => {
    expect(toNumberStrict('42')).toBe(42);
    expect(toNumberStrict(' 3.5 ')).toBe(3.5);
    expect(toNumberStrict('')).toBeNull();
    expect(toNumberStrict('12a')).toBeNull();
    expect(toNumberStrict('Infinity')).toBeNull();
    expect(toNumberStrict(null)).toBeNull();
  });
});

describe('节点执行', () => {
  const table = { columns: ['name', 'age', 'city'], rows: [
    { name: '张三', age: 28, city: '北京' },
    { name: '李四', age: 17, city: '上海' },
    { name: '王五', age: 35, city: '北京' },
  ] };

  it('注册表包含 M1 四种节点', () => {
    const kinds = listNodeDefs().map((d) => d.kind);
    expect(kinds).toContain('csv-input');
    expect(kinds).toContain('filter');
    expect(kinds).toContain('computed-column');
    expect(kinds).toContain('output');
  });

  it('csv-input 解析真实 CSV', () => {
    const def = getNodeDef('csv-input');
    const out = one(def.execute({ csvText: 'a,b\n1,x\n2,y\n' }, {}));
    expect(out.columns).toEqual(['a', 'b']);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]).toEqual({ a: 1, b: 'x' });
  });

  it('filter 按表达式过滤', () => {
    const def = getNodeDef('filter');
    const out = one(def.execute({ condition: '$age >= 18 && $city == "北京"' }, { in: table }));
    expect(out.rows).toHaveLength(2);
    expect(out.rows.map((r) => r['name'])).toEqual(['张三', '王五']);
  });

  it('filter 引用不存在字段报错', () => {
    const def = getNodeDef('filter');
    expect(() => def.execute({ condition: '$nope > 1' }, { in: table })).toThrow(/不存在的字段/);
  });

  it('computed-column 新增列', () => {
    const def = getNodeDef('computed-column');
    const t2 = { columns: ['price', 'qty'], rows: [{ price: 1050, qty: 3 }] };
    const out = one(def.execute({ column: 'total', expression: '$price * $qty' }, { in: t2 }));
    expect(out.columns).toContain('total');
    expect(out.rows[0]!['total']).toBe(3150); // 整数分计算，无浮点误差
  });

  it('computed-column 覆盖已有列', () => {
    const def = getNodeDef('computed-column');
    const out = one(def.execute({ column: 'age', expression: '$age + 1' }, { in: table }));
    expect(out.columns).toEqual(['name', 'age', 'city']);
    expect(out.rows[0]!['age']).toBe(29);
  });

  it('computed-column 产生非有限数被拒绝', () => {
    const def = getNodeDef('computed-column');
    expect(() => def.execute({ column: 'x', expression: '1e308 * 10' }, { in: table })).toThrow(/非有限/);
  });

  it('output 透传输入', () => {
    const def = getNodeDef('output');
    expect(one(def.execute({}, { in: table })).rows).toHaveLength(3);
  });

  it('未知节点类型抛错', () => {
    expect(() => getNodeDef('nope')).toThrow(/未知节点类型/);
  });
});

describe('图算法', () => {
  const g = (nodes: string[], edges: [string, string][]): WorkflowGraph => ({
    nodes: nodes.map((id) => ({
      id, kind: 'output' as const, name: id, params: {}, position: { x: 0, y: 0 },
    })),
    edges: edges.map(([s, t], i) => ({ id: `e${i}`, source: s, target: t })),
    revision: 1,
  });

  it('拓扑排序确定性', () => {
    const { order, cycle } = topoSort(g(['c', 'a', 'b'], [['a', 'b'], ['b', 'c']]));
    expect(cycle).toEqual([]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('环检测报告环路径', () => {
    const { cycle } = topoSort(g(['a', 'b'], [['a', 'b'], ['b', 'a']]));
    expect(cycle.length).toBeGreaterThan(0);
    expect(cycle[0]).toBe(cycle[cycle.length - 1]);
  });

  it('自环检测', () => {
    const { cycle } = topoSort(g(['a'], [['a', 'a']]));
    expect(cycle.length).toBeGreaterThan(0);
  });

  it('校验：缺失输入 / 环 / 悬空边', () => {
    const issues = validateGraph(g(['a', 'b'], [['a', 'b'], ['b', 'a']]));
    expect(issues.some((i) => i.message.includes('环'))).toBe(true);

    const g2: WorkflowGraph = {
      nodes: [{ id: 'f', kind: 'filter', name: 'f', params: { condition: '$a > 1' }, position: { x: 0, y: 0 } }],
      edges: [],
      revision: 1,
    };
    const issues2 = validateGraph(g2);
    expect(issues2.some((i) => i.message.includes('缺少输入'))).toBe(true);
  });

  it('校验：表达式语法错误可定位节点', () => {
    const g3: WorkflowGraph = {
      nodes: [
        { id: 'c', kind: 'csv-input', name: 'c', params: { csvText: 'a\n1\n' }, position: { x: 0, y: 0 } },
        { id: 'f', kind: 'filter', name: 'f', params: { condition: '$a >' }, position: { x: 0, y: 0 } },
      ],
      edges: [{ id: 'e1', source: 'c', target: 'f' }],
      revision: 1,
    };
    const issues = validateGraph(g3);
    expect(issues.some((i) => i.nodeId === 'f' && i.severity === 'error')).toBe(true);
  });
});

describe('列推断（F03：运行前识别失效字段引用）', () => {
  const csvText = 'name,price,qty\n苹果,1050,3\n香蕉,550,10\n';
  function chain(): WorkflowGraph {
    return {
      revision: 1,
      nodes: [
        { id: 'n1', kind: 'csv-input', name: 'CSV', params: { csvText }, position: { x: 0, y: 0 } },
        { id: 'n2', kind: 'filter', name: '过滤', params: { condition: '$qty >= 5' }, position: { x: 0, y: 0 } },
        { id: 'n3', kind: 'computed-column', name: '小计', params: { column: 'total', expression: '$price * $qty' }, position: { x: 0, y: 0 } },
        { id: 'n4', kind: 'output', name: '输出', params: {}, position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3' },
        { id: 'e3', source: 'n3', target: 'n4' },
      ],
    };
  }

  it('csv-input 从表头推断列', () => {
    expect(inferOutputColumns(chain(), 'n1')).toEqual(['name', 'price', 'qty']);
  });

  it('下游沿用上游列；computed-column 追加目标列', () => {
    const g = chain();
    expect(inferOutputColumns(g, 'n2')).toEqual(['name', 'price', 'qty']);
    expect(inferOutputColumns(g, 'n3')).toEqual(['name', 'price', 'qty', 'total']);
    expect(inferInputColumns(g, 'n2')).toEqual(['name', 'price', 'qty']);
  });

  it('空 CSV 文本无法推断（返回 null，不误报）', () => {
    const g = chain();
    g.nodes[0]!.params = { csvText: '   ' };
    expect(inferOutputColumns(g, 'n2')).toBeNull();
    // 空文本本身会报"参数不能为空"，但不应误报"不存在的字段"
    const issues = validateGraph(g);
    expect(issues.some((i) => i.severity === 'error' && i.field === 'csvText')).toBe(true);
    expect(issues.some((i) => i.message.includes('不存在的字段'))).toBe(false);
  });

  it('引用不存在字段在运行前被识别为错误', () => {
    const g = chain();
    g.nodes[1]!.params = { condition: '$不存在 > 1' };
    const issues = validateGraph(g);
    expect(issues.some((i) => i.nodeId === 'n2' && i.message.includes('不存在的字段'))).toBe(true);
  });

  it('正确引用不产生误报', () => {
    expect(validateGraph(chain())).toEqual([]);
  });

  it('环图中推断不死循环', () => {
    const g: WorkflowGraph = {
      revision: 1,
      nodes: [
        { id: 'a', kind: 'filter', name: 'A', params: { condition: '$x > 1' }, position: { x: 0, y: 0 } },
        { id: 'b', kind: 'filter', name: 'B', params: { condition: '$x > 1' }, position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'a' },
      ],
    };
    expect(() => inferOutputColumns(g, 'a')).not.toThrow();
    expect(inferOutputColumns(g, 'a')).toBeNull();
  });
});

describe('执行器', () => {
  const csvText = 'name,price,qty\n苹果,1050,3\n香蕉,550,10\n';

  function chainGraph(): WorkflowGraph {
    return {
      revision: 7,
      nodes: [
        { id: 'n1', kind: 'csv-input', name: 'CSV', params: { csvText }, position: { x: 0, y: 0 } },
        { id: 'n2', kind: 'filter', name: '过滤', params: { condition: '$qty >= 5' }, position: { x: 0, y: 0 } },
        { id: 'n3', kind: 'computed-column', name: '小计', params: { column: 'total', expression: '$price * $qty' }, position: { x: 0, y: 0 } },
        { id: 'n4', kind: 'output', name: '输出', params: {}, position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3' },
        { id: 'e3', source: 'n3', target: 'n4' },
      ],
    };
  }

  it('端到端：CSV → 过滤 → 计算列 → 输出（真实计算）', async () => {
    const states: string[] = [];
    const mgr = new RunManager(new LocalBackend(), {
      onNodeState: (_id, info) => states.push(info.status),
    });
    const record = await mgr.start(chainGraph());
    expect(record.graphRevision).toBe(7);
    expect(record.cancelled).toBe(false);
    const out = record.outputs['n4'];
    expect(out?.rows).toHaveLength(1);
    expect(out?.rows[0]).toEqual({ name: '香蕉', price: 550, qty: 10, total: 5500 });
    expect(record.nodeStates['n2']?.outputRows).toBe(1);
    expect(record.nodeStates['n3']?.status).toBe('ok');
    expect(states).toContain('running');
    mgr.dispose();
  });

  it('节点失败时下游跳过（skipped）', async () => {
    const graph = chainGraph();
    // 字段静态合法（通过运行前校验），但运行时除零 -> 真实执行失败
    graph.nodes.find((n) => n.id === 'n2')!.params = { condition: 'pow($price, 309) > 1' };
    const mgr = new RunManager(new LocalBackend());
    const record = await mgr.start(graph);
    expect(record.nodeStates['n2']?.status).toBe('failed');
    expect(record.nodeStates['n2']?.error).toMatch(/非有限数/);
    expect(record.nodeStates['n3']?.status).toBe('skipped');
    expect(record.nodeStates['n4']?.status).toBe('skipped');
    mgr.dispose();
  });

  it('引用不存在字段在运行前就被校验拦截（F03）', () => {
    const graph = chainGraph();
    graph.nodes.find((n) => n.id === 'n2')!.params = { condition: '$不存在 > 1' };
    const { ok, issues } = canRun(graph);
    expect(ok).toBe(false);
    expect(issues.some((i) => i.message.includes('不存在的字段'))).toBe(true);
  });

  it('校验不通过时拒绝启动', async () => {
    const graph = chainGraph();
    graph.edges = []; // 断开连线
    const mgr = new RunManager(new LocalBackend());
    await expect(mgr.start(graph)).rejects.toThrow(/校验未通过/);
    mgr.dispose();
  });

  it('canRun 返回可跳转的问题', () => {
    const { ok, issues } = canRun(chainGraph());
    expect(ok).toBe(true);
    expect(issues).toEqual([]);
  });
});

describe('执行器取消语义', () => {
  it('取消后剩余节点标记 cancelled，迟到结果不污染', async () => {
    // 可挂起的后端：第一个节点快速完成，第二个节点挂起直到取消
    const resolvers: ((r: { runId: string; nodeId: string; ok: boolean; table?: { columns: string[]; rows: Row[] }; error?: string; durationMs: number }) => void)[] = [];
    const hanging = {
      execute: (req: { runId: string; nodeId: string }) =>
        new Promise<{ runId: string; nodeId: string; ok: boolean; table?: { columns: string[]; rows: Row[] }; error?: string; durationMs: number }>(
          (resolve) => {
            if (req.nodeId === 'n1') {
              resolve({ runId: req.runId, nodeId: req.nodeId, ok: true, table: { columns: ['a'], rows: [{ a: 1 }] }, durationMs: 1 });
            } else {
              resolvers.push(resolve); // 挂起
            }
          },
        ),
      cancel: () => {
        // 真实取消：挂起的请求以取消失败结算
        for (const r of resolvers.splice(0)) {
          r({ runId: 'x', nodeId: 'n2', ok: false, error: '已取消', durationMs: 0 });
        }
      },
      dispose: () => {},
    };
    const graph: WorkflowGraph = {
      revision: 3,
      nodes: [
        { id: 'n1', kind: 'csv-input', name: 'A', params: { csvText: 'a\n1\n' }, position: { x: 0, y: 0 } },
        { id: 'n2', kind: 'output', name: 'B', params: {}, position: { x: 0, y: 0 } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    };
    const mgr = new RunManager(hanging);
    const promise = mgr.start(graph);
    // 等 n1 完成、n2 进入 running
    await new Promise((r) => setTimeout(r, 50));
    mgr.cancel();
    const record = await promise;
    expect(record.cancelled).toBe(true);
    expect(record.nodeStates['n1']?.status).toBe('ok');
    expect(record.nodeStates['n2']?.status).toBe('cancelled');
    // 迟到消息（runId 不匹配）不得写入
    expect(record.outputs['n2']).toBeUndefined();
    mgr.dispose();
  });
});

describe('覆盖补齐：小函数与分支', () => {
  it('types helpers', async () => {
    const { emptyTable, isNullish } = await import('../../src/engine/types');
    expect(emptyTable()).toEqual({ columns: [], rows: [] });
    expect(isNullish(null)).toBe(true);
    expect(isNullish('')).toBe(false);
    expect(isNullish(0)).toBe(false);
  });

  it('dataModel 类型守卫与断言', async () => {
    const dm = await import('../../src/engine/dataModel');
    expect(dm.isNull(null)).toBe(true);
    expect(dm.isNull('')).toBe(false);
    expect(dm.isNumber(1)).toBe(true);
    expect(dm.isNumber('1')).toBe(false);
    expect(dm.isString('a')).toBe(true);
    expect(dm.isBoolean(true)).toBe(true);
    expect(dm.isBoolean(1)).toBe(false);
    expect(() => dm.assertFiniteNumber(Infinity, 'x')).toThrow(/有限/);
    expect(() => dm.assertFiniteNumber(NaN, 'x')).toThrow(/有限/);
    dm.assertFiniteNumber(42, 'x');
    expect(dm.isSafeIntegerValue(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(dm.isSafeIntegerValue(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    const row = { a: 1 };
    const c = dm.cloneRow(row);
    expect(c).toEqual(row);
    expect(c).not.toBe(row);
    dm.assertRowValid({ a: 1, b: 'x', c: null }, 'n');
    expect(() => dm.assertRowValid({ a: Infinity }, 'n')).toThrow(/非有限/);
    expect(() => dm.assertRowValid({ a: Number.MAX_SAFE_INTEGER + 1 }, 'n')).toThrow(/安全范围/);
  });

  it('missingFields 报告缺失字段', async () => {
    const { compileExpr, missingFields } = await import('../../src/engine/expressions');
    const e = compileExpr('$a + $b');
    expect(missingFields(e, ['a'])).toEqual(['b']);
    expect(missingFields(e, ['a', 'b'])).toEqual([]);
  });

  it('nodes helpers', async () => {
    const nodes = await import('../../src/engine/nodes');
    expect(nodes.isNodeKind('filter')).toBe(true);
    expect(nodes.isNodeKind('nope')).toBe(false);
    const csv = nodes.exportTableCsv({ columns: ['a'], rows: [{ a: 1 }] });
    expect(csv).toContain('a');
    for (const d of nodes.listNodeDefs()) {
      expect(d.defaultName(1).length).toBeGreaterThan(0);
      expect(typeof d.defaultParams()).toBe('object');
    }
  });

  it('executor runningRunId 与 dispose', async () => {
    const { LocalBackend, RunManager } = await import('../../src/engine/executor');
    const mgr = new RunManager(new LocalBackend());
    expect(mgr.runningRunId).toBeNull();
    mgr.dispose();
    expect(mgr.runningRunId).toBeNull();
  });

  it('graph helpers：incomingEdges / upstreamNodeIds', async () => {
    const { incomingEdges, upstreamNodeIds } = await import('../../src/engine/graph');
    const graph: WorkflowGraph = {
      revision: 1,
      nodes: [
        { id: 'a', kind: 'output', name: 'a', params: {}, position: { x: 0, y: 0 } },
        { id: 'b', kind: 'output', name: 'b', params: {}, position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'a', target: 'b', targetPort: 'in' },
      ],
    };
    expect(incomingEdges(graph, 'b')).toHaveLength(2);
    expect(upstreamNodeIds(graph, 'b')).toEqual(['a']);
    expect(upstreamNodeIds(graph, 'a')).toEqual([]);
  });

  it('表达式：字符串拼接与布尔运算', () => {
    expect(ev('"a" + "b"')).toBe('ab');
    expect(ev('true && false')).toBe(false);
    expect(ev('false || true')).toBe(true);
    expect(ev('!(1 > 2)')).toBe(true);
    expect(ev('-5 + 3')).toBe(-2);
    expect(ev('2 * 3 == 6')).toBe(true);
    expect(ev('1 < 2')).toBe(true);
    expect(ev('2 <= 2')).toBe(true);
    expect(ev('3 > 4')).toBe(false);
    expect(ev('3 >= 4')).toBe(false);
    expect(ev('"b" > "a"')).toBe(true);
    expect(ev('true == true')).toBe(true);
    expect(ev('1 != 2')).toBe(true);
    expect(ev('null == null')).toBe(true);
  });

  it('表达式：类型不匹配的比较返回 null/false', () => {
    expect(ev('1 < "a"')).toBeNull();
    expect(ev('1 + "a"')).toBeNull();
    expect(ev('"a" - "b"')).toBeNull();
  });

  it('表达式：函数边界', () => {
    expect(() => ev('sqrt(-1)')).toThrow(/负数/);
    expect(() => ev('pow(10, 400)')).toThrow(/非有限/);
    expect(() => ev('round(1.5, 1.5)')).toThrow(/整数/);
    expect(() => ev('abs(1, 2)')).toThrow(/1 个参数/);
    expect(() => ev('min()')).toThrow(/至少/);
    expect(ev('min(3, 1, 2)')).toBe(1);
    expect(ev('max(3, 1, 2)')).toBe(3);
    expect(ev('min(3, null)')).toBeNull();
    expect(ev('pow(2, 10)')).toBe(1024);
    expect(ev('substring("hello", 1, 3)')).toBe('el');
    expect(ev('substring("hello", 2)')).toBe('llo');
    expect(ev('replace("a-b", "-", "+")')).toBe('a+b');
    expect(ev('isNumber(42)')).toBe(true);
    expect(ev('toString(42)')).toBe('42');
    expect(ev('toString(null)')).toBeNull();
    expect(ev('floor(1.9)')).toBe(1);
    expect(ev('ceil(1.1)')).toBe(2);
    expect(ev('lower("AbC")')).toBe('abc');
    expect(ev('trim("  x  ")')).toBe('x');
    expect(ev('startsWith("abc", "a")')).toBe(true);
    expect(ev('endsWith("abc", "c")')).toBe(true);
    expect(ev('len(null)')).toBeNull();
  });
});
