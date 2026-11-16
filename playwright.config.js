import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against the built web app served by the API (`npm run build` first;
// `npm run test:e2e` does both). The "slow-network" project throttles to 256 kbps / 300 ms.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: {
    // PW_CHANNEL=chrome (or msedge) uses an installed browser instead of Playwright's Chromium download.
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
    baseURL: 'http://localhost:4100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } },
      grepInvert: /@slow-network|@phone/,
    },
    { name: 'phone', use: { ...devices['Pixel 7'] }, grep: /@phone/ },
    { name: 'slow-network', use: { ...devices['Desktop Chrome'] }, grep: /@slow-network/ },
  ],
  webServer: {
    command: 'node scripts/e2e-server.js',
    url: 'http://localhost:4100/ready',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
