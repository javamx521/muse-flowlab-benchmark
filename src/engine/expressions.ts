/**
 * 受限表达式语言（任务书 F05）:
 * - 字段访问: $字段名 或 $"带空格 字段名"
 * - 字面量: 数字、字符串（单/双引号）、true/false/null
 * - 运算符: + - * / % == != < <= > >= && || !（一元 - !）
 * - 白名单纯函数（见 PURE_FUNCTIONS）
 * - 禁止: 任意 JS、网络/文件访问、动态加载、原型链/构造器访问
 *
 * 实现: 手写递归下降解析器生成受限 AST, 解释器逐节点求值。
 * 全程不使用 eval / new Function。字段只能通过 $ 引用行的自有属性。
 */
import type { CellValue, Row } from './types';
import { toNumberStrict } from './dataModel';

export const EXPR_MAX_LENGTH = 2000;
export const EXPR_MAX_DEPTH = 32;
export const EXPR_MAX_NODES = 500;

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExprError';
  }
}

// ---------- AST ----------

type AstNode =
  | { t: 'lit'; v: CellValue }
  | { t: 'field'; name: string }
  | { t: 'un'; op: '-' | '!'; e: AstNode }
  | { t: 'bin'; op: string; l: AstNode; r: AstNode }
  | { t: 'call'; name: string; args: AstNode[] };

// ---------- 纯函数白名单 ----------

type Fn = (args: CellValue[]) => CellValue;

function numArgs(name: string, args: CellValue[], n: number): void {
  if (args.length !== n) throw new ExprError(`函数 ${name} 需要 ${n} 个参数, 得到 ${args.length}`);
}

/** 安全取参（noUncheckedIndexedAccess 下避免 undefined 泄漏）。 */
function arg(args: CellValue[], i: number, fname: string): CellValue {
  const v = args[i];
  if (v === undefined) throw new ExprError(`函数 ${fname} 缺少第 ${i + 1} 个参数`);
  return v;
}

function asNumber(v: CellValue): number | null {
  if (typeof v === 'number') return v;
  return null;
}

function asString(v: CellValue): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

const PURE_FUNCTIONS: Record<string, Fn> = {
  abs: (a) => {
    numArgs('abs', a, 1);
    const n = asNumber(arg(a, 0, 'abs'));
    return n === null ? null : Math.abs(n);
  },
  ceil: (a) => {
    numArgs('ceil', a, 1);
    const n = asNumber(arg(a, 0, 'ceil'));
    return n === null ? null : Math.ceil(n);
  },
  floor: (a) => {
    numArgs('floor', a, 1);
    const n = asNumber(arg(a, 0, 'floor'));
    return n === null ? null : Math.floor(n);
  },
  round: (a) => {
    if (a.length < 1 || a.length > 2) throw new ExprError('函数 round 需要 1-2 个参数');
    const n = asNumber(arg(a, 0, 'round'));
    if (n === null) return null;
    const d = a.length === 2 ? asNumber(arg(a, 1, 'round')) : 0;
    if (d === null || !Number.isInteger(d)) throw new ExprError('round 的第 2 个参数必须为整数');
    const f = Math.pow(10, d);
    return Math.round(n * f) / f;
  },
  sqrt: (a) => {
    numArgs('sqrt', a, 1);
    const n = asNumber(arg(a, 0, 'sqrt'));
    if (n === null) return null;
    if (n < 0) throw new ExprError('sqrt 不能对负数开方');
    return Math.sqrt(n);
  },
  min: (a) => {
    if (a.length === 0) throw new ExprError('函数 min 至少需要 1 个参数');
    let best: number | null = null;
    for (const v of a) {
      const n = asNumber(v);
      if (n === null) return null;
      best = best === null ? n : Math.min(best, n);
    }
    return best;
  },
  max: (a) => {
    if (a.length === 0) throw new ExprError('函数 max 至少需要 1 个参数');
    let best: number | null = null;
    for (const v of a) {
      const n = asNumber(v);
      if (n === null) return null;
      best = best === null ? n : Math.max(best, n);
    }
    return best;
  },
  pow: (a) => {
    numArgs('pow', a, 2);
    const x = asNumber(arg(a, 0, 'pow'));
    const y = asNumber(arg(a, 1, 'pow'));
    if (x === null || y === null) return null;
    const r = Math.pow(x, y);
    if (!Number.isFinite(r)) throw new ExprError('pow 结果非有限数');
    return r;
  },
  len: (a) => {
    numArgs('len', a, 1);
    const s = asString(arg(a, 0, 'len'));
    return s === null ? null : s.length;
  },
  upper: (a) => {
    numArgs('upper', a, 1);
    const s = asString(arg(a, 0, 'upper'));
    return s === null ? null : s.toUpperCase();
  },
  lower: (a) => {
    numArgs('lower', a, 1);
    const s = asString(arg(a, 0, 'lower'));
    return s === null ? null : s.toLowerCase();
  },
  trim: (a) => {
    numArgs('trim', a, 1);
    const s = asString(arg(a, 0, 'trim'));
    return s === null ? null : s.trim();
  },
  contains: (a) => {
    numArgs('contains', a, 2);
    const h = asString(arg(a, 0, 'contains'));
    const n = asString(arg(a, 1, 'contains'));
    if (h === null || n === null) return null;
    return h.includes(n);
  },
  startsWith: (a) => {
    numArgs('startsWith', a, 2);
    const h = asString(arg(a, 0, 'startsWith'));
    const n = asString(arg(a, 1, 'startsWith'));
    if (h === null || n === null) return null;
    return h.startsWith(n);
  },
  endsWith: (a) => {
    numArgs('endsWith', a, 2);
    const h = asString(arg(a, 0, 'endsWith'));
    const n = asString(arg(a, 1, 'endsWith'));
    if (h === null || n === null) return null;
    return h.endsWith(n);
  },
  substring: (a) => {
    if (a.length < 2 || a.length > 3) throw new ExprError('函数 substring 需要 2-3 个参数');
    const s = asString(arg(a, 0, 'substring'));
    if (s === null) return null;
    const st = asNumber(arg(a, 1, 'substring'));
    if (st === null || !Number.isInteger(st)) throw new ExprError('substring 起始位置必须为整数');
    if (a.length === 3) {
      const en = asNumber(arg(a, 2, 'substring'));
      if (en === null || !Number.isInteger(en)) throw new ExprError('substring 结束位置必须为整数');
      return s.substring(st, en);
    }
    return s.substring(st);
  },
  replace: (a) => {
    numArgs('replace', a, 3);
    const s = asString(arg(a, 0, 'replace'));
    const f = asString(arg(a, 1, 'replace'));
    const t = asString(arg(a, 2, 'replace'));
    if (s === null || f === null || t === null) return null;
    return s.split(f).join(t);
  },
  if: (a) => {
    numArgs('if', a, 3);
    return truthy(arg(a, 0, 'if')) ? arg(a, 1, 'if') : arg(a, 2, 'if');
  },
  coalesce: (a) => {
    if (a.length === 0) throw new ExprError('函数 coalesce 至少需要 1 个参数');
    for (const v of a) if (v !== null) return v;
    return null;
  },
  isNull: (a) => {
    numArgs('isNull', a, 1);
    return arg(a, 0, 'isNull') === null;
  },
  isNumber: (a) => {
    numArgs('isNumber', a, 1);
    return typeof arg(a, 0, 'isNumber') === 'number';
  },
  toNumber: (a) => {
    numArgs('toNumber', a, 1);
    return toNumberStrict(arg(a, 0, 'toNumber'));
  },
  toString: (a: CellValue[]) => {
    numArgs('toString', a, 1);
    const s = asString(arg(a, 0, 'toString'));
    return s;
  },
};

export function listFunctions(): string[] {
  return Object.keys(PURE_FUNCTIONS).sort();
}

function truthy(v: CellValue): boolean {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return v !== '';
}

// ---------- 解析器 ----------

interface Token {
  t: 'num' | 'str' | 'ident' | 'field' | 'op' | 'lparen' | 'rparen' | 'comma' | 'eof';
  v: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const ch = (j: number): string => src[j] ?? '';
  const push = (t: Token['t'], v: string) => tokens.push({ t, v });
  while (i < src.length) {
    const c = ch(i);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '$') {
      i++;
      if (ch(i) === '"') {
        // $"带空格 字段名"
        i++;
        let name = '';
        while (i < src.length && ch(i) !== '"') {
          if (ch(i) === '\\' && i + 1 < src.length) {
            name += ch(i + 1);
            i += 2;
          } else {
            name += ch(i);
            i++;
          }
        }
        if (ch(i) !== '"') throw new ExprError('字段引用缺少闭合引号');
        i++;
        push('field', name);
      } else {
        let name = '';
        while (i < src.length && /[A-Za-z0-9_\u4e00-\u9fa5]/.test(ch(i))) {
          name += ch(i);
          i++;
        }
        if (name === '') throw new ExprError('$ 后缺少字段名');
        push('field', name);
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      let s = '';
      while (i < src.length && ch(i) !== q) {
        if (ch(i) === '\\' && i + 1 < src.length) {
          const e = ch(i + 1);
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
        } else {
          s += ch(i);
          i++;
        }
      }
      if (ch(i) !== q) throw new ExprError('字符串缺少闭合引号');
      i++;
      push('str', s);
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(ch(i + 1) ?? ''))) {
      let n = '';
      while (i < src.length && /[0-9.eE+-]/.test(ch(i))) {
        n += ch(i);
        i++;
      }
      if (!/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(n)) throw new ExprError(`非法数字: ${n}`);
      push('num', n);
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let name = '';
      while (i < src.length && /[A-Za-z0-9_]/.test(ch(i))) {
        name += ch(i);
        i++;
      }
      push('ident', name);
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
      push('op', two);
      i += 2;
      continue;
    }
    if ('+-*/%<>=!(),'.includes(c)) {
      if (c === '(') push('lparen', c);
      else if (c === ')') push('rparen', c);
      else if (c === ',') push('comma', c);
      else push('op', c);
      i++;
      continue;
    }
    throw new ExprError(`非法字符: ${c}`);
  }
  push('eof', '');
  return tokens;
}

class Parser {
  private pos = 0;
  private nodeCount = 0;
  private nestDepth = 0;
  constructor(private tokens: Token[]) {}

  /** 进入一层括号/函数调用嵌套，超限抛错。 */
  private enterNest<T>(fn: () => T): T {
    this.nestDepth++;
    if (this.nestDepth > EXPR_MAX_DEPTH) throw new ExprError(`表达式嵌套深度超过上限 ${EXPR_MAX_DEPTH}`);
    try {
      return fn();
    } finally {
      this.nestDepth--;
    }
  }

  parse(): AstNode {
    const e = this.parseOr();
    this.expect('eof');
    return e;
  }

  private peek(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new ExprError('表达式意外结束');
    return t;
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    this.pos++;
    if (!t) throw new ExprError('表达式意外结束');
    return t;
  }

  private expect(t: Token['t']): Token {
    const tok = this.next();
    if (tok.t !== t) throw new ExprError(`语法错误: 期望 ${t}, 得到 ${tok.t}(${tok.v})`);
    return tok;
  }

  private count(): void {
    this.nodeCount++;
    if (this.nodeCount > EXPR_MAX_NODES) throw new ExprError(`表达式节点数超过上限 ${EXPR_MAX_NODES}`);
  }

  private parseOr(): AstNode {
    let l = this.parseAnd();
    while (this.peek().t === 'op' && this.peek().v === '||') {
      this.next();
      const r = this.parseAnd();
      this.count();
      l = { t: 'bin', op: '||', l, r };
    }
    return l;
  }

  private parseAnd(): AstNode {
    let l = this.parseEquality();
    while (this.peek().t === 'op' && this.peek().v === '&&') {
      this.next();
      const r = this.parseEquality();
      this.count();
      l = { t: 'bin', op: '&&', l, r };
    }
    return l;
  }

  private parseEquality(): AstNode {
    let l = this.parseRel();
    for (;;) {
      const p = this.peek();
      if (p.t === 'op' && (p.v === '==' || p.v === '!=')) {
        this.next();
        const r = this.parseRel();
        this.count();
        l = { t: 'bin', op: p.v, l, r };
      } else return l;
    }
  }

  private parseRel(): AstNode {
    let l = this.parseAdd();
    for (;;) {
      const p = this.peek();
      if (p.t === 'op' && ['<', '<=', '>', '>='].includes(p.v)) {
        this.next();
        const r = this.parseAdd();
        this.count();
        l = { t: 'bin', op: p.v, l, r };
      } else return l;
    }
  }

  private parseAdd(): AstNode {
    let l = this.parseMul();
    for (;;) {
      const p = this.peek();
      if (p.t === 'op' && (p.v === '+' || p.v === '-')) {
        this.next();
        const r = this.parseMul();
        this.count();
        l = { t: 'bin', op: p.v, l, r };
      } else return l;
    }
  }

  private parseMul(): AstNode {
    let l = this.parseUnary();
    for (;;) {
      const p = this.peek();
      if (p.t === 'op' && (p.v === '*' || p.v === '/' || p.v === '%')) {
        this.next();
        const r = this.parseUnary();
        this.count();
        l = { t: 'bin', op: p.v, l, r };
      } else return l;
    }
  }

  private parseUnary(): AstNode {
    const p = this.peek();
    if (p.t === 'op' && (p.v === '-' || p.v === '!')) {
      this.next();
      const e = this.parseUnary();
      this.count();
      return { t: 'un', op: p.v, e };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): AstNode {
    const tok = this.next();
    this.count();
    if (tok.t === 'num') return { t: 'lit', v: Number(tok.v) };
    if (tok.t === 'str') return { t: 'lit', v: tok.v };
    if (tok.t === 'field') {
      if (tok.v === '__proto__' || tok.v === 'constructor' || tok.v === 'prototype') {
        throw new ExprError(`禁止访问保留字段: $${tok.v}`);
      }
      return { t: 'field', name: tok.v };
    }
    if (tok.t === 'ident') {
      if (tok.v === 'true') return { t: 'lit', v: true };
      if (tok.v === 'false') return { t: 'lit', v: false };
      if (tok.v === 'null') return { t: 'lit', v: null };
      if (this.peek().t === 'lparen') {
        if (!(tok.v in PURE_FUNCTIONS)) throw new ExprError(`未知函数: ${tok.v}`);
        return this.enterNest(() => {
          this.next();
          const args: AstNode[] = [];
          if (this.peek().t !== 'rparen') {
            for (;;) {
              args.push(this.parseOr());
              if (this.peek().t === 'comma') {
                this.next();
                continue;
              }
              break;
            }
          }
          this.expect('rparen');
          return { t: 'call', name: tok.v, args } as AstNode;
        });
      }
      throw new ExprError(`未知标识符: ${tok.v}（字段请用 $ 前缀）`);
    }
    if (tok.t === 'lparen') {
      return this.enterNest(() => {
        const e = this.parseOr();
        this.expect('rparen');
        return e;
      });
    }
    throw new ExprError(`语法错误: 意外的 ${tok.t}(${tok.v})`);
  }
}

// ---------- 求值器 ----------

function evalBin(op: string, l: CellValue, r: CellValue): CellValue {
  // && / || 由 evalNode 短路处理，恒返回布尔值，不经过此处。
  switch (op) {
    case '==':
      if (l === null || r === null) return l === null && r === null;
      if (typeof l !== typeof r) return false;
      return l === r;
    case '!=':
      if (l === null || r === null) return !(l === null && r === null);
      if (typeof l !== typeof r) return true;
      return l !== r;
    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (l === null || r === null) return null;
      if (typeof l !== typeof r) return null;
      let c: number;
      if (typeof l === 'number' && typeof r === 'number') c = l - r;
      else if (typeof l === 'string' && typeof r === 'string') c = l < r ? -1 : l > r ? 1 : 0;
      else if (typeof l === 'boolean' && typeof r === 'boolean') c = l === r ? 0 : l ? 1 : -1;
      else return null;
      if (op === '<') return c < 0;
      if (op === '<=') return c <= 0;
      if (op === '>') return c > 0;
      return c >= 0;
    }
    case '+':
    case '-':
    case '*':
    case '/':
    case '%': {
      // 数字运算: 任一操作数为 null 或非数字 -> null；+ 允许字符串拼接
      if (op === '+' && typeof l === 'string' && typeof r === 'string') return l + r;
      if (typeof l !== 'number' || typeof r !== 'number') return null;
      let res: number;
      if (op === '+') res = l + r;
      else if (op === '-') res = l - r;
      else if (op === '*') res = l * r;
      else if (op === '/') {
        if (r === 0) return null; // 除零得 null，不抛错
        res = l / r;
      } else {
        if (r === 0) return null;
        res = l % r;
      }
      if (!Number.isFinite(res)) throw new ExprError('运算结果非有限数');
      return res;
    }
    default:
      throw new ExprError(`未知运算符: ${op}`);
  }
}

function evalNode(node: AstNode, row: Row, depth: number): CellValue {
  if (depth > EXPR_MAX_DEPTH) throw new ExprError(`表达式嵌套深度超过上限 ${EXPR_MAX_DEPTH}`);
  switch (node.t) {
    case 'lit':
      return node.v;
    case 'field': {
      // 只读自有属性；原型链不可达（Row 为普通对象，且此处不用原型链查找以外的任何方式）
      if (!Object.prototype.hasOwnProperty.call(row, node.name)) {
        throw new ExprError(`未知字段: $${node.name}`);
      }
      const v: CellValue = row[node.name] ?? null;
      return v;
    }
    case 'un': {
      const v = evalNode(node.e, row, depth + 1);
      if (node.op === '!') return !truthy(v);
      if (typeof v !== 'number') throw new ExprError('一元 - 只能用于数字');
      return -v;
    }
    case 'bin': {
      const l = evalNode(node.l, row, depth + 1);
      // 短路求值，&& / || 恒返回布尔值
      if (node.op === '&&') return truthy(l) ? truthy(evalNode(node.r, row, depth + 1)) : false;
      if (node.op === '||') return truthy(l) ? true : truthy(evalNode(node.r, row, depth + 1));
      const r = evalNode(node.r, row, depth + 1);
      return evalBin(node.op, l, r);
    }
    case 'call': {
      const fn = PURE_FUNCTIONS[node.name];
      if (!fn) throw new ExprError(`未知函数: ${node.name}`);
      const args = node.args.map((a) => evalNode(a, row, depth + 1));
      return fn(args);
    }
  }
}

export interface CompiledExpr {
  /** 引用的字段名集合（用于校验）。 */
  fields: string[];
  evaluate(row: Row): CellValue;
}

function collectFields(node: AstNode, out: Set<string>): void {
  if (node.t === 'field') out.add(node.name);
  else if (node.t === 'un') collectFields(node.e, out);
  else if (node.t === 'bin') {
    collectFields(node.l, out);
    collectFields(node.r, out);
  } else if (node.t === 'call') node.args.forEach((a) => collectFields(a, out));
}

/** 编译表达式。空表达式抛错。 */
export function compileExpr(src: string): CompiledExpr {
  if (src.length > EXPR_MAX_LENGTH) {
    throw new ExprError(`表达式长度超过上限 ${EXPR_MAX_LENGTH}`);
  }
  const trimmed = src.trim();
  if (trimmed === '') throw new ExprError('表达式不能为空');
  const ast = new Parser(tokenize(trimmed)).parse();
  const fields = new Set<string>();
  collectFields(ast, fields);
  return {
    fields: [...fields],
    evaluate: (row: Row) => evalNode(ast, row, 0),
  };
}

/** 校验表达式引用的字段是否都存在，返回缺失字段。 */
export function missingFields(expr: CompiledExpr, columns: string[]): string[] {
  const cols = new Set(columns);
  return expr.fields.filter((f) => !cols.has(f));
}
