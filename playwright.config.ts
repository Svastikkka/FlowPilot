import { defineConfig } from '@playwright/test';

// End-to-end tests load the built extension (dist/) into Chromium.
// Run `npm run build` first, or use `npm run test:e2e`.
const ci = !!process.env.CI;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  workers: 1,
  // One retry on CI absorbs runner hiccups; failures still show up as "flaky".
  retries: ci ? 1 : 0,
  forbidOnly: ci,
  reporter: ci ? [['github'], ['list'], ['html', { open: 'never' }]] : [['list']],
  use: { trace: ci ? 'retain-on-failure' : 'off' },
});
