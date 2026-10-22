import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup/global.ts'],
    setupFiles: ['tests/setup/processes.ts'],
    env: { BOTHUB_CACHE_VOLUME: '', BOTHUB_MIN_FREE_GB: '0' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 90 },
    },
  },
});
