import { execFileSync } from 'node:child_process';
import { configDefaults, defineConfig } from 'vitest/config';

for (const name of ['BASE', 'DIR', 'ISSUE', 'PROPOSALS', 'CONTEXT', 'REPLY', 'TRACES', 'RUN_TRACE', 'ITEM'])
  delete process.env[`AGENTGRAPH_${name}`];
for (const name of execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).split('\n'))
  if (name) delete process.env[name];

const toolTestTimeout = 120_000;
const toolTests = [
  'tests/agentgraph-example.test.ts',
  'tests/agentgraph-ui-checks.test.ts',
  'tests/base-moved.test.ts',
  'tests/bench.test.ts',
  'tests/branch-moved.test.ts',
  'tests/check-gate.test.ts',
  'tests/commands.test.ts',
  'tests/coworker.test.ts',
  'tests/default-base.test.ts',
  'tests/docker.test.ts',
  'tests/doubles.test.ts',
  'tests/drive-durable.test.ts',
  'tests/end-checks.test.ts',
  'tests/example-checks.test.ts',
  'tests/folder.test.ts',
  'tests/github.test.ts',
  'tests/host-env.test.ts',
  'tests/keys-script.test.ts',
  'tests/lsp.test.ts',
  'tests/note-pairs.test.ts',
  'tests/parked-runs.test.ts',
  'tests/precommit.test.ts',
  'tests/propagation.test.ts',
  'tests/provider-guidance.test.ts',
  'tests/record-root.test.ts',
  'tests/remote.test.ts',
  'tests/result.test.ts',
  'tests/results.test.ts',
  'tests/retro-gate.test.ts',
  'tests/run.test.ts',
  'tests/sessions.test.ts',
  'tests/skill.test.ts',
  'tests/style.test.ts',
  'tests/tick.test.ts',
  'tests/tool-run.test.ts',
  'tests/traces.test.ts',
  'tests/tracker-cli.test.ts',
  'tests/transitions.test.ts',
  'tests/triage.test.ts',
  'tests/tune.test.ts',
  'tests/user-repo.test.ts',
];

export default defineConfig({
  plugins: [
    {
      name: 'studio-page-manifest-tests',
      resolveId: id => (id === 'virtual:agentgraph-pages' ? '\0virtual:agentgraph-pages' : undefined),
      load: id =>
        id === '\0virtual:agentgraph-pages'
          ? 'export const pages = [{ name: "count", title: "Count", href: "/plugins/count", load: async () => ({ default: () => null }) }];'
          : undefined,
    },
  ],
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
