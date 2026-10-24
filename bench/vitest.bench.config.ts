import { defineConfig } from 'vitest/config';

// Engine benchmark (not a test suite): npm run bench:engine
export default defineConfig({
  test: {
    include: ['bench/engine.bench.ts'],
    environment: 'jsdom',
    testTimeout: 300_000,
  },
});
