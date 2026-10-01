# FlowLab Studio — 需求追踪表

> 状态说明：已实现且已验证 / 已实现但未验证 / 部分实现 / 未实现 / 被环境阻塞。
> M0 只要求骨架与部署；F01–F09 的完整功能按 M1–M6 逐阶段交付。

## 部署与质量（任务书 §2 / §5 / §6）

| 需求 | 状态 | 实现位置 | 测试证据 |
|---|---|---|---|
| 六个标准脚本 | 部分实现 | `package.json` | 本地 5/6 通过；`test:e2e` 本地被环境阻塞（无浏览器，安装下载被拒绝），待 CI 验证 |
| CI 全门禁 | 已实现但未验证 | `.github/workflows/ci.yml` | 首次 push 后 CI 运行链接（待） |
| Pages 自动部署 | 已实现但未验证 | `.github/workflows/deploy.yml` | 首次部署运行链接（待） |
| 跨浏览器 E2E | 已实现但未验证 | `.github/workflows/e2e.yml` | 周/手动运行（待） |
| 页面展示构建版本/SHA | 已实现但未验证 | `src/lib/version.ts`, `src/App.tsx` | E2E `页脚展示构建版本信息`（待 CI） |
| Hash 路由与 404 态 | 已实现但未验证 | `src/App.tsx`, `src/pages/EditorPage.tsx` | E2E 深链接用例（待 CI） |

## F01 完整工作台

| 需求 | 状态 | 实现位置 | 测试证据 |
|---|---|---|---|
| 项目列表 CRUD | 已实现且已验证 | `src/pages/HomePage.tsx`, `src/lib/projects.ts` | `tests/unit/projects.test.ts`（21 用例）✅；E2E CRUD 用例待 CI |
| 工作台布局（节点库/画布/属性/日志/工具栏） | 未实现 | M2 | — |
| 面板可调/配置保存/快捷键/命令面板 | 未实现 | M2/M5 | — |

## F02 真实图编辑器（16 类节点）

| 需求 | 状态 | 实现位置 | 测试证据 |
|---|---|---|---|
| 4 种节点（csv-input/filter/computed-column/output） | ✅ M1 完成 | `src/engine/nodes.ts` | `tests/unit/engine.test.ts`（节点定义/执行）；E2E m1-flow 业务链 |
| 剩余 12 种节点 | ✅ M2 完成 | `src/engine/nodes.ts` | `tests/unit/m2.test.ts`（63 个）；E2E m2-flow（join/branch/chart） |
| 多输入/多输出端口、端口连线、复制粘贴、自动布局、小地图 | ✅ M2 完成 | `src/components/Canvas.tsx`、`src/store/useEditor.ts` | E2E m2-flow（多输入连线/复制粘贴/自动布局/小地图） |

## F03 图与数据语义

| 需求 | 状态 | 实现位置 | 测试证据 |
|---|---|---|---|
| 数据语义（null vs ''、严格类型、有限数/安全整数拒绝、公式注入防护） | ✅ M1 完成 | `src/engine/dataModel.ts`、`csv.ts` | `tests/unit/engine.test.ts`（数据语义/CSV/公式注入） |
| 确定性拓扑排序、环检测、运行前校验（缺失输入/悬空边/重复连线） | ✅ M1 完成 | `src/engine/graph.ts`（topoSort/validateGraph/canRun） | 单元测试；E2E 删除节点/问题跳转 |
| 运行前识别失效字段引用（静态列推断） | ✅ M1 完成 | `inferOutputColumns`/`inferInputColumns` | 单元测试"列推断"；E2E 错误修复流 |
| 列推断扩展到全部 16 种节点/多输入 | ✅ M2 完成 | `src/engine/graph.ts` | `tests/unit/m2.test.ts`（列推断/校验）；E2E chart 字段校验 |

## F04 真实执行与调试

| 需求 | 状态 | 实现位置 | 测试证据 |
|---|---|---|---|
| Worker 内真实执行、节点状态机、失败下游 skipped | ✅ M1 完成 | `src/engine/executor.ts`、`worker.ts` | 单元测试（执行器/取消语义）；E2E 业务链真实计算断言 |
| runId/graphRevision 快照、运行隔离、旧版本标注、取消 | ✅ M1 完成 | `RunManager`、`useEditor.ts`、`EditorPage.tsx` | 单元测试；E2E 运行隔离 |
| 调试模式/断点/运行快照 | ✅ M2 完成 | `src/engine/executor.ts`（RunManager 调试）、`src/pages/EditorPage.tsx` | `tests/unit/m2.test.ts`（调试暂停/单步）；E2E m2-flow 调试模式 |

## F05 表达式与导入安全

| 需求 | 状态 | 实现位置 | 测试证据 |
|---|---|---|---|
| 受限表达式语言（零 eval、手写解析器+白名单解释器、字段黑名单、长度/深度/节点数上限） | ✅ M1 完成 | `src/engine/expressions.ts` | `tests/unit/engine.test.ts`（33+ 表达式用例：语法/函数/注入/DoS 上限） |
| 更多函数/安全加固 | 按需 | M2/M4 | — |

## F06 撤销、重做与一致性

| 需求 | 状态 | 实现位置 | 测试证据 |
|---|---|---|---|
| 撤销/重做（100 步、拖拽合并、Ctrl+Z/Y/S） | ✅ M3 完成 | `src/store/history.ts`、`src/store/useEditor.ts` | `tests/unit/m3.test.ts`（合并/上限/清空 redo）；`tests/e2e/m3-flow.spec.ts`（按钮+快捷键+拖拽合并） |
| 快照可撤销（恢复压入历史） | ✅ M3 完成 | `src/store/useEditor.ts` | E2E：恢复后 Ctrl+Z 回到 2 节点 |

## F07 持久化、工程版本与多标签页

| 需求 | 状态 | 实现位置 | 测试证据 |
|---|---|---|---|
| 项目元数据本地保存 | ✅ M3 完成（IndexedDB，localStorage 一次性迁移） | `src/store/indexedDb.ts`、`src/store/appStores.ts` | E2E：刷新恢复；单元测试迁移幂等 |
| 工程格式 v2 + v1 迁移 + 损坏拒绝 | ✅ M3 完成 | `src/store/migrate.ts`、`src/store/document.ts` | `tests/unit/m3.test.ts`；E2E：v1 导入迁移 / 损坏文件报错且不破坏现有项目 |
| 导出/导入 `.flowlab.json`（独立新项目） | ✅ M3 完成 | `src/store/exportImport.ts` | E2E：导出→导入往返 |
| 快照（创建/比较/恢复） | ✅ M3 完成 | `src/store/snapshots.ts` | `tests/unit/m3.test.ts`（diff）；E2E：创建→比较→恢复 |
| 多标签页 rev 乐观并发 + 冲突三选项 | ✅ M3 完成 | `src/store/document.ts`（rev）、`src/store/useEditor.ts` | `tests/unit/m3.test.ts`（并发语义）；E2E：双标签页冲突→另存为副本 |
| 复制项目（深拷贝独立） | ✅ M3 完成 | `src/store/indexedDb.ts`、`src/pages/HomePage.tsx` | E2E：副本互不影响 |

## F08 增量计算、大数据与性能

| 需求 | 状态 | 实现位置 | 测试证据 |
|---|---|---|---|
| 内容感知缓存（参数+输入哈希+实现版本键；位置不参与） | 已实现且已验证 | `src/engine/cache.ts`、`src/engine/executor.ts`、`src/store/useEditor.ts`（`cacheRef`/`cacheStats`/`clearCache`） | `tests/unit/cache.test.ts` 13/13；`tests/e2e/m4-flow.spec.ts` 3/3（真实浏览器命中徽标/汇总/清除） |
| 虚拟化大数据表格（10万行可滚动，固定行高+窗口渲染） | 已实现且已验证 | `src/components/DataTableView.tsx`（`ROW_H=28`，overscan 8）、`src/app.css` | `tests/e2e/m4-flow.spec.ts`（5000 行 DOM <200 行；滚动到底部首行 `datarow->4000`） |
| 增量重算（仅失效子图执行） | 已实现且已验证 | 同上（缓存键天然实现） | 单元+E2E：改 filter 参数仅下游重算，`cacheHits=1` |
| 调试模式绕过缓存 | 已实现且已验证 | `src/engine/executor.ts`（`RunOptions.cache` 可选；调试不传） | `tests/unit/cache.test.ts` |
| 性能基准（图 300 节点 / 数据 100k 行，可复现） | 已实现且已验证 | `tests/bench/` + `docs/BENCHMARKS.md`（中位数见文档） | 基准脚本 2026-10-02 实测通过；原始 JSON 在 `tests/bench/results/` |
| 性能目标（P95<150ms / 10万行<3s） | 部分实现 | 未达标项如实记录于 `docs/BENCHMARKS.md`（图平移 ~305ms/操作；100k 冷运行 6.9s） | 基准数据为证，未修改测试数据逃避 |

## F09 离线、部署更新与交互质量

| 需求 | 状态 | 实现位置 | 测试证据 |
|---|---|---|---|
| 命令面板（Ctrl+K，模糊搜索） | 已实现且已验证 | `src/components/CommandPalette.tsx`、`src/pages/EditorPage.tsx`（`paletteCommands`） | `tests/e2e/m5-flow.spec.ts` 8/8（含打开/搜索执行/Esc/无障碍属性） |
| 快捷键（Ctrl+Enter 运行、? 帮助等） | 已实现且已验证 | 同上；`?` 快捷键帮助对话框 | E2E：Ctrl+Enter 真实运行；`?` 打开帮助 |
| 无障碍（dialog/listbox/option、live region、跳链） | 已实现且已验证 | CommandPalette ARIA；`run-status-live`；`skip-link` | E2E 断言 role/aria 属性 |
| 手机查看模式（≤900px 堆叠布局） | 已实现且已验证 | `src/app.css` 媒体查询 | E2E：390px 视口布局不断裂、面板可用 |
| Service Worker 离线 + 更新提示 | 已实现且已验证 | `src/sw.ts`、`scripts/build-sw.mjs`、`src/lib/serviceWorker.ts`、`src/App.tsx` 横幅 | E2E：生产构建注册 scope 断言；构建产物含 `dist/sw.js` |
| 真实 bug 修复 | 已实现且已验证 | D-029（CSS 类冲突）、D-030（快捷键大小写） | 截图前后对比；E2E 通过 |

## M0 交付检查（任务书 §7）

| 项 | 状态 |
|---|---|
| 能力自检（含证据） | 已实现且已验证（见 docs/PROGRESS.md） |
| 需求追踪文件 | 已实现（本文件） |
| 空项目骨架 | 已实现且已验证 | 本地 5/6 脚本通过；E2E 待 CI |
| 构建/CI 配置 | 已实现（CI 运行待触发） |
| 真实可访问的最小 Pages 页面 | 被环境阻塞（等用户建仓库+设 Pages 发布源） |
