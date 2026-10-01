import { defineConfig, devices } from '@playwright/test'

// FULL_BROWSERS=1 时加跑 Firefox 与 WebKit 的核心烟雾流程(见 e2e 工作流)。
const extraBrowsers = process.env.FULL_BROWSERS === '1' ? [
  { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  { name: 'webkit', use: { ...devices['Desktop Safari'] } },
] : []

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173/muse-flowlab-benchmark/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // --host 127.0.0.1: 显式绑定 IPv4, 避免某些环境 localhost 只解析到 ::1 导致 127.0.0.1 连不上
    command: 'npm run preview -- --port 4173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4173/muse-flowlab-benchmark/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...extraBrowsers,
  ],
})
