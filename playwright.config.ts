import { defineConfig } from '@playwright/test';

// End-to-end tests load the built extension (dist/) into Chromium.
// Run `npm run build` first, or use `npm run test:e2e`.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
});
