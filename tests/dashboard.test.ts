import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Effect, Schema } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { startStudioServer } from './studio.ts';
import { readPlugins } from '../src/plugin.ts';
import { DashboardSettings, DashboardData } from '../examples/dashboard/plugins/dashboard/data.ts';
import { readDashboard } from '../examples/dashboard/plugins/dashboard/read.ts';

const folders: string[] = [];
const makeData = () => {
  const data = mkdtempSync(join(tmpdir(), 'dashboard-'));
  folders.push(data);
  return data;
};
afterEach(() => folders.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

const now = new Date('2026-11-09T12:00:00Z');
const makeSettings = (data: string) =>
  Schema.decodeUnknownSync(DashboardSettings)({
    data,
    widgets: ['runs', 'checks', 'tokens', 'cost'].map(source => ({
      title: source,
      type: 'table',
      source,
      days: 2,
      workflow: 'issue',
      step: 'build',
    })),
  });

it('aggregates current run cohorts and dated events, with missing cost counted', async () => {
  const data = makeData();
  const run = join(data, 'r1');
  mkdirSync(run);
  writeFileSync(
    join(run, 'run.json'),
    JSON.stringify({ id: 'r1', workflow: 'issue', step: 'build', status: 'done', started: '2026-10-01T00:00:00Z' })
  );
  writeFileSync(
    join(run, 'checks.jsonl'),
    [
      { at: '2026-11-08T00:00:00Z', step: 'build', check: { check: 'tests', pass: false } },
      { at: '2026-11-09T12:00:00Z', step: 'build', check: { check: 'tests', pass: true } },
      { at: '2026-11-09T13:00:00Z', step: 'build', check: { check: 'tests', pass: true } },
      { at: '2026-11-07T23:59:59Z', step: 'build', check: { check: 'tests', pass: true } },
      { at: '2026-11-09T01:00:00Z', step: 'review', check: { check: 'tests', pass: true } },
    ]
      .map(row => JSON.stringify(row))
      .join('\n') + '\n'
  );
  writeFileSync(
    join(run, 'trace.jsonl'),
    [
      { at: '2026-11-08T00:00:00Z', step: 'build', event: { type: 'usage', input: 10, output: 5, usd: 0.25 } },
      { at: '2026-11-09T01:00:00Z', step: 'build', event: { type: 'usage', input: 20, output: 7 } },
      { at: '2026-11-09T01:00:00Z', step: 'review', event: { type: 'usage', input: 999, output: 999, usd: 99 } },
    ]
      .map(row => JSON.stringify(row))
      .join('\n') + '\n'
  );
  const snapshot = await Effect.runPromise(readDashboard(makeSettings(data), now));
  expect(Schema.is(DashboardData)(snapshot)).toBe(true);
  expect(
    snapshot.widgets.map(widget => ({
      source: widget.source,
      sum: widget.rows.reduce((sum, row) => sum + row.value, 0),
      skipped: widget.skipped,
    }))
  ).toEqual([
    { source: 'runs', sum: 0, skipped: 0 },
    { source: 'checks', sum: 2, skipped: 0 },
    { source: 'tokens', sum: 42, skipped: 0 },
    { source: 'cost', sum: 0.25, skipped: 1 },
  ]);
  expect(snapshot.widgets[1]!.rows.filter(row => row.value)).toEqual([
    { day: '2026-11-08', series: 'fail', value: 1 },
    { day: '2026-11-09', series: 'pass', value: 1 },
  ]);
  expect(JSON.stringify(snapshot)).not.toContain(data);
});

it('registers the example page, reuses settings and reads a changed run', async () => {
  const data = makeData();
  const settings = makeSettings(data);
  const { pages } = await readPlugins(join(import.meta.dirname, '../examples/dashboard'), { dashboard: settings });
  expect(pages.map(page => ({ name: page.name, watch: page.watch }))).toEqual([{ name: 'dashboard', watch: [data] }]);
  const run = join(data, 'r1');
  mkdirSync(run);
  const writeRun = (status: string) =>
    writeFileSync(
      join(run, 'run.json'),
      JSON.stringify({ id: 'r1', workflow: 'issue', step: 'build', status, started: new Date().toISOString() })
    );
  writeRun('waiting');
  const before = (await Effect.runPromise(pages[0]!.read())) as typeof DashboardData.Type;
  writeRun('done');
  const after = (await Effect.runPromise(pages[0]!.read())) as typeof DashboardData.Type;
  expect(
    [before, after].map(snapshot => snapshot.widgets[0]!.rows.filter(row => row.value).map(row => row.series))
  ).toEqual([['waiting'], ['done']]);
});

it.each([{ source: 'unknown' }, { type: 'pie' }, { days: 0 }, { days: 91 }, { days: 1.5 }, { extra: true }])(
  'rejects unknown or unbounded widget input: %j',
  invalid => {
    expect(() =>
      Schema.decodeUnknownSync(DashboardSettings, { onExcessProperty: 'error' })({
        data: '/data',
        widgets: [{ title: 'Runs', type: 'line', source: 'runs', days: 7, ...invalid }],
      })
    ).toThrow();
  }
);

it('rejects relative paths and malformed store data', async () => {
  await expect(Effect.runPromise(readDashboard(makeSettings('relative'), now))).rejects.toThrow('absolute path');
  const data = makeData();
  mkdirSync(join(data, 'r1'));
  writeFileSync(join(data, 'r1/run.json'), '{');
  await expect(Effect.runPromise(readDashboard(makeSettings(data), now))).rejects.toThrow();
});

it('serves the example page and refreshes it through the existing change path', async () => {
  const graph = makeData();
  const data = makeData();
  mkdirSync(join(graph, 'plugins'));
  mkdirSync(join(data, 'r1'), { recursive: true });
  const source = pathToFileURL(join(import.meta.dirname, '../examples/dashboard/plugins/dashboard.ts')).href;
  writeFileSync(join(graph, 'plugins/dashboard.ts'), `export { default } from ${JSON.stringify(source)};`);
  writeFileSync(join(graph, 'settings.yaml'), JSON.stringify({ plugins: { dashboard: makeSettings(data) } }));
  const writeRun = (status: string) =>
    writeFileSync(
      join(data, 'r1/run.json'),
      JSON.stringify({ id: 'r1', workflow: 'issue', step: 'build', status, started: new Date().toISOString() })
    );
  writeRun('waiting');
  vi.stubEnv('AGI_STUDIO_DIR', graph);
  vi.stubEnv('AGI_STUDIO_DATA', data);
  const { server, base } = await startStudioServer();
  try {
    expect(await (await fetch(`${base}/@id/__x00__virtual:served`)).text()).not.toContain('"message"');
    const manifest = await (await fetch(`${base}/@id/__x00__virtual:agentgraph-pages`)).text();
    expect(manifest).toContain('href:"/plugins/dashboard"');
    const page = await fetch(
      `${base}/@fs${join(import.meta.dirname, '../examples/dashboard/plugins/dashboard/DashboardPage.tsx')}`
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Current state by start day');
    const read = async () =>
      Schema.decodeUnknownSync(DashboardData)(await (await fetch(`${base}/api/plugins/dashboard/data`)).json());
    const before = await read();
    const sent = vi.spyOn(server.ws, 'send');
    writeRun('done');
    await vi.waitFor(() =>
      expect(sent).toHaveBeenCalledWith('agi:changed', { topics: expect.arrayContaining(['dashboard']) })
    );
    const after = await read();
    expect(
      [before, after].map(snapshot => snapshot.widgets[0]!.rows.filter(row => row.value).map(row => row.series))
    ).toEqual([['waiting'], ['done']]);
  } finally {
    await server.close();
    vi.unstubAllEnvs();
  }
});
