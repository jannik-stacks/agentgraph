import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { studioDir } from './studio.ts';

it('exits with the studio status when the studio fails to start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentgraph-watch-'));
  const { status, stderr } = spawnSync(
    process.execPath,
    [join(studioDir, 'watch.ts'), '--repo', dir, '--data', join(dir, 'data')],
    { encoding: 'utf8', timeout: 20_000 }
  );
  expect(stderr).toContain('is not in a git repo');
  expect(status).toBe(2);
});

it('exits with the status of a restarted studio that fails to start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentgraph-watch-'));
  for (const dir of ['studio', 'src', 'bin']) mkdirSync(join(root, dir));
  copyFileSync(join(studioDir, 'watch.ts'), join(root, 'studio', 'watch.ts'));
  writeFileSync(
    join(root, 'studio', 'dev.ts'),
    `import { existsSync, writeFileSync } from 'node:fs';
     const started = ${JSON.stringify(join(root, 'started'))};
     if (existsSync(started)) process.exit(3);
     writeFileSync(started, '');
     console.log('ready');
     setInterval(() => {}, 1000);`
  );
  const watcher = spawn(process.execPath, [join(root, 'studio', 'watch.ts')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise<number | null>(done => watcher.on('exit', done));
  const timeout = setTimeout(() => watcher.kill(), 20_000);
  watcher.stdout.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('ready')) writeFileSync(join(root, 'src', 'edited.ts'), '');
  });
  const status = await exited;
  clearTimeout(timeout);
  expect(status).toBe(3);
}, 30_000);
