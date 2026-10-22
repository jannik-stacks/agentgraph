// Runs the hub's script checks that finish in seconds, each with its own command, so a bot sees their findings
// before it finishes. Prints every finding and fails when a check in block mode has one.
//
//   AGENTGRAPH_HUB=/hub AGENTGRAPH_BASE=<sha> node /hub/scripts/fast.mjs [check...]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const fast = ['safety', 'size', 'rules', 'lint', 'types', 'code-shape', 'unused-exports', 'propagation', 'enum-copy', 'docs-sync', 'test-guards'];

if (import.meta.url === `file://${process.argv[1]}`) {
  const hub = process.env.AGENTGRAPH_HUB ?? join(import.meta.dirname, '..');
  const args = process.argv.slice(2);
  for (const name of args.length ? args : fast) {
    const text = readFileSync(join(hub, 'checks', `${name}.md`), 'utf8');
    const field = key => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text)?.[1];
    const env = { ...process.env, AGENTGRAPH_HUB: hub };
    const { status, stdout, stderr } = spawnSync('sh', ['-c', field('run')], { encoding: 'utf8', env });
    const out = `${stdout}${stderr}`.trim();
    if (out) console.log(out);
    if (status === 0) continue;
    console.log(`${name}: the findings above are ${field('mode') ?? 'log'}`);
    if (field('mode') === 'block') process.exitCode = 1;
  }
}
