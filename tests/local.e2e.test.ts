import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { localIssues } from '../src/issues-local.ts';
import type { JobResult } from '../src/pipeline.ts';
import { runScript } from '../src/runner.ts';
import { serveHub } from '../src/serve.ts';
import { commit, git, temp } from './git.ts';

const up = async () => {
  if (process.env.BOTHUB_E2E !== '1') return false;
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
    return (await fetch('http://127.0.0.1:4000/health/liveliness', { signal: AbortSignal.timeout(5000) })).ok;
  } catch {
    return false;
  }
};

const keys = () =>
  parseEnv(readFileSync(new URL('../infra/local/.keys.env', import.meta.url), 'utf8')) as Record<string, string>;

const hubFiles: Record<string, string> = {
  'hub.yaml': 'issues: local\n',
  'bots/triager.md':
    '---\nharness: opencode\nmodel: smart\ntools: [read, grep, glob]\nreturns: [reply]\nskills: [answer]\n---\nYou answer questions about this repository.\n',
  'skills/answer.md':
    '---\ndescription: Answer the question from the code.\n---\nRead the code, then reply with the answer in one sentence.\n',
  'workflows/issue.md': [
    '---',
    'name: issue',
    'on:',
    '  issue_comment:',
    '    types: [created]',
    '    command: /bothub',
    '    guard: { associations: [OWNER] }',
    'jobs:',
    '  answer:',
    '    bot: triager',
    '    skill: answer',
    '    returns: [reply]',
    '    mode: warn',
    '    preload: [issue]',
    '    timeout-minutes: 5',
    '---',
    'Answers.',
    '',
  ].join('\n'),
  'scripts/marker.sh': 'cat "$BOTHUB_HUB/hub.yaml"\ntest -f src/rates.ts\n',
  'issues/1-rate.md':
    '---\ntitle: Which rate?\nauthor: morgan\n---\n\nWhat number does `rate` in src/rates.ts return?\n',
};

const fixture = () => {
  const dir = temp('e2e-repo');
  git(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'src'));
  commit(dir, { 'README.md': 'Rates.\n', 'src/rates.ts': 'export const rate = () => 4217;\n' });
  const origin = join(temp('e2e-origin'), 'app.git');
  git(dir, 'clone', '-q', '--bare', dir, origin);
  return { dir, origin };
};

const hub = () => {
  const dir = temp('e2e-hub');
  for (const [path, text] of Object.entries(hubFiles)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};

describe.skipIf(!(await up()))('local strategy against docker and the model proxy', () => {
  it('runs a hub script in the sandbox with the hub mounted read-only', { timeout: 120_000 }, async () => {
    const { dir } = fixture();
    const ok = await runScript('sh "$BOTHUB_HUB/scripts/marker.sh"', dir, 2, {}, undefined, { hub: hub() });
    expect(ok).toMatchObject({ ok: true });
    expect(ok.output).toContain('issues: local');
    const denied = await runScript('touch "$BOTHUB_HUB/written"', dir, 2, {}, undefined, { hub: hub() });
    expect(denied.ok).toBe(false);
  });

  it('answers an issue comment with a real opencode run in the sandbox', { timeout: 600_000 }, async () => {
    const dir = hub();
    const { origin } = fixture();
    const done: JobResult[][] = [];
    const served = await serveHub({
      hub: dir,
      data: temp('e2e-data'),
      origin,
      repo: 'acme/rates',
      env: keys(),
      port: 0,
      interval: 200,
      log: () => {},
      onResults: (_, results) => done.push(results),
    });
    try {
      await localIssues(join(dir, 'issues'), { repo: 'acme/rates', as: 'morgan' }).comment(1, '/bothub');
      while (!done.length) await new Promise(r => setTimeout(r, 500));
      const [result] = done.flat();
      expect(result && 'run' in result && result.run.status).toBe('succeeded');
      const issue = await localIssues(join(dir, 'issues'), { repo: 'acme/rates' }).get(1);
      const reply = issue?.comments.find(c => c.author === 'bothub[bot]');
      expect(reply?.body).toContain('4217');
    } finally {
      await served.stop();
    }
  });
});
