# FlowLab Studio 性能基准（M4，F08）

> 方法：固定种子、可复现；每次基准 = 1 次预热（不计入）+ 3 次实测。
> 目标（P95<150ms 等）为期望方向，不作为门禁；未达标如实记录，不修改测试数据逃避。
> 原始结果：`tests/bench/results/*.json`。运行：`npm run bench`（默认 chromium）。

## 环境

| 项 | 值 |
|---|---|
| 时间 | 2026-10-02 |
| 浏览器 | Chromium（Playwright chromium-1148 headless shell） |
| UA | Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.6778.33 Safari/537.36 |
| 视口 | 1280×720 |
| 构建 | 生产构建（`vite build` + `vite preview`），真实 Web Worker |
| 种子 | mulberry32，seed `20261002` |

## 基准 1：图编辑（300 节点 / 600 边合法 DAG）

`tests/bench/graphEdit.bench.spec.ts` —— 测量：导入→打开→300 节点渲染完成（load）；
10 次背景拖拽 + 5 次 Ctrl+滚轮缩放（panZoom，15 个操作）；Ctrl+A 全选后单次 200px 拖拽（multiDrag）；
一次 Ctrl+Z（undo）。长任务经 PerformanceObserver（`longtask`）收集。

| run | load | panZoom（15 ops） | multiDrag | undo | 长任务数 |
|---|---|---|---|---|---|
| 1 | 1424ms | 4871ms | 1689ms | 236ms | 16 |
| 2 | 1022ms | 4300ms | 1053ms | 223ms | 10 |
| 3 | 1247ms | 4581ms | 922ms | 253ms | 9 |
| **中位数** | **1247ms** | **4581ms（≈305ms/操作）** | **1053ms** | **236ms** | **10** |

结论：300 节点规模下加载与单次操作均在秒级内完成；平移/缩放单操作约 300ms，
主要为 300 节点 SVG 重渲染开销。未达到"所有交互 <150ms"目标，瓶颈在整图重渲染；
后续优化方向（未实现）：视口裁剪（只渲染可见节点）、拖拽节流。

## 基准 2：数据（100,000 行 × 12 列 CSV）

`tests/bench/data.bench.spec.ts` —— 链路：CSV 输入 → 过滤（`$age >= 30`）→ 计算列
（`total = $price * $qty`）→ 分组聚合（按 city，`n:count(*)` / `total:sum(total)`）
→ 排序（`total desc`）→ 输出。测量：导入、冷缓存运行总耗时、结果滚动（20 步 rAF）、
运行中取消的响应时间。

| run | import | run（冷缓存） | scroll（20 步） | cancel 响应 | 输出行数 |
|---|---|---|---|---|---|
| 1 | 693ms | 6859ms | 319ms | 556ms | 8 |
| 2 | 574ms | 6908ms | 331ms | 273ms | 8 |
| 3 | 575ms | 6930ms | 322ms | 269ms | 8 |
| **中位数** | **575ms** | **6908ms** | **322ms** | **273ms** | **8** |

结论：100k 行 CSV（4.2MB）导入约 0.6s；全链路冷运行约 6.9s（其中 CSV 解析
572ms、过滤 22ms，其余为分组聚合/排序与 Worker 往返）；虚拟化表格 20 步滚动
322ms；运行中取消约 0.3s 恢复。单次运行未达到"10 万行 <3s"目标，瓶颈在
Worker 消息序列化（4.2MB CSV 文本往返）与分组聚合；后续优化方向（未实现）：
Transferable/ArrayBuffer 传表、聚合算子向量化。

## 增量缓存效果（单元测试实测，非基准）

`tests/unit/cache.test.ts` —— 相同图二次运行 4/4 节点命中且零重新执行；
修改中间节点参数后仅该节点及下游重算（1/4 命中）；只移动位置 4/4 命中；
调试模式绕过缓存。E2E（`tests/e2e/m4-flow.spec.ts`）在真实浏览器中复核了
命中徽标、汇总行与清除缓存行为。
