import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // 核心逻辑库: 引擎 + 存储。UI 组件覆盖由 E2E 承担(见 docs/REQUIREMENTS.md)。
      // worker.ts 是浏览器 Worker 入口, 由 E2E 覆盖, 不计入单元覆盖率。
      include: ['src/engine/**/*.ts', 'src/store/**/*.ts', 'src/lib/**/*.ts'],
      exclude: [
        // 浏览器 Worker 入口与后端：无 DOM/Worker 的 node 环境无法执行，由 E2E 真实覆盖
        'src/engine/worker.ts',
        'src/engine/workerBackend.ts',
        // React hook：由 E2E 覆盖交互；node 环境无渲染器
        'src/store/useEditor.ts',
        // IndexedDB 与应用单例：node 环境无 indexedDB，由 E2E 在真实浏览器覆盖；
        // 并发语义由 MemoryBackend 的单元测试覆盖（同一接口）
        'src/store/indexedDb.ts',
        'src/store/appStores.ts',
        '**/*.test.ts',
      ],
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
      },
      reporter: ['text', 'html'],
    },
  },
})
