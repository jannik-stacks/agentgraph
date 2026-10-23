import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { alive } from '../bin/resume.ts';
import { tmp } from './kit.ts';

const script = resolve(import.meta.dirname, '../bin/overnight.sh');
const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL');
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const until = async (ok: () => boolean) => {
  for (let n = 0; n < 200 && !ok(); n++) await new Promise(r => setTimeout(r, 50));
  expect(ok()).toBe(true);
};

/** macOS sh is bash; dash, the Linux sh, needs setsid, which macOS lacks and a perl shim stands in for. */
const shells = [
  ['sh', false] as const,
  ...(process.platform === 'darwin' && existsSync('/bin/dash') ? [['dash', true] as const] : []),
];

it.each(shells)('on SIGTERM stops everything the running line started, in %s', async (shell, shim) => {
  const dir = tmp('overnight');
  dirs.push(dir);
  const pidFile = join(dir, 'sleep.pid');
  writeFileSync(join(dir, 'queue.txt'), `sh -c 'sleep 300 & echo $! > ${pidFile}; wait; true'; true\n`);
  if (shim) {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/setsid'), '#!/usr/bin/perl\nsetpgrp(0, 0);\nexec @ARGV;\n', { mode: 0o755 });
  }
  const path = shim ? `${join(dir, 'bin')}:${process.env.PATH}` : process.env.PATH;
  const queue = spawn(shell, [script, join(dir, 'queue.txt')], {
    stdio: 'ignore',
    env: { ...process.env, PATH: path },
  });
  pids.push(queue.pid!);
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  pids.push(pid);
  queue.kill('SIGTERM');
  await until(() => !alive(pid));
});

it('records a line that passes as done and one that fails three times as failed', async () => {
  const dir = tmp('overnight');
  dirs.push(dir);
  const queue = join(dir, 'queue.txt');
  writeFileSync(queue, 'echo hi\nexit 3\n');
  const run = spawn('sh', [script, queue], { stdio: 'ignore', env: { ...process.env, OVERNIGHT_BACKOFF: '0' } });
  expect(await new Promise(done => run.on('close', done))).toBe(0);
  expect(readFileSync(`${queue}.done`, 'utf8')).toBe('echo hi\n');
  expect(readFileSync(`${queue}.failed`, 'utf8')).toBe('exit 3\n');
  expect(readFileSync(`${queue}.log`, 'utf8')).toMatch(/hi\n[\s\S]*exit 3: exit 3\n[\s\S]*1 failed/);
});
