import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmp, write } from './kit.ts';

const script = join(import.meta.dirname, '..', 'infra', 'local', 'keys.sh');
const master = 'FAKE-canary-master';

const logCall = `
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const header = args.flatMap((a, i) => (args[i - 1] === '-H' && a.startsWith('@') ? [readFileSync(a.slice(1), 'utf8')] : []));
const tool = require('node:path').basename(process.argv[1]);
const body = tool === 'curl' && !args.includes('/dev/null') ? readFileSync(0, 'utf8') : '';
appendFileSync(process.env.CALLS, JSON.stringify({ tool, args, env: process.env, header, body }) + '\\n');
`;

describe('keys.sh', () => {
  it('sends the master key as a header file and new keys on stdin, never in argv or a child env', () => {
    const dir = tmp('keys');
    const jq = execFileSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).trim();
    write(dir, {
      'litellm.env': `LITELLM_MASTER_KEY=${master}\nOPENROUTER_API_KEY=FAKE-canary-provider\n`,
      'bin/curl': `#!/usr/bin/env node
${logCall}
const url = args.find(a => a.startsWith('http')) ?? '';
console.log(url.includes('/key/list') ? '{"total_count":0}' : '{}');
`,
      'bin/dirname': `#!/usr/bin/env node
${logCall}
console.log(require('node:path').dirname(args[0]));
`,
      'bin/jq': `#!/usr/bin/env node
${logCall}
const r = require('node:child_process').spawnSync(${JSON.stringify(jq)}, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`,
    });
    for (const tool of ['curl', 'jq', 'dirname']) chmodSync(join(dir, 'bin', tool), 0o755);
    const calls = join(dir, 'calls.jsonl');
    const out = execFileSync('bash', [script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        NODE_OPTIONS: '',
        CALLS: calls,
        ENV_FILE: join(dir, 'litellm.env'),
        KEYS_FILE: join(dir, 'keys.env'),
        LITELLM_MASTER_KEY: master,
      },
    });
    const logged = readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { tool: string; args: string[]; env: object; header: string[]; body: string });
    const created = readFileSync(join(dir, 'keys.env'), 'utf8').match(/sk-bh-[\w-]+/g)!;
    const sent = logged.flatMap(c => (c.args.some(a => a.endsWith('/key/generate')) ? [JSON.parse(c.body).key] : []));

    expect(out).toContain('created bh-implementor');
    expect(created.length).toBeGreaterThan(5);
    expect(sent).toEqual(created);
    expect(logged.some(c => c.tool === 'dirname')).toBe(true);
    expect(
      logged
        .filter(c => c.tool === 'curl')
        .every(c => c.header.join('').includes(`Bearer ${master}`) || c.args.includes('/dev/null'))
    ).toBe(true);
    for (const call of logged) {
      const seen = JSON.stringify([call.args, call.env]);
      expect(seen).not.toContain('FAKE-canary');
      for (const key of created) expect(seen).not.toContain(key);
    }
  }, 30_000);
});
