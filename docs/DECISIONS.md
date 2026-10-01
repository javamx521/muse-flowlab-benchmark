# FlowLab Studio — 架构决策记录

## D-001 React 18 而非 React 19（M0）
- 选择 React 18.3.1。React 19 已稳定，但图编辑库生态（React Flow v11 / xyflow v12）
  对 React 18 的兼容性最稳。M2 引入图库前复核；如需升级，在此记录。
- 状态：已采用。

## D-002 Vite `base` 硬编码子路径（M0）
- `base: '/muse-flowlab-benchmark/'`，与目标仓库名绑定。
- 备选是用环境变量覆盖；当前选择硬编码以保证生产构建行为确定、可验证。
- 约束：仓库改名必须同步改此值并重新验证部署。
- 状态：已采用。

## D-003 Hash 路由（M0）
- 使用 HashRouter（`/#/project/<id>`），不依赖服务器路由回退，适配 Pages 静态托管。
- 深链接语义：只做本地路由；不代表项目数据已同步到其他设备（已在 404 页文案说明）。
- 状态：已采用。

## D-004 M0 用 localStorage，M3 迁移 IndexedDB（M0）
- M0 只存项目元数据，localStorage 足够且同步 API 简单；键命名空间 `flowlab.studio.v1.*`，
  不清理同域其他应用数据。
- M3（大数据/工程版本/多标签页）迁移到 IndexedDB；届时提供迁移代码与测试。
- 存储访问通过 `StorageLike` 注入，便于单元测试。
- 状态：已采用，M3 执行迁移。

## D-005 依赖版本锁定策略（M0）
- 不盲目用 latest：React 18.3.1 / Vite 6.3 / TS 5.6 / Vitest 2.1 / Playwright 1.49 /
  ESLint 9.15，均为已验证相互兼容的稳定版本。
- `package-lock.json` 提交仓库；CI 用 `npm ci`；Node 基线 22（`.node-version`，
  `engines >= 20`）。
- 状态：已采用。

## D-006 覆盖率范围（M0）
- `test:unit` 覆盖率只统计 `src/lib/**`（核心逻辑），门槛 statements/functions/lines 85、branches 80。
- UI 组件覆盖由 E2E 承担；核心图模型/执行器/持久化模块在 M1–M3 落地后纳入统计并保持 ≥85%。
- 状态：已采用，M6 复核。

## D-007 构建版本注入（M0）
- `VITE_GIT_SHA` / `VITE_BUILD_TIME` 由 CI 注入；本地构建回退为 `dev`。
- 页脚展示版本与短 SHA，用于核验线上版本是否对应最终通过测试的提交（任务书 §6.7）。
- 状态：已采用。

## D-008 受限表达式语言：零 eval，手写解析器（M1）
- 自研递归下降解析器 + 白名单 AST 解释器；禁用 `eval`/`Function`/`原型链访问`。
- 字段只能 `$name` 引用（保留字段黑名单）；字面量/运算符/白名单函数；长度/嵌套深度/AST 节点数上限防 DoS。
- 除零得 `null`（不抛错，SQL 语义）；上溢/非有限数抛错；混合类型比较返回 `null`（过滤视为假）。
- 状态：已采用；M2 评估是否需要更多函数。

## D-009 静态列推断：运行前识别失效字段引用（M1）
- `inferOutputColumns`/`inferInputColumns`：csv-input 从表头推断；单输入变换沿用上游列；
  computed-column 追加目标列；无法确定时返回 null（不误报，错误由运行时报告）。
- 环保护（seen 集）；`validateGraph` 在列可推断时报告"引用了不存在的字段"，运行按钮禁用。
- 决策依据：任务书 F03 明确要求"在运行前识别缺失输入、失效字段引用"。
- 状态：已采用；M2 扩展到全部 16 种节点与多输入。

## D-010 画布 mousedown 必须 preventDefault（M1，E2E 实测）
- Playwright E2E 发现：较长距离的端口拖拽会触发浏览器原生 HTML5 dragstart，
  导致后续 mousemove/mouseup 被吞掉、连线失败（短距离拖拽恰好低于阈值而不触发，具有迷惑性）。
- 修复：节点/端口/背景的 mousedown 处理器统一 `preventDefault()`（并保留 stopPropagation），
  彻底接管拖拽；同时避免节点拖拽时选中文本。
- 状态：已采用；回归用例为 m1-flow 的三段连线 E2E。

## D-011 新节点 2 列网格排布（M1）
- 新节点按 2 列网格放置（列距 260 / 行距 110），保证默认可视区（约 780×270 @720p）内
  不重叠、不被结果面板遮挡；端口永远可点。
- 替代过：40px 级联（节点重叠盖住端口，E2E 实测失败）。复杂自动布局留待后续里程碑。
- 状态：已采用。

## D-012 结果面板可折叠（M1）
- 结果面板默认高 260px，在小高度视口会遮挡第二行节点；增加折叠按钮（▾/▴），
  收起后画布获得完整高度。`data-testid="toggle-results"`。
- 状态：已采用。

## D-013 运行隔离：graphRevision 快照（M1）
- 运行请求固定 `runId` + `graphRevision`；运行中编辑图会使 revision 变化，
  结果面板标注"结果对应旧版本 rX，当前 rY"徽标；取消时 terminate Worker 并按 runId 丢弃迟到消息。
- 状态：已采用；M4 增量缓存沿用 revision 语义。

## D-014 节点清单以任务书为准（M2）
- 任务书 16 种节点：csv-input / json-input / synthetic-input / select-columns / branch / filter /
  computed-column / join / union / dedupe / aggregate / sort / limit / assert / chart / output。
- 早期草案中的 sample / fill-null / cast / row-number 未实现（任务书无此要求）。
- 状态：已采用。

## D-015 多端口语义（M2）
- `Edge.sourcePort/targetPort` 可选；缺省为 `out`/`in`（向后兼容 M1 数据）。
- branch 输出端口 `true`/`false`，主输出为 `true`；下游边按 `sourcePort` 取数。
- join/union 输入端口 `in`/`in2`；UI 同一输入端口的新连线替换旧连线（重新连线语义），
  校验层仍保留"单输入端口多条连线"报错以覆盖导入数据。
- 状态：已采用。

## D-016 调试模式单并发（M2，F04）
- `RunManager.start(graph, {debug:true})` 强制 maxConcurrency=1；断点在节点执行前触发暂停；
  `pauseDebug()` 在下一个节点边界暂停；`stepDebug()` 单步一个节点后再次暂停。
- 暂停时 UI 高亮节点（`debug-paused` 样式 + `debug-paused-badge` 徽标）；继续/单步后清除暂停态。
- 状态：已采用。

## D-017 运行历史保留 5 条（M2）
- `runHistory` 最多保留最近 5 条 `RunRecord`（含 portOutputs 全端口输出）；
  下拉切换查看历史快照；只有 1 条时不显示选择器。
- 状态：已采用。

## D-018 合成数据列类型启发式（M2）
- synthetic-input 按列名启发式推断类型（id/age/price→整数等），LCG 确定性生成；
  规则写在节点 help 文本中，避免"魔法"行为。
- 状态：已采用。

## D-019 图表默认字段留空（M2，E2E 实测）
- chart 的 xColumn/yColumn 默认值原为示例值（city/amount），导致新节点校验失败、运行按钮禁用；
  改为空字符串 + placeholder 示例，由用户填写。
- 状态：已采用。

## D-020 撤销用图快照栈（M3，F06）
- 撤销/重做直接保存不可变图快照（引用安全由 reducer 不可变保证），而非命令模式；
  上限 100 步；拖拽/键入用 `coalesceKey` 合并连续编辑；新编辑清空 redo 栈。
- 状态：已采用。

## D-021 IndexedDB 存储结构（M3，F07）
- DB 名 `flowlab-studio`；`projects` store 存元数据（keyPath id），`docs` store 存 `{id, rev, doc}`；
  rev 乐观并发：`save(doc, expectedRev)` 在 rev 不一致时抛 `ConflictError`。
- 不可用时降级 localStorage（单例 `getBackend()` 按环境选择）。
- 状态：已采用。

## D-022 工程格式 v2 与迁移（M3，F07）
- `DOCUMENT_VERSION=2`（新增 `createdAt`、`snapshots`）；v1→v2 自动迁移；
  损坏/超版本直接拒绝并报错，不静默丢弃；旧 localStorage 数据一次性幂等迁入 IndexedDB。
- 状态：已采用。

## D-023 多标签页冲突三选项（M3，F07）
- 保存时 rev 过期 → 冲突对话框（Esc/遮罩不可绕过，本地修改保留）：
  重新加载（放弃本地）、强制覆盖（显式二次确认）、另存为副本（默认推荐）。
- 状态：已采用。

## D-024 E2E 上传路径必须全 ASCII（M3，测试教训）
- 实测 Playwright 在此环境对含中文字符的上传路径 `setInputFiles` 静默失败（change 不触发）；
  `testInfo.outputPath` 目录名来自中文测试标题，故固件改写系统临时目录 ASCII 路径
 （`tests/e2e/m3-flow.spec.ts` 的 `asciiFixturePath`）。
- 状态：已采用（测试约定）。

## D-025 增量缓存键设计（M4，F08）
- 缓存键 = `flc1|<kind>|v<implVersion>|<规范参数>|<端口=内容哈希,…>`；节点**位置不参与**键（单纯移动不失效）。
- 内容哈希用 FNV-1a（字符串/数字/布尔/null 区分类型；-0/NaN 单独标记），按表对象 WeakMap 记忆化；
  参数用键序无关的 `stableStringify` 规范化。
- 命中时复用同一表对象（下游哈希随之稳定）；调试模式绕过缓存（保证断点/日志看到真实执行）。
- 保留策略：运行历史最多 5 条、RunCache LRU 上限 50 条、可手动清除；调试/超限不报错。
- 状态：已采用。

## D-026 表格虚拟化行高约定（M4，F08）
- 虚拟化表格固定行高 28px（`ROW_H`），CSS `.virtualized td` 必须同步 28px，否则占位计算错位；
  overscan 上下各 8 行，thead 吸顶；100k 行滚动用 rAF 分步验证。
- 状态：已采用。

## D-027 基准只记录不设门禁（M4，F08）
- `tests/bench/*.bench.spec.ts` 用独立 Playwright 配置（`npm run bench`），不进 CI 质量门禁；
  固定种子（mulberry32，seed 20261002）、1 次预热 + 3 次实测，记录浏览器 UA/视口/长任务数；
  P95<150ms 等为目标非保证，未达标如实记录瓶颈，不改数据逃避。
- 状态：已采用。

## D-028 基准/测试必须先切到"运行日志"tab 再断言 cache-summary（M4，测试教训）
- `cache-summary` 与运行日志行只在结果面板 `tab==='log'` 时渲染；直接等待该 testid 会超时，
  表现为"运行卡住"假象。实测 20k 行链路 6.2s 正常完成，产品无 bug。
- 约定：凡断言运行日志/缓存汇总，先 `getByTestId('tab-log').click()`。
- 状态：已采用（测试约定）。

## D-029 命令面板 CSS 类名必须避免与现有类冲突（M5，真实 bug）
- 现象：命令面板用 `.palette` 类名，与侧边栏 `aside.palette` 冲突，导致侧边栏被
  `width: min(560px, 92vw)` 撑到 560px、画布网格溢出覆盖按钮。
- 修复：命令面板类统一加 `cmd-` 前缀（`.cmd-palette` 等）；另补 `.canvas-wrap`
  `overflow: hidden` 与 grid 子项 `min-width: 0`。
- 状态：已修复并截图验证。

## D-030 快捷键 key 已转小写，比较时用小写（M5，真实 bug）
- `const key = e.key.toLowerCase()` 后，`key === 'Enter'` 永假；改为 `key === 'enter'`。
- 状态：已修复，E2E 验证 Ctrl+Enter 可运行。

## D-031 Service Worker 策略（M5）
- 手写 SW（`src/sw.ts`，经 `scripts/build-sw.mjs` 单独构建为 `dist/sw.js`），
  未引入 workbox：应用壳缓存优先+后台更新，其他同源 GET 网络优先失败回退缓存；
  版本号取 package.json version；新版本 `skipWaiting` 由页面"立即更新"按钮触发，
  顶部横幅提示（`role=status`）。
- 仅生产构建注册；GitHub Pages 子路径 scope 取 `import.meta.env.BASE_URL`。
- 状态：已实现；E2E 仅断言注册 scope（含环境不支持时的降级断言）。
