import { defineConfig } from '@playwright/test';

// Generates Chrome Web Store assets (not a test suite). Run: npm run store:assets
export default defineConfig({
  testDir: 'capture',
  timeout: 240_000,
  workers: 1,
  reporter: [['list']],
});
