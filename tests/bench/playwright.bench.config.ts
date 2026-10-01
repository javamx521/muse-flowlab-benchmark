import { defineConfig, devices } from '@playwright/test';

// 性能基准专用配置：只跑 tests/bench，不过 CI 质量门禁（只记录结果）。
// 运行：npm run bench
export default defineConfig({
  testDir: '.',
  testMatch: '*.bench.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  timeout: 900_000,
  use: {
    baseURL: 'http://127.0.0.1:4173/muse-flowlab-benchmark/',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4173/muse-flowlab-benchmark/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...(process.env.FULL_BROWSERS === '1'
      ? [
          { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
          { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        ]
      : []),
  ],
});
