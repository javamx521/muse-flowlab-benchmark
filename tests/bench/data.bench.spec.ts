/**
 * 基准 2：数据基准（F08）。
 * 固定种子生成 100,000 行 × 12 列 CSV，执行：过滤 -> 计算列 -> 分组聚合 -> 排序 -> 输出；
 * 测量：导入、运行总耗时、结果滚动、取消响应。
 * 只记录、不做阈值断言（结果写入 tests/bench/results/，抄入 docs/BENCHMARKS.md）。
 * 运行：npm run bench。
 */
import { test } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SEED = 20261002;
const ROWS = 100000;
const COLS = 12;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['张伟', '王芳', '李娜', '刘洋', '陈静', '杨帆', '赵磊', '黄敏', '周涛', '吴欣'];
const CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '西安'];

function buildCsv(): string {
  const rand = rng(SEED);
  const header = 'id,name,age,city,score,qty,price,active,code,group,rating,flag';
  const lines = new Array<string>(ROWS + 1);
  lines[0] = header;
  for (let i = 0; i < ROWS; i++) {
    const r = rand;
    lines[i + 1] = [
      i + 1,
      NAMES[Math.floor(r() * NAMES.length)],
      18 + Math.floor(r() * 53),
      CITIES[Math.floor(r() * CITIES.length)],
      Math.floor(r() * 101),
      1 + Math.floor(r() * 50),
      10 + Math.floor(r() * 991),
      r() < 0.5 ? 'true' : 'false',
      `C${10000 + Math.floor(r() * 89999)}`,
      `g${1 + Math.floor(r() * 5)}`,
      1 + Math.floor(r() * 5),
      Math.floor(r() * 2),
    ].join(',');
  }
  return lines.join('\n');
}

function buildProjectJson(csvText: string): string {
  const nodes = [
    { id: 'd1', kind: 'csv-input', name: 'CSV 输入', params: { csvText }, position: { x: 60, y: 200 } },
    { id: 'd2', kind: 'filter', name: '过滤', params: { condition: '$age >= 30' }, position: { x: 320, y: 200 } },
    { id: 'd3', kind: 'computed-column', name: '计算列', params: { column: 'total', expression: '$price * $qty' }, position: { x: 580, y: 200 } },
    { id: 'd4', kind: 'aggregate', name: '分组聚合', params: { groupBy: 'city', aggregations: 'n:count(*)\ntotal:sum(total)' }, position: { x: 840, y: 200 } },
    { id: 'd5', kind: 'sort', name: '排序', params: { sortKeys: 'total desc' }, position: { x: 1100, y: 200 } },
    { id: 'd6', kind: 'output', name: '输出', params: {}, position: { x: 1360, y: 200 } },
  ];
  const edges = [
    { id: 'de1', source: 'd1', target: 'd2' },
    { id: 'de2', source: 'd2', target: 'd3' },
    { id: 'de3', source: 'd3', target: 'd4' },
    { id: 'de4', source: 'd4', target: 'd5' },
    { id: 'de5', source: 'd5', target: 'd6' },
  ];
  const now = new Date().toISOString();
  return JSON.stringify({
    kind: 'flowlab-studio-export',
    appVersion: '0.1.0',
    exportedAt: now,
    document: {
      id: 'bench-data', name: 'Bench 数据', version: 2, createdAt: now, snapshots: [],
      graph: { nodes, edges, revision: 1 }, updatedAt: now,
    },
  });
}

interface DataBenchRun {
  importMs: number;
  runMs: number;
  scrollMs: number;
  cancelMs: number;
  outputRows: number;
}

test('数据基准：100k 行 × 12 列', async ({ browser }) => {
  test.setTimeout(900_000);
  console.log('生成 100k×12 CSV（种子固定）…');
  const csvText = buildCsv();
  console.log(`CSV 大小 ${(csvText.length / 1024 / 1024).toFixed(1)} MB`);
  const fpath = path.join(os.tmpdir(), `flowlab-bench-data-${process.pid}.json`);
  fs.writeFileSync(fpath, buildProjectJson(csvText));

  const probeCtx = await browser.newContext();
  const probe = await probeCtx.newPage();
  const ua = await probe.evaluate(() => navigator.userAgent).catch(() => 'n/a');
  await probe.close();
  await probeCtx.close();

  // 预热 1 次（不计入；同时验证链路可跑通）
  {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    console.log('[warmup] goto');
    await p.goto('/#/');
    console.log('[warmup] import');
    await p.locator('input[data-testid="import-file"]').setInputFiles(fpath);
    console.log('[warmup] open');
    await p.getByRole('link', { name: 'Bench 数据' }).click();
    await p.getByTestId('canvas').waitFor({ timeout: 120000 });
    console.log('[warmup] canvas ok, click run');
    await p.getByTestId('run-btn').click();
    await p.getByTestId('tab-log').click();
    console.log('[warmup] run clicked, wait summary');
    await p.getByTestId('cache-summary').waitFor({ timeout: 300000 });
    console.log('[warmup] summary ok');
    await p.close();
    console.log('预热完成');
  }

  const runs: DataBenchRun[] = [];
  for (let r = 0; r < 3; r++) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    try {
      let t0 = Date.now();
      await p.goto('/#/');
      await p.locator('input[data-testid="import-file"]').setInputFiles(fpath);
      await p.getByRole('link', { name: 'Bench 数据' }).waitFor({ timeout: 120000 });
      const importMs = Date.now() - t0;
      console.log(`[run ${r + 1}] import=${importMs}ms`);

      await p.getByRole('link', { name: 'Bench 数据' }).click();
      await p.getByTestId('canvas').waitFor({ timeout: 120000 });

      // 运行总耗时（冷缓存：新上下文）
      t0 = Date.now();
      await p.getByTestId('run-btn').click();
      await p.getByTestId('tab-log').click();
      await p.getByTestId('cache-summary').waitFor({ timeout: 300000 });
      const runMs = Date.now() - t0;
      const summary = (await p.getByTestId('cache-summary').textContent()) ?? '';
      console.log(`[run ${r + 1}] run=${runMs}ms`);

      // 结果滚动：经运行日志的节点行选中输出节点（HTML 按钮，恒可见；画布节点可能在视口外），
      // 再切到输出 tab，分 20 步滚到底
      console.log(`[run ${r + 1}] select d6`);
      // onMouseDown 绑在节点 <g> 内的子 rect 上，向第一个子 rect 派发冒泡 mousedown 以选中
      await p.getByTestId('node-d6').evaluate((el) => {
        const target = el.querySelector('rect') ?? el;
        const r = (target as unknown as SVGGraphicsElement).getBoundingClientRect();
        target.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true, cancelable: true, button: 0,
          clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
        }));
      });
      await p.getByTestId('tab-output').evaluate((el) => (el as HTMLElement).click());
      console.log(`[run ${r + 1}] wait datatable`);
      await p.getByTestId('datatable').waitFor({ timeout: 60000 });
      console.log(`[run ${r + 1}] datatable ok`);
      const countText = (await p.getByTestId('datatable-count').textContent()) ?? '';
      const outputRows = Number(countText.match(/(\d+) 行/)?.[1] ?? 0);
      t0 = Date.now();
      await p.evaluate(() => {
        const el = document.querySelector('[data-testid="datatable-scroll"]') as HTMLElement;
        return new Promise<void>((resolve) => {
          let step = 0;
          const tick = () => {
            step += 1;
            el.scrollTop = (el.scrollHeight / 20) * step;
            if (step >= 20) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      });
      const scrollMs = Date.now() - t0;
      console.log(`[run ${r + 1}] scroll=${scrollMs}ms rows=${outputRows}`);

      // 取消响应：先清缓存保证是冷运行，1s 后取消，测量到"运行"按钮恢复的时间
      await p.getByTestId('tab-log').evaluate((el) => (el as HTMLElement).click());
      await p.getByTestId('clear-cache').evaluate((el) => (el as HTMLElement).click());
      await p.getByTestId('run-btn').evaluate((el) => (el as HTMLElement).click());
      await p.waitForTimeout(1000);
      t0 = Date.now();
      await p.getByTestId('cancel-btn').click();
      await p.getByTestId('run-btn').waitFor({ timeout: 30000 });
      const cancelMs = Date.now() - t0;
      console.log(`[run ${r + 1}] cancel=${cancelMs}ms`);

      runs.push({ importMs, runMs, scrollMs, cancelMs, outputRows });
      console.log(`run ${r + 1}: import=${importMs}ms run=${runMs}ms scroll=${scrollMs}ms cancel=${cancelMs}ms rows=${outputRows} | ${summary.trim().slice(0, 60)}`);
    } finally {
      await p.close();
      await ctx.close();
    }
  }

  const result = {
    benchmark: 'data-100k',
    seed: SEED,
    rows: ROWS,
    cols: COLS,
    browser: browserName,
    userAgent: ua,
    viewport: { width: 1280, height: 720 },
    runs,
    recordedAt: new Date().toISOString(),
  };
  const outDir = path.join(process.cwd(), 'tests', 'bench', 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `data-100k-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`结果写入 ${out}`);
});
