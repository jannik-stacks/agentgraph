import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const smoke = resolve(import.meta.dirname, '../infra/local/sandbox/smoke.sh');
const image = 'bothub-sandbox:local';

const docker = (args: string[], input?: string) =>
  spawnSync('docker', args, { encoding: 'utf8', input, timeout: 120_000 });
const run = (tag: string) => spawnSync(smoke, [tag], { encoding: 'utf8', timeout: 120_000 });
const up = () => process.env.BOTHUB_E2E === '1' && docker(['image', 'inspect', image]).status === 0;

describe.skipIf(!up())('the sandbox image smoke test', () => {
  it('passes on the built image', () => {
    expect(run(image)).toMatchObject({ status: 0, stdout: 'sandbox smoke: ok\n' });
  });

  /** Runs the smoke test on the built image after `step` runs as root in it. */
  const broken = (step: string) => {
    const tag = 'bothub-sandbox:smoke-broken';
    expect(docker(['build', '-q', '-t', tag, '-'], `FROM ${image}\nUSER root\nRUN ${step}\nUSER node\n`).status).toBe(
      0
    );
    return run(tag);
  };

  it('fails when opencode writes to the read-only root', () => {
    const { status, stdout } = broken('rm /opt/opencode/.gitignore');
    expect(status).not.toBe(0);
    expect(stdout).toContain('/opt/opencode/.gitignore');
  });

  it('fails when a tool is missing', () => {
    expect(broken('rm /usr/bin/rg')).toMatchObject({ status: 1, stdout: 'missing tool: rg\n' });
  });
});
