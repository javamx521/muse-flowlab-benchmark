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

## M2 完整编辑与执行（未开始）
## M3 数据可靠性（未开始）
## M4 深层工程能力（未开始）
## M5 完整产品体验（未开始）
## M6 最终交付（未开始）
