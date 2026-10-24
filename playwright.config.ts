import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  outputDir: 'test-results/e2e',
  use: {
    baseURL: 'http://127.0.0.1:4179',
    viewport: { width: 960, height: 760 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(process.env['DSH_E2E_BROWSER_CHANNEL'] ? { channel: process.env['DSH_E2E_BROWSER_CHANNEL'] } : {}),
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --config tests/e2e/vite.config.ts',
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: false,
  },
})
