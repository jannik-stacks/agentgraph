import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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
