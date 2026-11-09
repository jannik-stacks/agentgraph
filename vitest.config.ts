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
  'tests/base-moved-rebase.test.ts',
  'tests/base-moved-checks.test.ts',
  'tests/bench-graph-size.test.ts',
  'tests/bench-start-runs.test.ts',
  'tests/bench.test.ts',
  'tests/branch-moved-recovery.test.ts',
  'tests/branch-moved-proposals.test.ts',
  'tests/check-gate.test.ts',
  'tests/cleanup.test.ts',
  'tests/cli.test.ts',
  'tests/commands.test.ts',
  'tests/coworker-stacks.test.ts',
  'tests/coworker-collaboration.test.ts',
  'tests/default-base.test.ts',
  'tests/diagrams.test.ts',
  'tests/disk.test.ts',
  'tests/docker-client.test.ts',
  'tests/docker-cache.test.ts',
  'tests/doubles.test.ts',
  'tests/drive-durable.test.ts',
  'tests/drive.test.ts',
  'tests/end-checks.test.ts',
  'tests/example-checks.test.ts',
  'tests/file-cli.test.ts',
  'tests/files.test.ts',
  'tests/flatten.test.ts',
  'tests/folder.test.ts',
  'tests/github.test.ts',
  'tests/harnesses.test.ts',
  'tests/host-env.test.ts',
  'tests/import.test.ts',
  'tests/instance-setup.test.ts',
  'tests/install-scripts.test.ts',
  'tests/instance.test.ts',
  'tests/keychain-scripts.test.ts',
  'tests/keys-script.test.ts',
  'tests/labels.test.ts',
  'tests/leak-probe.test.ts',
  'tests/loop-drives.test.ts',
  'tests/loop-lifecycle.test.ts',
  'tests/lsp.test.ts',
  'tests/migrate.test.ts',
  'tests/note-pairs.test.ts',
  'tests/overnight.test.ts',
  'tests/owner.test.ts',
  'tests/parked-runs.test.ts',
  'tests/plugins.test.ts',
  'tests/pr-text.test.ts',
  'tests/precommit.test.ts',
  'tests/propagation.test.ts',
  'tests/propose.test.ts',
  'tests/provider-guidance.test.ts',
  'tests/readonly.e2e.test.ts',
  'tests/record-root.test.ts',
  'tests/remote.test.ts',
  'tests/result.test.ts',
  'tests/results.test.ts',
  'tests/restart-fresh.test.ts',
  'tests/resume.test.ts',
  'tests/retro-gate.test.ts',
  'tests/run.test.ts',
  'tests/sandbox-smoke.e2e.test.ts',
  'tests/sessions.test.ts',
  'tests/sized.test.ts',
  'tests/skill.test.ts',
  'tests/studio-controls.e2e.test.ts',
  'tests/studio-instances.test.ts',
  'tests/studio-pages.test.ts',
  'tests/studio-watch.test.ts',
  'tests/style.test.ts',
  'tests/test-processes.test.ts',
  'tests/tick-dispatch.test.ts',
  'tests/tick-asides.test.ts',
  'tests/tick-loop.test.ts',
  'tests/tool-run.test.ts',
  'tests/traces.test.ts',
  'tests/tracker-cli-verbs.test.ts',
  'tests/tracker-cli-instance.test.ts',
  'tests/transitions.test.ts',
  'tests/triage.test.ts',
  'tests/tune.test.ts',
  'tests/user-repo.test.ts',
];

export default defineConfig({
  plugins: [
    {
      name: 'studio-page-manifest-tests',
      resolveId: id => (id === 'virtual:agentgraph-pages' || id === 'virtual:served' ? `\0${id}` : undefined),
      load: id =>
        id === '\0virtual:agentgraph-pages'
          ? 'export const pages = [{ name: "count", title: "Count", href: "/plugins/count", load: async () => ({ default: () => null }) }];'
          : id === '\0virtual:served'
            ? 'export const served = globalThis.studioServed ?? [];'
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
      {
        extends: true,
        test: { name: 'tools', include: toolTests, testTimeout: toolTestTimeout, hookTimeout: toolTestTimeout },
      },
    ],
  },
});
