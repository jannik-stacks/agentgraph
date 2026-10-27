import { configDefaults, defineConfig } from 'vitest/config';

const toolTestTimeout = 60_000;
const toolTests = [
  'tests/agentgraph-example.test.ts',
  'tests/agentgraph-ui-checks.test.ts',
  'tests/base-moved.test.ts',
  'tests/bench.test.ts',
  'tests/branch-moved.test.ts',
  'tests/coworker.test.ts',
  'tests/docker.test.ts',
  'tests/doubles.test.ts',
  'tests/drive-durable.test.ts',
  'tests/forge-cli.test.ts',
  'tests/github.test.ts',
  'tests/example-checks.test.ts',
  'tests/folder.test.ts',
  'tests/precommit.test.ts',
  'tests/remote.test.ts',
  'tests/run.test.ts',
  'tests/skill.test.ts',
  'tests/tick.test.ts',
  'tests/triage.test.ts',
  'tests/tune.test.ts',
  'tests/user-repo.test.ts',
];

export default defineConfig({
  test: {
    globalSetup: ['tests/setup/global.ts'],
    setupFiles: ['tests/setup/processes.ts'],
    env: { AGENTGRAPH_CACHE_VOLUME: '', AGENTGRAPH_MIN_FREE_GB: '0' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'harnesses/*.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 90 },
    },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['tests/**/*.test.ts'], exclude: [...configDefaults.exclude, ...toolTests] },
      },
      { extends: true, test: { name: 'tools', include: toolTests, testTimeout: toolTestTimeout } },
    ],
  },
});
