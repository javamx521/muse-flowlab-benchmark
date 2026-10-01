# FlowLab Studio — 进度追踪

> 每阶段更新：已完成 / 未完成 / 测试结果 / 待修复 / 阻塞 / 下一步。

## M0 环境与最早部署（进行中）

### 已完成
- [x] 能力自检：本地 node v24.20.0 / npm 10.9.4 可用；GitHub 授权已连接（`github status` ok）
- [x] 空项目骨架：Vite + React 18 + TS 严格模式 + Hash 路由
- [x] 六个标准脚本：`npm ci / lint / typecheck / test:unit / test:e2e / build`
- [x] 项目列表真实 CRUD（创建/重命名/删除确认/搜索），localStorage 持久化
- [x] 明暗主题切换（持久化）、404/空项目深链接态、页脚构建版本/SHA 展示
- [x] CI 工作流（push/PR 全门禁）、Deploy 工作流（main 先验证后发布）、E2E 跨浏览器工作流（周/手动）
- [x] docs/PROGRESS.md、docs/DECISIONS.md、docs/REQUIREMENTS.md 建立

### 未完成
- [ ] 本地六项脚本实际跑通（待执行）
- [ ] 首次推送到 `javamx521/muse-flowlab-benchmark`（等门禁：用户手动建仓库+授权）
- [ ] GitHub Actions 首次部署 Pages 并线上验证（等用户在 Settings → Pages 设置发布源为 GitHub Actions）

### 测试结果（本地，2026-10-02）
- `npm ci` ✅ 通过
- `npm run lint` ✅ 通过（0 错误）
- `npm run typecheck` ✅ 通过
- `npm run test:unit` ✅ 通过（26 个测试，覆盖率 statements 98.4% / branches 86.3% / functions 100% / lines 98.4%，达标）
- `npm run build` ✅ 通过（产物 `dist/`，资源路径含 `/muse-flowlab-benchmark/` base 前缀）
- `npm run test:e2e` ⛔ 本地进行中：`npx playwright install chromium` 首次因网络权限被拒；
  用户已批准 `playwright-verizon.azureedge.net` 权限后重试，Playwright 自带下载器仍失败
  （code=1，经排查为其下载器与出口代理兼容问题；curl 经同一代理可正常下载）。
  改用 curl 手动下载官方 chromium-1148 包并解压到 Playwright 浏览器目录（后台下载中）。
  CI（`ci.yml` / `deploy.yml`）本来就包含安装+运行步骤，不受影响。绝不伪造成功。

### 阻塞 / 权限
- GitHub App 无法创建仓库（已知 403）；用户睡前手动创建公开仓库并加入 App 授权范围。
- Pages 发布源需用户在仓库 Settings → Pages 设为 GitHub Actions。

### 下一步最小任务
1. 本地跑通六项脚本并修复问题
2. 门禁通过后首次推送（含 Actions 工作流）
3. 观察 deploy.yml 运行，拿到 Pages 地址后做线上烟雾验证
4. 进入 M1

## M1 第一条真实业务链（进行中，2026-10-02）

### 已完成
- [x] 引擎核心：`src/engine/`（types / dataModel / csv / expressions / nodes / graph / executor / worker / workerBackend）
  - 数据语义 F03：null vs ''、数字 vs 数字字符串、严格同类型关联键、有限数校验、安全整数拒绝
  - 受限表达式语言 F05：手写递归下降解析器 + 白名单 AST 解释器，零 eval/Function；保留字段黑名单；长度/深度/节点数上限
  - CSV 解析（RFC 4180 风格）+ 公式注入防护（危险前缀转义，正常负数不转义）
  - 图算法：确定性拓扑排序、环检测（含环路径）、运行前校验（缺失输入/悬空边/重复连线/表达式语法），问题可跳转节点
  - 执行器 F04：runId/graphRevision 固定、节点状态机、Worker 内计算、真实取消（terminate + 迟到消息按 runId 丢弃）、失败下游 skipped
- [x] M1 四种节点：csv-input / filter / computed-column / output（含参数 schema、implVersion）
- [x] 工作台 UI：SVG 画布（拖拽/连线/平移缩放/多选）、节点面板、检查器（表达式函数提示）、运行栏、问题列表（点击跳转）、结果面板（输出预览/运行日志/旧版本标注）、CSV 下载
- [x] 存储：ProjectDocument（version=1）+ StorageBackend 接口；M1 用 LocalStorageBackend（M3 迁 IndexedDB）；自动保存防抖，仅持久化成功后标记"已保存"
- [x] 未知项目 id 明确 404，不静默创建（深链接不代表数据同步）

### 测试结果（本地，2026-10-02 全绿）
- `lint` ✅ 0 错误；`typecheck` ✅；`build` ✅（Worker 独立分块 `worker-*.js`）
- `test:unit` ✅ 96 通过；覆盖率 statements 95.3% / branches 82.2% / functions 99.3%
  （门槛 85/80/85，达标）
- `test:e2e` ✅ 11/11 通过：5 条 M1 真实流程（业务链/错误修复/删除/刷新恢复/运行隔离）+ 6 条烟雾

### E2E 过程中发现并修复的真问题（3 个产品 bug + 2 个测试 bug）
- P1：新节点 40px 级联导致重叠，后加节点盖住先加节点端口 → 改 2 列网格排布（D-011）
- P2：较长端口拖拽触发浏览器原生 HTML5 dragstart，吞掉 mouseup → mousedown 统一 preventDefault（D-010）
- P3：结果面板 260px 在 720p 下遮挡第二行节点 → 收紧排布 + 面板可折叠（D-012）
- T1：getByLabel('新建项目') 歧义 → 改 #new-project-name
- T2：重命名测试的 card 定位器在点击后失效 → 页面级定位

### M1 收尾
- [x] F03 静态列推断：运行前识别失效字段引用（D-009），E2E 错误修复流覆盖
- [x] 全部本地门禁通过；文档更新（PROGRESS/DECISIONS/REQUIREMENTS）

### 下一步
1. 进入 M2（剩余 12 种节点：json-input/select-columns/sort/aggregate/join/union/dedupe/limit/sample/fill-null/cast/row-number；调试模式/断点/运行快照；列推断扩展到全部节点）

## M2 完整编辑与执行（进行中，2026-10-02）

### 已完成
- [x] 引擎：16 种节点全部实现（新增 json-input / synthetic-input / select-columns / branch / join / union / dedupe / aggregate / sort / limit / assert / chart）
  - 多输入/多输出端口：`Edge.sourcePort/targetPort`；branch 返回 `{true,false}`；join/union 双输入 `in/in2`
  - 调试模式 F04：`RunManager.start(graph, {debug})` 单并发 + 断点暂停/单步/继续；`NodeInstance.breakpoint`；`RunRecord.debugPausedAt`
  - 运行快照：`RunRecord.portOutputs`（全端口输出）；运行历史保留最近 5 条，可切换查看
  - 列推断扩展到全部 16 种节点 + 多输入端口（`inferInputColumns(graph, nodeId, port)`）
  - 校验增强：非法端口/重复端口连线/union 列集不一致/join 键缺失/结构化参数解析/终端节点警告
- [x] UI：节点面板按分组（输入/变换/输出）；画布多端口渲染与连线（端口标签）；检查器断点开关；
      顶栏调试控制（调试开关/暂停/继续/单步）；运行历史下拉；branch 端口切换查看（匹配/不匹配）；
      ChartView SVG 图表（柱状/折线/散点）；小地图；复制粘贴（Ctrl+C/V）；自动布局（拓扑分层）
- [x] E2E 修复：join 参数名为 `keys`（非 `key`）；chart 默认 x/y 列改为空（原示例值导致校验失败）

### 测试结果（本地，2026-10-02 全绿）
- `lint` ✅ 0 错误；`typecheck` ✅；`build` ✅
- `test:unit` ✅ 159 通过（新增 m2.test.ts 63 个）；覆盖率 statements 96.1% / branches 82.2% / functions 99.5%（门槛 85/80/85，达标）
- `test:e2e` ✅ 9/9 通过：5 条 M1（无回归）+ 4 条 M2（join 多输入连线 / branch+chart 端口切换 / 调试断点暂停-单步-继续 / 复制粘贴+自动布局+小地图）

### 下一步
1. M2 收尾：文档更新（PROGRESS/DECISIONS/REQUIREMENTS）；本地 commit（不 push）
2. 进入 M3（数据可靠性）

## M3 数据可靠性（已完成，2026-10-02）

### 已完成
- [x] F06 撤销/重做：`src/store/history.ts`（UndoHistory：100 步上限、coalesceKey 合并拖拽/键入、新编辑清空 redo）；
      `useEditor.edit()` 包装所有图变更压历史；拖拽会话 beginDrag/endDrag；Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y / Ctrl+S；
      快照恢复本身可撤销
- [x] F07 持久化：`src/store/indexedDb.ts`（DB `flowlab-studio`，projects/docs 双 store，rev 乐观并发）；
      `src/store/appStores.ts` 单例（IndexedDB 优先、不可用降级 localStorage；localStorage 旧数据一次性幂等迁移）；
      自动保存（800ms 防抖）+ 保存状态指示（已保存/保存中…/保存失败）
- [x] 工程版本：`DOCUMENT_VERSION=2`（+createdAt、+snapshots）；`src/store/migrate.ts`（v1→v2 迁移、损坏/超版本拒绝）；
      `src/store/exportImport.ts`（导出/导入 `.flowlab.json`，导入一律创建独立新项目）
- [x] 快照：`src/store/snapshots.ts`（diffGraphs：节点/连线/参数/数据引用变化，布局差异独立标 layoutOnly）；
      快照对话框（创建/恢复/删除/与当前比较）
- [x] 多标签页：`save(doc, expectedRev)` rev 语义（`RevisionedStorageBackend`）；冲突对话框三选项
      （重新加载 / 强制覆盖 / 另存为副本，Esc 与遮罩点击不可绕过，本地修改保留）
- [x] 首页：异步注册表、导入工程文件、复制项目（深拷贝独立）、"数据只保存在当前浏览器"提示

### 测试结果（本地，2026-10-02 全绿）
- `lint` ✅ 0 错误；`typecheck` ✅；`build` ✅
- `test:unit` ✅ 184 通过（新增 `tests/unit/m3.test.ts` 25 个：history 合并/上限/清空 redo、v1→v2 迁移/损坏拒绝、
  快照 diff、MemoryBackend rev 并发语义、导出导入往返）；覆盖率 statements 95.3% / branches 82.1% / functions 98.3%（门槛 85/80/85，达标）
- `test:e2e` ✅ 24/24 通过（15 条 M0–M2 无回归 + 9 条 M3：撤销重做按钮/快捷键拖拽合并/刷新恢复/快照比较恢复/
  导出导入往返/v1 导入迁移/损坏文件导入/复制项目独立/双标签页冲突→另存为副本）
- E2E 缺陷分析与修复（均已验证）：
  1. `StorageBackend.save` 返回类型冲突 → 统一为 `Promise<number>`（返回新 rev）
  2. `PROJECTS_KEY` 误从 `../lib/projects` 导入 → 改为 `../lib/storageKeys`
  3. 复制测试 `.first()` 误匹配"副本"卡片（含原文子串）→ 改精确链接文本（测试 bug，产品无问题）
  4. **Playwright quirk**：`testInfo.outputPath` 目录名含中文测试标题时 `setInputFiles` 静默失败 → 固件改用系统临时目录 ASCII 路径（见 D-024；产品代码无问题，经对照实验证实）

### 下一步
1. 进入 M4（深层工程能力：F08 增量计算/大数据/性能）
2. 最终统一推送前不 push（用户已睡，中途零 push 约定）
## M4 深层工程能力（进行中，2026-10-02）

### 目标（F08 增量计算、大数据与性能）
- 内容感知增量缓存：相同输入+参数+实现版本 → 复用上次结果；节点位置移动不失效；调试模式绕过
- 虚拟化大数据表格：10 万行可流畅滚动（固定行高 28px + 滚动窗口渲染 + overscan）
- 增量重算：只重算缓存失效的子图
- 可复现性能基准（图编辑 300 节点 / 数据 100k 行），只记录不设门禁

### 实现
- `src/engine/cache.ts`（新）：`RunCache`（LRU，上限 50 条，淘汰统计）、`hashDataTable`
  （FNV-1a 内容哈希，WeakMap 记忆化，区分 `1`/`"1"`/`null`/`-0`/`NaN`）、`stableStringify`
  （键序无关规范参数序列化）、`makeNodeCacheKey` = `flc1|<kind>|v<implVersion>|<规范参数>|<端口=哈希,…>`
- `src/engine/executor.ts`：`RunOptions.cache?`；执行前查缓存（命中复用表对象、`cacheHit: true`、
  `record.cacheHits++`），执行后写入；调试模式不传 cache
- `src/store/useEditor.ts`：会话级 `RunCache` 单例（`cacheRef`），`run()` 传入 cache，
  `cacheStats()` / `clearCache()` actions
- `src/components/DataTableView.tsx`（重写虚拟化）：固定行高 28px（`ROW_H`，与 `src/app.css`
  的 `.virtualized` 约定一致）、滚动窗口渲染、上下 overscan 各 8 行、占位行撑高、thead 吸顶
- `src/pages/EditorPage.tsx`：运行日志 tab 加"缓存"列（`cache-hit-<id>` 徽标）、`cache-summary`
  汇总行 + `clear-cache` 按钮；Ctrl+A 全选（`graphRef` 防闭包过期）
- `src/engine/types.ts`：`NodeRunInfo.cacheHit?`、`RunRecord.cacheHits`（必填）
- 基准：`tests/bench/`（独立配置 `playwright.bench.config.ts`，`npm run bench`，不进 CI 门禁）；
  `graphEdit.bench.spec.ts`（300 节点/600 边合法 DAG，mulberry32 seed 20261002）；
  `data.bench.spec.ts`（100k×12 种子 CSV 全链路）
- 文档：`docs/BENCHMARKS.md`（新建，转录中位数+环境/种子）、DECISIONS.md D-025/D-026/D-027/D-028

### 测试结果（本地，2026-10-02）
- `tests/unit/cache.test.ts` ✅ 13/13（哈希确定性/类型区分/行列顺序敏感；stableStringify 键序无关；
  键稳定性/参数-版本-输入变化；LRU 淘汰与统计；执行器集成：二次相同运行 4/4 命中零重执行、
  改参数仅下游重算 `cacheHits=1`、只移动位置 4/4 命中、改源数据全失效、调试绕过）
- `tests/e2e/m4-flow.spec.ts` ✅ 3/3（真实浏览器：二次运行"3 个节点命中缓存"+徽标；改条件后
  "1 个节点命中缓存"；清除后重跑 0 命中；5000 行 DOM <200 行，滚动到底部首行 `datarow->4000`）
- 基准实测（chromium headless，生产构建，见 `docs/BENCHMARKS.md`）：
  - 图（中位数）：load 1247ms；panZoom 4581ms（15 ops，≈305ms/操作）；multiDrag 1053ms；undo 236ms
  - 数据 100k（中位数）：import 575ms；冷运行 6908ms；scroll 322ms（20 步）；cancel 273ms
  - 未达标项如实记录（图平移、100k 冷运行），未修改测试数据逃避
- 调试插曲（均已解决，产品无 bug）：
  1. 数据基准"卡住" → 实为测试未切到"运行日志"tab 就等待 `cache-summary`（D-028；20k 行实测 6.2s 正常完成）
  2. 取消测试悬挂 → 同页二次运行命中缓存瞬间完成，`cancel-btn` 不存在；修复为先清缓存再测取消
  3. `node-d6` 点击问题 → SVG `<g>` 无 `.click()`、onMouseDown 在子 rect；改用运行日志行/JS 事件

### 下一步
1. 全部门禁（lint/typecheck/test:unit/test:e2e/build）→ 本地 commit M4（不 push）
2. 进入 M5（F09 快捷键/命令面板/无障碍/手机查看/Service Worker 离线）
## M5 完整产品体验（进行中，2026-10-02）

### 目标（F09 离线、部署更新与交互质量）
- 命令面板（Ctrl+K 模糊搜索执行命令）、快捷键体系（Ctrl+Enter 运行、? 帮助）
- 无障碍：dialog/listbox ARIA、运行状态 live region、跳到画布链接
- 手机查看模式：≤900px 堆叠布局
- Service Worker：离线缓存 + 新版本更新提示横幅

### 实现
- `src/components/CommandPalette.tsx`（新）：模糊匹配、↑↓导航、回车执行、Esc 关闭、
  `role=dialog`/`listbox`/`option`、`aria-activedescendant`
- `src/pages/EditorPage.tsx`：`paletteCommands`（12 个命令）、Ctrl+K/Ctrl+Enter/`?` 快捷键、
  `palette-btn` 顶栏按钮、快捷键帮助对话框、`skip-link`、`run-status-live`
- `src/sw.ts`（新）+ `scripts/build-sw.mjs`：应用壳缓存优先+后台更新、其他资源网络优先；
  版本号取 package.json；`src/lib/serviceWorker.ts` 注册与更新管理；`src/App.tsx` 更新横幅
- `src/app.css`：`.cmd-palette-*` 样式、`.sr-only`/`.skip-link`、移动端媒体查询、
  `.canvas-wrap` 加 `overflow: hidden`、grid 子项 `min-width: 0`

### 测试结果（本地，2026-10-02）
- `tests/e2e/m5-flow.spec.ts` ✅ 8/8（命令面板打开/搜索执行/Esc；`?` 帮助；Ctrl+Enter 真实运行；
  dialog/listbox/option ARIA；跳链/live region；390px 移动端；SW 注册）
- 真实 bug 修复（均有证据）：
  1. D-029：命令面板 `.palette` 类名与侧边栏冲突致布局错乱 → 加 `cmd-` 前缀，截图验证修复
  2. D-030：`key === 'Enter'` 永假（key 已小写）→ 改为 `'enter'`，E2E 验证

### 下一步
1. 全量 E2E 回归 → 本地 commit M5（不 push）
2. 进入 M6（最终交付：全量回归、文档、统一推送、Pages 验证）
## M6 最终交付（进行中，2026-10-02）

### 交付前最终回归（本地，2026-10-02）
- `lint` ✅ 0 错误；`typecheck` ✅；`build` ✅（含 `dist/sw.js`）
- `test:unit` ✅ 197/197 通过
- `test:e2e` ✅ 31/31 通过（M1–M5 无回归）
- 基准：图/数据基准脚本可用，结果见 `docs/BENCHMARKS.md`

### 推送计划
- 本地 5 个提交（M1 d8a2378 → M2 69f3f3b → M3 48401fa → M4 60d0432 → M5 7342603），
  一次 `push_files` 统一推送到 `javamx521/muse-flowlab-benchmark` 的 main 分支
- 等 CI（ci.yml / e2e.yml）全绿；deploy.yml 自动发布到 Pages
- 真实浏览器验证 Pages 上线：线上站"导入→运行→检查结果"，确认页显构建版本/commit SHA
