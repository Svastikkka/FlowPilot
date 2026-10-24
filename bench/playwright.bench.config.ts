import { defineConfig } from '@playwright/test';

// Browser benchmark (not a test suite): npm run bench:browser
export default defineConfig({
  testDir: '.',
  testMatch: 'browser.bench.ts',
  timeout: 30 * 60_000,
  workers: 1,
  reporter: [['list']],
});
