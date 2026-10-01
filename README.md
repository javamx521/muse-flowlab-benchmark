# FlowLab Studio

浏览器端可视化数据工作流 IDE：导入 CSV/JSON，在画布中连接处理节点，执行数据处理，查看中间结果，定位错误，保存工作流，导出工程。纯静态前端，计算全部在浏览器端完成。

线上地址：https://javamx521.github.io/muse-flowlab-benchmark/

## 快速开始

```sh
npm ci
npm run dev      # 本地开发
npm run build    # 生产构建 → dist/
npm run preview  # 本地预览生产构建
```

## 质量门禁（名称固定，见任务书 §5）

```sh
npm ci
npm run lint
npm run typecheck
npm run test:unit
npm run test:e2e
npm run build
```

- `test:e2e` 默认跑 Chromium；`FULL_BROWSERS=1 npm run test:e2e` 加跑 Firefox/WebKit 烟雾。
- CI（`.github/workflows/ci.yml`）在每次 push/PR 执行全部六项；`deploy.yml` 在 main 分支先验证再发布到 Pages。

## 技术结构

- React 18 + TypeScript 严格模式 + Vite 6
- Hash 路由（`react-router-dom` HashRouter），适配 GitHub Pages 子路径
- 状态/持久化：M0 为 localStorage（`flowlab.studio.v1.*` 命名空间）；M3 迁移到 IndexedDB
- 样式：手写 CSS，明暗主题；系统字体栈，不依赖外部 CDN

## 持久化与隐私边界

- 项目数据默认只保存在当前浏览器（localStorage，M3 起 IndexedDB）。
- 页面页脚明确提示：清除网站数据可能丢失本地内容。
- 不实现真实登录、云同步、多人协作；不收集、不上传用户数据。
- 公开仓库只包含代码、文档与合成数据，不含密钥与隐私数据。

## 支持范围

- 桌面端完整编辑器（M2 起）；手机端支持查看、运行示例、阅读日志、导出。
- 默认简体中文；明暗主题可切换。

## 备份 / 导入

- M0：项目元数据保存在浏览器本地。
- M3 起：支持 JSON 工程导入导出、命名快照、旧版本迁移。

## 文档

- `docs/PROGRESS.md` — 每阶段进度、测试结果、阻塞与下一步
- `docs/DECISIONS.md` — 架构决策记录
- `docs/REQUIREMENTS.md` — 需求 → 实现 → 测试追踪表
