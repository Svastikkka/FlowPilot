import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const root = import.meta.dirname;

// Content scripts injected with chrome.scripting.executeScript({ files }) must
// be classic scripts without imports, so this entry is bundled as one IIFE.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome110',
    lib: {
      entry: resolve(root, 'src/content/index.ts'),
      formats: ['iife'],
      name: 'FlowPilotContent',
      fileName: () => 'content.js',
    },
  },
});
