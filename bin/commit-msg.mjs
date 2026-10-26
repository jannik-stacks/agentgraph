// Holds a commit message to the agentgraph example's pr-text and hygiene rules, as a push proposal. Usage: node bin/commit-msg.mjs <file>
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
const scripts = join(import.meta.dirname, '..', 'examples', 'agentgraph', 'scripts');
const env = { ...process.env, AGENTGRAPH_PROPOSALS: proposals, AGENTGRAPH_BASE: '' };
const failed = ['pr-text.mjs', 'hygiene.mjs'].filter(
  script => spawnSync('node', [join(scripts, script)], { env, stdio: 'inherit' }).status !== 0
);
process.exit(failed.length ? 1 : 0);
