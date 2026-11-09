import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readInstanceEnv } from '../src/main.ts';
import { ensureInstance } from '../src/instance.ts';
import { seeded } from './fixtures.ts';
import { removeAfter } from './world.ts';
import { startStudioServer } from './studio.ts';
import { makeServedGraphs } from '../studio/served.ts';

const starter = join(import.meta.dirname, '..', 'examples', 'starter');

const writeRun = (data: string, id: string) => {
  mkdirSync(join(data, id), { recursive: true });
  writeFileSync(
    join(data, id, 'run.json'),
    JSON.stringify({ id, issue: 1, workflow: 'issue', status: 'done', step: 'done', started: 'now', rounds: {} })
  );
};

it('serves each named instance under its own name, with no run crossing over', async () => {
  const { root: dir, seed } = seeded('studio-instances', { 'README.md': 'hello' });
  removeAfter(dir);
  const root = join(dir, 'instances');
  const [live, bench] = await Promise.all(['live', 'bench'].map(name => ensureInstance(root, name, seed)));
  for (const i of [live!, bench!]) {
    writeFileSync(
      join(i.dir, 'instance.yaml'),
      `checkout: ${seed}\nbase: main\nowner: o\nexported: {}\ngraph: ${starter}\n`
    );
    writeRun(i.data, `run-${i.dir.split('/').at(-1)}`);
  }
  const at = new Date().toISOString();
  writeFileSync(
    join(live!.data, 'run-live', 'labels.jsonl'),
    `${JSON.stringify({ at, key: 'variant', value: 'a' })}\n`
  );
  writeFileSync(
    join(live!.data, 'run-live', 'checks.jsonl'),
    `${JSON.stringify({ at, step: 'review', check: { check: 'quality', pass: true, ms: 0, value: { score: 3 } }, version: 'v', usd: 0 })}\n`
  );
  vi.stubEnv('AGI_STUDIO_INSTANCES', JSON.stringify({ root, names: ['live', 'bench'] }));
  vi.stubEnv('AGI_STUDIO_DIR', undefined);
  vi.stubEnv('AGI_STUDIO_DATA', undefined);
  vi.stubEnv('AGI_STUDIO_BENCH', undefined);
  const { server, base } = await startStudioServer();
  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`);
    return [response.status, await response.json()];
  };
  try {
    const listed = async (name: string) => {
      const [status, runs] = await get(`/api/runs?instance=${name}`);
      return [status, runs.map((r: { fixture: string; run: { id: string } }) => `${r.fixture} ${r.run.id}`)];
    };
    expect(await listed('live')).toEqual([200, ['live/issue run-live']]);
    expect(await listed('bench')).toEqual([200, ['bench/issue run-bench']]);
    expect(await get('/api/runs/run-bench?instance=live')).toEqual([404, null]);
    expect((await get('/api/runs/run-bench?instance=bench'))[0]).toBe(200);
    const refused = ['/api/runs', '/api/runs?instance=other', '/api/plugins/results/data'];
    expect(await Promise.all(refused.map(async path => (await fetch(`${base}${path}`)).status))).toEqual([
      400, 400, 404,
    ]);
    const [, results] = await get('/api/plugins/results/data?instance=bench');
    expect(results.sheet.runs.map((r: { key: string }) => r.key)).toEqual(['run-bench']);
    const [, benched] = await get('/api/plugins/bench/data?instance=bench');
    expect(
      benched.rows.map((r: { instance: string; run: string; labels: Record<string, string> }) => [
        r.instance,
        r.run,
        r.labels.instance,
        r.labels.variant,
      ])
    ).toEqual([
      ['live', 'run-live', 'live', 'a'],
      ['bench', 'run-bench', 'bench', undefined],
    ]);
    expect(benched.fields).toEqual([{ check: 'quality', field: 'score', type: 'number' }]);
    expect((await get('/api/plugins/bench/data?instance=live'))[1]).toEqual(benched);
    const served = await (await fetch(`${base}/@id/__x00__virtual:served`)).text();
    expect(served).toContain('"name":"live","title":"live","problems":[],"local":true');
    expect(served).toContain('"name":"bench"');
    const manifest = await (await fetch(`${base}/@id/__x00__virtual:agentgraph-pages`)).text();
    expect(manifest).toContain('instance:"live",load:()=>import("/@id/__x00__virtual:agentgraph-page/live/results")');
    expect(manifest).toContain('instance:"bench"');
    const fixtures = await (await fetch(`${base}/@id/__x00__virtual:fixtures`)).text();
    expect(fixtures).toContain('"id":"live/issue"');
    expect(fixtures).toContain('"id":"bench/issue"');
    await vi.waitFor(() => expect(server.watcher.getWatched()).toHaveProperty(realpathSync(bench!.data)));
    const sent = vi.spyOn(server.ws, 'send');
    writeRun(bench!.data, 'run-later');
    await vi.waitFor(() => expect(sent).toHaveBeenCalledWith('agi:changed', { topics: ['bench:data', 'bench'] }));
  } finally {
    await server.close();
    vi.unstubAllEnvs();
  }
});

const readStudioUrl = async (url: string) =>
  (await readInstanceEnv({ dir: '/data/stacks-kit', owner: 'o', base: 'main' }, {}, { AGENTGRAPH_STUDIO_URL: url })).env
    .AGENTGRAPH_STUDIO_URL;

it('links an instance run under the studio address plus the instance name', async () => {
  expect(await readStudioUrl('http://127.0.0.1:5600/')).toBe('http://127.0.0.1:5600/stacks-kit');
  expect(await readStudioUrl('')).toBe('');
});

it('ignores instance settings from the shell when it serves several instances, as the loop does', async () => {
  const { root: dir, seed } = seeded('studio-shell', { 'README.md': 'hello' });
  removeAfter(dir);
  const root = join(dir, 'instances');
  for (const name of ['left', 'right']) {
    const i = await ensureInstance(root, name, seed);
    writeFileSync(
      join(i.dir, 'instance.yaml'),
      `checkout: ${seed}\nbase: main\nowner: o\nexported: {}\ngraph: ${starter}\n`
    );
  }
  vi.stubEnv('AGI_STUDIO_INSTANCES', JSON.stringify({ root, names: ['left', 'right'] }));
  vi.stubEnv('AGENTGRAPH_TRACKER', 'github');
  const warned = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const served = await makeServedGraphs().read();
    expect(served.map(({ name, local, problems }) => ({ name, local, problems }))).toEqual([
      { name: 'left', local: true, problems: [] },
      { name: 'right', local: true, problems: [] },
    ]);
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('ignoring AGENTGRAPH_TRACKER from the shell'));
  } finally {
    warned.mockRestore();
    vi.unstubAllEnvs();
  }
});
