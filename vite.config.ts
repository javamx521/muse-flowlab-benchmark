import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages 子路径部署: 仓库名为 muse-flowlab-benchmark 时,
// 生产地址为 https://javamx521.github.io/muse-flowlab-benchmark/
// base 必须与该子路径一致, 否则静态资源 404。见 docs/DECISIONS.md D-002。
export default defineConfig({
  plugins: [react()],
  base: '/muse-flowlab-benchmark/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  define: {
    __FLOWLAB_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.1.0'),
    __FLOWLAB_GIT_SHA__: JSON.stringify(process.env.VITE_GIT_SHA ?? 'dev'),
    __FLOWLAB_BUILD_TIME__: JSON.stringify(
      process.env.VITE_BUILD_TIME ?? new Date().toISOString(),
    ),
  },
})
