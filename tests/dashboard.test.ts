import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Effect, Schema, Stream } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { startStudioServer } from './studio.ts';
import { seeded } from './fixtures.ts';
import { removeAfter } from './world.ts';
import { ensureInstance } from '../src/instance.ts';
import { makeInstanceHost } from '../src/engine.ts';
import { readPlugins } from '../src/plugin.ts';
import { findIssueDir, folderTracker, writeIssueFile } from '../src/tracker.ts';
import { DashboardSettings, DashboardData, DashboardSnapshot } from '../examples/dashboard/plugins/dashboard/data.ts';
import { readDashboard } from '../examples/dashboard/plugins/dashboard/read.ts';

const folders: string[] = [];
const makeData = () => {
  const data = mkdtempSync(join(tmpdir(), 'dashboard-'));
  folders.push(data);
  return data;
};
afterEach(() => folders.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

const now = new Date('2026-11-09T12:00:00Z');

const readFirstWidgetRows = (sections: typeof DashboardData.Type) =>
  sections.map(section =>
    'why' in section ? section.why : section.widgets[0]!.rows.filter(row => row.value).map(row => row.series)
  );
const makeSettings = () =>
  Schema.decodeUnknownSync(DashboardSettings)({
    widgets: [
      ...['runs', 'checks', 'tokens', 'cost'].map(source => ({
        title: source,
        type: 'table',
        source,
        days: 2,
        workflow: 'issue',
        step: 'build',
      })),
      { title: 'issues', type: 'line', source: 'issues', days: 2 },
    ],
  });

const makeTracker = async (events: { kind: string; at: string }[]) => {
  const tracker = makeData();
  const n = await writeIssueFile(tracker, { title: 'Trend', author: 'morgan', labels: [] }, '');
  writeFileSync(
    join(findIssueDir(tracker, n), 'events.jsonl'),
    events.map(e => `${JSON.stringify({ issue: n, actor: 'morgan', trusted: true, ...e })}\n`).join('')
  );
  return {
    layer: folderTracker(tracker, 'morgan', ['morgan']),
    origin: { origin: join(tracker, 'origin.git'), local: true },
  };
};

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
  const tracker = await makeTracker([
    { kind: 'comment', at: '2026-11-08T10:00:00Z' },
    { kind: 'closed', at: '2026-11-09T10:00:00Z' },
    { kind: 'label', at: '2026-11-09T10:00:00Z' },
    { kind: 'comment', at: '2026-11-01T10:00:00Z' },
  ]);
  const snapshot = await Effect.runPromise(readDashboard(makeSettings(), makeInstanceHost({ data }, tracker), now));
  expect(Schema.is(DashboardSnapshot)(snapshot)).toBe(true);
  expect(
    snapshot.widgets.map(widget => ({
      source: widget.source,
      sum: widget.rows.reduce((sum, row) => sum + row.value, 0),
      skipped: widget.skipped,
      why: widget.why,
    }))
  ).toEqual([
    { source: 'runs', sum: 0, skipped: 0, why: '' },
    { source: 'checks', sum: 2, skipped: 0, why: '' },
    { source: 'tokens', sum: 42, skipped: 0, why: '' },
    { source: 'cost', sum: 0.25, skipped: 1, why: 'Usage events without a reported USD cost' },
    { source: 'issues', sum: 2, skipped: 0, why: '' },
  ]);
  expect(snapshot.widgets[1]!.rows.filter(row => row.value)).toEqual([
    { day: '2026-11-08', series: 'fail', value: 1 },
    { day: '2026-11-09', series: 'pass', value: 1 },
  ]);
  expect(JSON.stringify(snapshot)).not.toContain(data);
});

it('reads the tracker once per window while its last read is fresh', async () => {
  const host = makeInstanceHost({ data: makeData() });
  const cursors: string[] = [];
  const tracker = { ...host.tracker, since: (cursor: string) => (cursors.push(cursor), Stream.empty) };
  const read = () => Effect.runPromise(readDashboard(makeSettings(), { store: host.store, tracker }, now));
  await read();
  await read();
  expect(cursors).toEqual(['2026-11-07T00:00:00.000Z']);
});

it('registers the example page, reuses settings and reads a changed run', async () => {
  const data = makeData();
  const { pages } = await readPlugins(
    join(import.meta.dirname, '../examples/dashboard'),
    { dashboard: { widgets: [{ title: 'runs', type: 'table', source: 'runs', days: 2 }] } },
    { instances: { live: makeInstanceHost({ data }) } }
  );
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
  expect([before, after].map(readFirstWidgetRows)).toEqual([[['waiting']], [['done']]]);
});

it.each([
  { source: 'unknown' },
  { type: 'pie' },
  { days: 0 },
  { days: 91 },
  { days: 1.5 },
  { extra: true },
  { source: 'issues', workflow: 'issue' },
])('rejects unknown or unbounded widget input: %j', invalid => {
  expect(() =>
    Schema.decodeUnknownSync(DashboardSettings, { onExcessProperty: 'error' })({
      widgets: [{ title: 'Runs', type: 'line', source: 'runs', days: 7, ...invalid }],
    })
  ).toThrow();
});

it('fails on malformed store data and skips issues without a tracker', async () => {
  const data = makeData();
  mkdirSync(join(data, 'r1'));
  const read = () => Effect.runPromise(readDashboard(makeSettings(), makeInstanceHost({ data }), now));
  writeFileSync(join(data, 'r1/run.json'), JSON.stringify({ id: 'r1', workflow: 'issue', started: 'x' }));
  const { skipped, why } = (await read()).widgets.at(-1)!;
  writeFileSync(join(data, 'r1/run.json'), '{');
  await expect(read()).rejects.toThrow('r1/run.json');
  expect({ skipped, why }).toEqual({ skipped: 1, why: 'Tracker unread: this studio serves no tracker' });
});

it('serves the example page and refreshes it through the existing change path', async () => {
  const graph = makeData();
  const data = makeData();
  mkdirSync(join(graph, 'plugins'));
  mkdirSync(join(data, 'r1'), { recursive: true });
  const source = pathToFileURL(join(import.meta.dirname, '../examples/dashboard/plugins/dashboard.ts')).href;
  writeFileSync(join(graph, 'plugins/dashboard.ts'), `export { default } from ${JSON.stringify(source)};`);
  writeFileSync(
    join(graph, 'settings.yaml'),
    JSON.stringify({ plugins: { dashboard: { widgets: [{ title: 'runs', type: 'table', source: 'runs', days: 2 }] } } })
  );
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
    expect(await page.text()).toContain('Days use UTC');
    const read = async () =>
      Schema.decodeUnknownSync(DashboardData)(await (await fetch(`${base}/api/plugins/dashboard/data`)).json());
    const before = await read();
    const sent = vi.spyOn(server.ws, 'send');
    writeRun('done');
    await vi.waitFor(() =>
      expect(sent).toHaveBeenCalledWith('agi:changed', { topics: expect.arrayContaining(['dashboard']) })
    );
    const after = await read();
    expect([before, after].map(readFirstWidgetRows)).toEqual([[['waiting']], [['done']]]);
  } finally {
    await server.close();
    vi.unstubAllEnvs();
  }
});

const writeStatusRun = (data: string, id: string, status: string) => {
  mkdirSync(join(data, id), { recursive: true });
  writeFileSync(
    join(data, id, 'run.json'),
    JSON.stringify({ id, workflow: 'issue', step: 'build', status, started: new Date().toISOString() })
  );
};

it('serves the example as one studio page over every served instance', async () => {
  const { root: dir, seed } = seeded('studio-dashboard', { 'README.md': 'hello' });
  removeAfter(dir);
  const root = join(dir, 'instances');
  const served = await Promise.all(['live', 'bench'].map(name => ensureInstance(root, name, seed)));
  for (const i of served) {
    writeFileSync(
      join(i.dir, 'instance.yaml'),
      `checkout: ${seed}\nbase: main\nowner: o\nexported: {}\ngraph: ${join(import.meta.dirname, '../examples/starter')}\n`
    );
    writeStatusRun(i.data, 'r1', 'waiting');
  }
  vi.stubEnv('AGI_STUDIO_INSTANCES', JSON.stringify({ root, names: ['live', 'bench', 'gone'] }));
  vi.stubEnv('AGI_STUDIO_PLUGINS', join(import.meta.dirname, '../examples/dashboard'));
  const { server, base } = await startStudioServer();
  const read = async (query = '') => {
    const response = await fetch(`${base}/api/plugins/dashboard/data${query}`);
    return response.ok ? Schema.decodeUnknownSync(DashboardData)(await response.json()) : response.status;
  };
  const count = (snapshot: Awaited<ReturnType<typeof read>>) =>
    typeof snapshot === 'number' ? snapshot : readFirstWidgetRows(snapshot);
  try {
    const manifest = await (await fetch(`${base}/@id/__x00__virtual:agentgraph-pages`)).text();
    const before = await read();
    const sent = vi.spyOn(server.ws, 'send');
    writeStatusRun(served[1]!.data, 'r1', 'done');
    await vi.waitFor(() =>
      expect(sent).toHaveBeenCalledWith('agi:changed', { topics: expect.arrayContaining(['dashboard']) })
    );
    expect({
      page: manifest.includes('href:"/plugins/dashboard",builtin:false,instance:undefined'),
      before: count(before),
      after: count(await read()),
      scoped: await read('?instance=live'),
    }).toEqual({
      page: true,
      before: [['waiting'], ['waiting'], `there is no instance gone under ${root}`],
      after: [['waiting'], ['done'], `there is no instance gone under ${root}`],
      scoped: 404,
    });
  } finally {
    await server.close();
    vi.unstubAllEnvs();
  }
});
