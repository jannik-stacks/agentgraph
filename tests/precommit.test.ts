import { spawnSync } from 'node:child_process';
import { cpSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commit, git, temp, write } from './kit.ts';

const root = resolve(import.meta.dirname, '..');

/** A repository holding the precommit script and the bothub hub, with `files` committed and `after` written on top. */
const repo = (files: Record<string, string>, after: Record<string, string>) => {
  const dir = temp('precommit');
  for (const path of ['bin/precommit.sh', 'examples/bothub/checks', 'examples/bothub/scripts'])
    cpSync(join(root, path), join(dir, path), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  commit(dir, files);
  write(dir, after);
  return dir;
};
const precommit = (dir: string) =>
  spawnSync('sh', [join(dir, 'bin/precommit.sh'), 'rules', 'propagation'], {
    encoding: 'utf8',
    env: { ...process.env, BOTHUB_BASE: '' },
  });

describe('precommit', () => {
  it('fails on a finding of a block check', () => {
    const { status, stdout } = precommit(repo({ 'src/a.ts': '' }, { 'src/a.ts': '// TODO finish\n' }));
    expect(status).toBe(1);
    expect(stdout).toContain('src/a.ts:1: a marker for later; finish it or open an issue');
    expect(stdout).toContain('rules: the findings above are block');
  });

  it('prints the findings of a warn check and passes', () => {
    const before = { 'src/a.ts': "export const mode = 'fastPath';\n", 'examples/hub/skill.md': 'Use `fastPath`.\n' };
    const { status, stdout } = precommit(repo(before, { 'src/a.ts': "export const mode = 'quickPath';\n" }));
    expect(status).toBe(0);
    expect(stdout).toContain(
      'fastPath: the change takes it out of src/a.ts, but examples/hub/skill.md:1 still says it\npropagation: 1 finding\npropagation: the findings above are warn'
    );
  });
});

describe('commit-msg', () => {
  const message = (text: string) => {
    const file = join(temp('commit-msg'), 'COMMIT_EDITMSG');
    writeFileSync(file, text);
    return spawnSync('node', [join(root, 'bin/commit-msg.mjs'), file], { encoding: 'utf8' });
  };

  it('fails a loose subject and a long body, one line each', () => {
    const { status, stdout } = message('Fixed things\n\na\nb\nc\nd\n');
    expect(status).toBe(1);
    expect(stdout.trim().split('\n')).toEqual([
      'commit subject is not a conventional commit: "Fixed things"',
      'commit body is 4 lines, over 3',
    ]);
  });

  it('passes a conventional subject with a short why, ignoring git comment lines', () => {
    const { status } = message(
      'fix(engine): keep the lock\n\nA crash left it held.\n# Please enter the commit message\n'
    );
    expect(status).toBe(0);
  });
});
