import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'core/**/*.test.ts'],
    globalSetup: ['tests/setup/global.ts'],
    setupFiles: ['tests/setup/processes.ts'],
    coverage: {
      provider: 'v8',
      include: ['core/src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 90 },
    },
  },
});
