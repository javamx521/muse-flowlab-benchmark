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
