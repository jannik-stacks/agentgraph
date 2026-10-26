// Runs the graph's script checks that finish in seconds, each with its own command, so a bot sees their findings
// before it finishes. Prints every finding and fails when a check in block mode has one.
//
//   AGENTGRAPH_DIR=/graph AGENTGRAPH_BASE=<sha> node /graph/scripts/fast.mjs [check...]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const fast = ['safety', 'hygiene', 'size', 'rules', 'lint', 'types', 'code-shape', 'unused-exports', 'propagation', 'enum-copy', 'docs-sync', 'test-guards'];

if (import.meta.url === `file://${process.argv[1]}`) {
  const graph = process.env.AGENTGRAPH_DIR ?? join(import.meta.dirname, '..');
  const args = process.argv.slice(2);
  for (const name of args.length ? args : fast) {
    const text = readFileSync(join(graph, 'checks', `${name}.md`), 'utf8');
    const field = key => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text)?.[1];
    const env = { ...process.env, AGENTGRAPH_DIR: graph };
    const { status, stdout, stderr } = spawnSync('sh', ['-c', field('run')], { encoding: 'utf8', env });
    const out = `${stdout}${stderr}`.trim();
    if (out) console.log(out);
    if (status === 0) continue;
    console.log(`${name}: the findings above are ${field('mode') ?? 'log'}`);
    if (field('mode') === 'block') process.exitCode = 1;
  }
}
