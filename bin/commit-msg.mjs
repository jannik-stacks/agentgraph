// Holds a commit message to the agentgraph hub's pr-text rules, as a push proposal. Usage: node bin/commit-msg.mjs <file>
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const message = readFileSync(process.argv[2], 'utf8')
  .split('\n')
  .filter(line => !line.startsWith('#'))
  .join('\n')
  .trim();
const proposals = join(mkdtempSync(join(tmpdir(), 'agentgraph-msg-')), 'proposals.json');
writeFileSync(proposals, JSON.stringify([{ kind: 'push', branch: 'HEAD', message }]));
const script = join(import.meta.dirname, '..', 'examples', 'agentgraph', 'scripts', 'pr-text.mjs');
const { status } = spawnSync('node', [script], {
  env: { ...process.env, AGENTGRAPH_PROPOSALS: proposals },
  stdio: 'inherit',
});
process.exit(status ?? 1);
