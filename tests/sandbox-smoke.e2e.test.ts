import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const smoke = resolve(import.meta.dirname, '../infra/local/sandbox/smoke.sh');
const image = 'agentgraph-sandbox:local';

const docker = (args: string[], input?: string) =>
  spawnSync('docker', args, { encoding: 'utf8', input, timeout: 120_000 });
const run = (tag: string) => spawnSync(smoke, [tag], { encoding: 'utf8', timeout: 120_000 });
const up = () => process.env.AGENTGRAPH_E2E === '1' && docker(['image', 'inspect', image]).status === 0;

describe.skipIf(!up())('the sandbox image smoke test', () => {
  it('passes on the built image', () => {
    expect(run(image)).toMatchObject({ status: 0, stdout: 'sandbox smoke: ok\n' });
  });

  /** Runs the smoke test on the built image after `step` runs as root in it. */
  const broken = (step: string) => {
    const tag = 'agentgraph-sandbox:smoke-broken';
    expect(docker(['build', '-q', '-t', tag, '-'], `FROM ${image}\nUSER root\nRUN ${step}\nUSER node\n`).status).toBe(
      0
    );
    return run(tag);
  };

  it('fails when the plugin install the run home links to is missing', () => {
    expect(broken('rm /opt/opencode/package-lock.json')).toMatchObject({
      status: 1,
      stdout: 'missing /opt/opencode/package-lock.json\n',
    });
  });

  it('fails when a tool is missing', () => {
    expect(broken('rm /usr/bin/rg')).toMatchObject({ status: 1, stdout: 'missing tool: rg\n' });
  });
});
