import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodePath, runLogged } from '../bench/drive.ts';
import { tmp } from './fixtures.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('bench driver', () => {
  it('finds node on PATH at each spawn', () => {
    const node = nodePath();
    expect(node.startsWith('/')).toBe(true);
    expect(existsSync(node)).toBe(true);
  });

  it('logs a job to its file and returns its exit code', async () => {
    const dir = tmp('drive');
    dirs.push(dir);
    const script = join(dir, 'job.mjs');
    writeFileSync(script, "console.log('out'); console.error('err'); process.exit(3);");
    const log = join(dir, 'job.log');
    expect(await runLogged([script, 'score', 'case'], log, process.env)).toBe(3);
    expect(readFileSync(log, 'utf8')).toMatch(/### .* score case\nout\nerr\n|### .* score case\nerr\nout\n/);
  });

  it('survives a log file it cannot write', async () => {
    const dir = tmp('drive');
    dirs.push(dir);
    const script = join(dir, 'job.mjs');
    writeFileSync(script, 'process.exit(0);');
    const said: string[] = [];
    const code = await runLogged([script], join(dir, 'missing', 'job.log'), process.env, m => said.push(m));
    expect(code).toBe(0);
    expect(said.join('\n')).toMatch(/ENOENT/);
  });
});
