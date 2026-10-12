import { defineConfig } from 'vitest/config';

const local = [
  'src/sandbox.ts',
  'src/runner.ts',
  'src/serve.ts',
  'src/pipeline.ts',
  'src/apply.ts',
  'src/issues-local.ts',
  'src/harnesses/opencode.ts',
  'src/store.ts',
];

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup/global.ts'],
    setupFiles: ['tests/setup/processes.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Loaded only inside child processes (the sim harness and the pi extension), where v8 coverage cannot follow.
      exclude: ['src/sim-harness.ts', 'src/harnesses/pi-provider.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 90,
        ...Object.fromEntries(local.map(file => [file, { lines: 90 }])),
      },
    },
  },
});
