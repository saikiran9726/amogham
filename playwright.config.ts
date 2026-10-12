import { defineConfig, devices } from '@playwright/test';

const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 5173);
if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535) {
  throw new Error('PLAYWRIGHT_WEB_PORT must be an available TCP port between 1024 and 65535.');
}
const webHost = process.env.PLAYWRIGHT_WEB_HOST ?? '127.0.0.1';
if (!['127.0.0.1', 'localhost'].includes(webHost)) {
  throw new Error('PLAYWRIGHT_WEB_HOST must use a loopback address.');
}
const webUrl = `http://${webHost}:${webPort}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || webUrl,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `pnpm --filter @restaurant-os/web exec vite --host ${webHost} --port ${webPort}`,
    url: webUrl,
    reuseExistingServer: !process.env.CI && webPort === 5173,
    timeout: 60 * 1000,
  },
});
