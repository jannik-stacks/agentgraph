import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hubProposal } from '../src/hub-proposal.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'bothub-hub-proposal-'));

const minimalHub = () => {
  const dir = temp();
  mkdirSync(join(dir, 'skills'));
  writeFileSync(join(dir, 'skills', 'triage.md'), '---\ndescription: Triage.\n---\nRead the issue.\n');
  return dir;
};

describe('hubProposal', () => {
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

  it('lands a bot hub change on its own branch, leaving the working tree and HEAD alone', async () => {
    const dir = minimalHub();
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.name', 'test');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'skills', 'old.md'), '---\ndescription: Old.\n---\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    const head = git(dir, 'rev-parse', 'HEAD');
    const note = '---\ntitle: Fees retry once\nstatus: proposed\n---\n\nA rejected fee retries once.\n';
    const branch = await hubProposal(dir)({
      title: 'note: Fees retry once',
      body: 'From a run.',
      files: [
        { path: 'notes/caveat/fee-retry.md', content: note },
        { path: 'skills/old.md', content: null },
      ],
    });
    expect(branch).toMatch(/^bothub\/hub\/note-fees-retry-once-[0-9a-f]{7}$/);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(dir, 'notes'))).toBe(false);
    expect(git(dir, 'show', `${branch}:notes/caveat/fee-retry.md`)).toBe(note.trimEnd());
    expect(git(dir, 'diff', '--name-status', head, branch!).split('\n')).toEqual([
      'A\tnotes/caveat/fee-retry.md',
      'D\tskills/old.md',
    ]);
    expect(git(dir, 'log', '-1', '--format=%an%n%B', branch!)).toBe(
      'bothub[bot]\nnote: Fees retry once\n\nFrom a run.'
    );

    await expect(
      hubProposal(dir)({ title: 'bad', body: '', files: [{ path: 'notes/caveat/x.md', content: '---\n---\n' }] })
    ).rejects.toThrow(/leaves the hub invalid/);
    const nested = join(temp(), 'hub');
    mkdirSync(nested);
    git(join(nested, '..'), 'init', '-q');
    expect(await hubProposal(nested)({ title: 't', body: '', files: [] })).toBeUndefined();
    expect(await hubProposal(minimalHub())({ title: 't', body: '', files: [] })).toBeUndefined();
  });

  it('refuses a change that leaves a local issue invalid', async () => {
    const dir = minimalHub();
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.name', 'test');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    await expect(
      hubProposal(dir)({ title: 'bad', body: '', files: [{ path: 'issues/x.md', content: '---\ntitle: x\n---\n' }] })
    ).rejects.toThrow(/issues\/x\.md: .*named <number>-<slug>\.md/);
  });
});
