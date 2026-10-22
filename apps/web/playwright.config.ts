import { defineConfig } from '@playwright/test';

// Another local dev server may already hold 5173; reuseExistingServer would then test it.
const port = Number(process.env['WEB_E2E_PORT'] ?? 5173);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL,
    // Installed Chrome locally; CI installs Playwright's Chromium.
    channel: process.env['CI'] ? undefined : 'chrome',
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 20_000,
  },
});
