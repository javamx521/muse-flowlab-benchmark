/**
 * 基准 1：图编辑基准（F08）。
 * 固定种子生成 300 节点 / 600 边合法 DAG，测量：加载、多选拖拽、撤销、平移缩放。
 * 只记录、不做阈值断言（结果写入 tests/bench/results/，中位数抄入 docs/BENCHMARKS.md）。
 * 运行：npm run bench（默认只跑 chromium；FULL_BROWSERS=1 加跑 firefox/webkit）。
 */
import { test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SEED = 20261002;
const NODES = 300;
const EDGES = 600;

/** mulberry32 确定性随机。 */
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

interface BenchRun {
  loadMs: number;
  panZoomMs: number;
  multiDragMs: number;
  undoMs: number;
  longtasks: number;
}

function buildProjectJson(): string {
  const rand = rng(SEED);
  const kinds = ['filter', 'computed-column', 'limit'] as const;
  const paramFor = (kind: string, i: number): Record<string, unknown> => {
    if (kind === 'filter') return { condition: '$age >= 18' };
    if (kind === 'computed-column') return { column: `total_${i}`, expression: '$price * $qty' };
    return { n: 100 };
  };
  const nodes = [];
  for (let i = 0; i < NODES; i++) {
    const kind = kinds[i % kinds.length]!;
    nodes.push({
      id: `b${i}`,
      kind,
      name: `节点 ${i}`,
      params: paramFor(kind, i),
      // 20 列网格布局，留出空白区域供平移测试
      position: { x: 60 + (i % 20) * 220, y: 60 + Math.floor(i / 20) * 160 },
    });
  }
  const edgeSet = new Set<string>();
  const edges = [];
  let guard = 0;
  while (edges.length < EDGES && guard++ < EDGES * 20) {
    const a = Math.floor(rand() * (NODES - 1));
    const b = a + 1 + Math.floor(rand() * (NODES - a - 1));
    const key = `${a}-${b}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);
    edges.push({ id: `be${edges.length}`, source: `b${a}`, target: `b${b}` });
  }
  const doc = {
    id: 'bench-graph',
    name: 'Bench 图编辑',
    version: 2,
    createdAt: new Date().toISOString(),
    snapshots: [],
    graph: { nodes, edges, revision: 1 },
    updatedAt: new Date().toISOString(),
  };
  return JSON.stringify({
    kind: 'flowlab-studio-export',
    appVersion: '0.1.0',
    exportedAt: new Date().toISOString(),
    document: doc,
  });
}

/** 在页面内安装长任务收集器，返回停止并取数的方法名。 */
async function installLongtaskProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __lt: unknown[] }).__lt = [];
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) (window as unknown as { __lt: unknown[] }).__lt.push(e);
    });
    po.observe({ entryTypes: ['longtask'] });
    (window as unknown as { __ltStop: () => number }).__ltStop = () => {
      po.disconnect();
      return (window as unknown as { __lt: unknown[] }).__lt.length;
    };
  });
}

async function longtaskCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __ltStop: () => number }).__ltStop());
}

async function nodeTransform(page: Page, id: string): Promise<string | null> {
  return page.getByTestId(`node-${id}`).getAttribute('transform');
}

test('图编辑基准：300 节点 / 600 边', async ({ page, browser, browserName }) => {
  test.setTimeout(900_000);
  const fpath = path.join(os.tmpdir(), `flowlab-bench-graph-${process.pid}.json`);
  fs.writeFileSync(fpath, buildProjectJson());

  // 预热 1 次（不计入）
  console.log('[warmup] goto');
  await page.goto('/#/');
  console.log('[warmup] setInputFiles');
  await page.locator('input[data-testid="import-file"]').setInputFiles(fpath);
  console.log('[warmup] wait link');
  await page.getByRole('link', { name: 'Bench 图编辑' }).waitFor({ timeout: 120000 });
  console.log('[warmup] done, close page');
  await page.close();
  console.log('[warmup] page closed');

  const runs: BenchRun[] = [];
  const probeCtx = await browser.newContext();
  const probe = await probeCtx.newPage();
  const ua = await probe.evaluate(() => navigator.userAgent).catch(() => 'n/a');
  await probe.close();
  await probeCtx.close();

  for (let r = 0; r < 3; r++) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    try {
      // 1) 加载：导入 -> 打开项目 -> 300 节点渲染完成
      let t0 = Date.now();
      console.log(`[run ${r + 1}] goto`);
      await p.goto('/#/');
      console.log(`[run ${r + 1}] setInputFiles`);
      await p.locator('input[data-testid="import-file"]').setInputFiles(fpath);
      await p.getByRole('link', { name: 'Bench 图编辑' }).waitFor({ timeout: 120000 });
      console.log(`[run ${r + 1}] link found, click`);
      await p.getByRole('link', { name: 'Bench 图编辑' }).click();
      console.log(`[run ${r + 1}] wait canvas`);
      await p.getByTestId('canvas').waitFor({ timeout: 120000 });
      // 等待全部 300 节点挂载
      await p.waitForFunction(
        (n) => document.querySelectorAll('[data-testid="canvas"] g[data-testid^="node-"]').length >= n,
        NODES,
        { timeout: 120000 },
      );
      const loadMs = Date.now() - t0;
      console.log(`  [run ${r + 1}] load=${loadMs}ms`);

      // 2) 平移缩放：10 次背景拖拽 + 5 次 Ctrl+滚轮缩放
      await installLongtaskProbe(p);
      t0 = Date.now();
      const canvas = p.getByTestId('canvas');
      const box = (await canvas.boundingBox())!;
      const px = box.x + box.width * 0.8;
      const py = box.y + box.height * 0.75;
      for (let i = 0; i < 10; i++) {
        await p.mouse.move(px, py);
        await p.mouse.down();
        await p.mouse.move(px - 120, py - 80, { steps: 6 });
        await p.mouse.up();
      }
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.keyboard.down('Control');
      for (let i = 0; i < 5; i++) await p.mouse.wheel(0, -240);
      await p.keyboard.up('Control');
      const panZoomMs = Date.now() - t0;
      const lt1 = await longtaskCount(p);
      console.log(`  [run ${r + 1}] panZoom=${panZoomMs}ms`);

      // 重置视口：重载页面（仍在项目页，项目已持久化到 IndexedDB）
      await p.reload();
      await p.getByTestId('canvas').waitFor({ timeout: 120000 });
      await p.waitForFunction(
        (n) => document.querySelectorAll('[data-testid="canvas"] g[data-testid^="node-"]').length >= n,
        NODES,
        { timeout: 120000 },
      );

      // 3) 多选拖拽：Ctrl+A 全选后拖拽 b0（默认视口下保证在屏内）
      await installLongtaskProbe(p);
      const before = await nodeTransform(p, 'b0');
      await p.keyboard.press('ControlOrMeta+a');
      t0 = Date.now();
      const nbox = (await p.getByTestId('node-b0').boundingBox())!;
      await p.mouse.move(nbox.x + 60, nbox.y + 20);
      await p.mouse.down();
      await p.mouse.move(nbox.x + 260, nbox.y + 120, { steps: 10 });
      await p.mouse.up();
      const multiDragMs = Date.now() - t0;
      console.log(`  [run ${r + 1}] multiDrag=${multiDragMs}ms`);
      const after = await nodeTransform(p, 'b0');
      if (before === after) throw new Error('多选拖拽未改变节点位置');
      const lt2 = await longtaskCount(p);

      // 4) 撤销：一次 Ctrl+Z 回到拖拽前
      await installLongtaskProbe(p);
      t0 = Date.now();
      await p.keyboard.press('ControlOrMeta+z');
      await p.waitForFunction(
        (exp) => document.querySelector('[data-testid="node-b0"]')?.getAttribute('transform') === exp,
        before,
        { timeout: 30000 },
      );
      const undoMs = Date.now() - t0;
      const lt3 = await longtaskCount(p);
      console.log(`  [run ${r + 1}] undo=${undoMs}ms`);

      runs.push({ loadMs, panZoomMs, multiDragMs, undoMs, longtasks: lt1 + lt2 + lt3 });
      console.log(`run ${r + 1}: load=${loadMs}ms panZoom=${panZoomMs}ms multiDrag=${multiDragMs}ms undo=${undoMs}ms longtasks=${lt1 + lt2 + lt3}`);
    } finally {
      await p.close();
      await ctx.close();
    }
  }

  const result = {
    benchmark: 'graph-edit',
    seed: SEED,
    nodes: NODES,
    edges: EDGES,
    browser: browserName,
    userAgent: ua,
    viewport: { width: 1280, height: 720 },
    runs,
    recordedAt: new Date().toISOString(),
  };
  const outDir = path.join(process.cwd(), 'tests', 'bench', 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `graph-edit-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`结果写入 ${out}`);
});
