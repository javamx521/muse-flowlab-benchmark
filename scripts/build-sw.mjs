// 构建 Service Worker：node scripts/build-sw.mjs
import { build } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  configFile: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/sw.ts',
      name: 'flowlabSW',
      formats: ['iife'],
      fileName: () => 'sw.js',
    },
    minify: true,
  },
  define: {
    __FLOWLAB_SW_VERSION__: JSON.stringify(pkg.version ?? '0.1.0'),
  },
});
console.log('sw.js built');
