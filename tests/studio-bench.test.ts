import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { Effect } from 'effect';
import { makeInstanceHost, runLocalActions } from '../src/engine.ts';
import { fileStore, Store } from '../src/store.ts';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeStudioPagesPlugin } from '../studio/plugins.ts';
import type { BenchData, BenchRow } from '../examples/plugins/bench/plugins/bench/data.ts';
import { getQuantile } from '../src/stats.ts';
import { createStudioServer, runStudioAction, startStudioServer, studioDependency } from './studio.ts';
import { tmp } from './kit.ts';
import {
  bootstrap,
  getBenchNumbers,
  getBenchAxis,
  findBenchNumericFields,
  cost,
  defaultBenchScoreWeights,
  formatBenchLabelCommand,
  frontier,
  getQualitySpread,
  getRowKey,
  presets,
  quality,
  readBenchRowResults,
  summarise,
} from '../bench/score.ts';
import { type Run, type Trace } from '../src/types.ts';

type Row = BenchRow;
const bench = join(import.meta.dirname, '../examples/plugins/bench/plugins/bench.ts');
const at = '2026-10-16T05:00:00.000Z';

const row = (over: Partial<Row>): Row => ({
  labels: { harness: 'opencode', model: 'smart', arm: 'v2', engine: 'unknown', graph: '', set: 'runs-3', repo: 'me/a' },
  case: 'a',
  repeat: 1,
  vsHuman: {},
  findings: { critical: 0, high: 0 },
  answers: 0,
  minutes: 1,
  tokens: {},
  split: { agent: 0, tools: 0, setup: 0, checks: 0, infra: 0 },
  usd: 0,
  usdUncached: 0,
  checkUsd: 0,
  run: 'run-1',
  data: '',
  at: '',
  results: {},
  ...over,
});

describe('bench score', () => {
  it('leaves a row with nothing to score unscored instead of treating it as zero quality', () => {
    expect(quality(row({}), defaultBenchScoreWeights)).toBeUndefined();
  });

  it('leaves rows with nothing to score out of the point and its counts', () => {
    const rows = [row({ case: 'a', hidden: 1, suite: 1 }), row({ case: 'b' }), row({ case: 'a', repeat: 2 })];
    const [p] = summarise(rows, { w: defaultBenchScoreWeights, x: r => r.minutes });
    expect([p!.y, p!.n, p!.repeats, p!.perCase.map(s => s.row.case)]).toEqual([1, 1, 1, ['a']]);
  });

  it('puts nothing useful at 0 and the human at 1', () => {
    const nothing = row({ hidden: 0, suite: 0, vsHuman: { opus: 0 } });
    const parity = row({ hidden: 1, suite: 1, vsHuman: { opus: 0.5, sol: 0.5 } });
    expect(quality(nothing, defaultBenchScoreWeights)).toBe(0);
    expect(quality(parity, defaultBenchScoreWeights)).toBeCloseTo(1);
  });

  it('scores a run that changed nothing 0, whatever else it has', () => {
    expect(
      quality(row({ outcome: 'no-change', hidden: 0, suite: 1, vsHuman: { opus: 0.5 } }), defaultBenchScoreWeights)
    ).toBe(0);
  });

  it('weights the parts a case has, drops judges and charges findings beyond the human change', () => {
    const judged = row({ vsHuman: { opus: 1, sol: 0 } });
    expect(quality(judged, defaultBenchScoreWeights)).toBeCloseTo(1);
    expect(quality(judged, defaultBenchScoreWeights, ['sol'])).toBe(0);
    expect(quality(row({ hidden: 1, vsHuman: { opus: 0 } }), presets['hidden tests only']!)).toBe(1);
    const found = row({ hidden: 1, suite: 1, findings: { critical: 1, high: 2 }, against: { critical: 0, high: 1 } });
    expect(quality(found, defaultBenchScoreWeights)).toBeCloseTo(1 - 0.1 * (2 / 3));
    expect(quality(row({ hidden: 1, answers: 3 }), defaultBenchScoreWeights)).toBeCloseTo(0.9);
  });

  it('takes the share of hidden tests passed over pass or fail when there is one', () => {
    expect(quality(row({ hidden: 0, hiddenShare: 0.5 }), presets['hidden tests only']!)).toBe(0.5);
  });

  it('caps the judge part at the human, so judged and tested parts share one scale', () => {
    expect(quality(row({ vsHuman: { opus: 1, sonnet: 1 } }), defaultBenchScoreWeights)).toBe(1);
    expect(quality(row({ hidden: 0, vsHuman: { opus: 1 } }), defaultBenchScoreWeights)).toBeCloseTo(0.35 / 0.85);
  });

  it('discovers finite numeric fields and averages labels over repeats then cases', () => {
    const rows = [
      row({ case: 'a', hidden: 1, labels: { words: '0', blank: ' ', bad: 'Infinity', mixed: '1', missing: '1' } }),
      row({ case: 'a', hidden: 1, labels: { words: '4', blank: '', bad: 'NaN', mixed: 'oops' } }),
      row({ case: 'b', hidden: 1, labels: { words: '-8', blank: '', bad: 'Infinity', mixed: '2' } }),
    ];
    const fields = findBenchNumericFields(rows, { w: defaultBenchScoreWeights });
    expect(fields).toContain('words');
    expect(fields).toContain('minutes');
    expect(fields.filter(key => ['blank', 'bad', 'mixed', 'missing'].includes(key))).toEqual([]);
    expect(findBenchNumericFields([], { w: defaultBenchScoreWeights })).toEqual([]);
    const [point] = summarise(rows, { w: defaultBenchScoreWeights, x: r => getBenchNumbers(r).words!, by: [] });
    expect(point!.x).toBe(-3);
    expect(
      summarise(rows, {
        w: defaultBenchScoreWeights,
        x: r => getBenchNumbers(r).words!,
        by: ['words'],
        where: { words: ['4'] },
      }).map(p => [p.labels.words, p.x])
    ).toEqual([['4', 4]]);
  });

  it('falls back to cost when a filter brings in an unlabelled run and allows axis recovery', () => {
    const labelled = row({ hidden: 1, usd: 2, labels: { ...row({}).labels, 'graph-words': '12' } });
    const unlabelled = row({ case: 'b', hidden: 1, usd: 4 });
    const selected = 'graph-words';
    expect(getBenchAxis(selected, findBenchNumericFields([labelled], { w: defaultBenchScoreWeights }))).toBe(selected);
    const rows = [labelled, unlabelled];
    const fields = findBenchNumericFields(rows, { w: defaultBenchScoreWeights });
    const axis = getBenchAxis(selected, fields);
    expect(axis).toBeNull();
    expect(
      summarise(rows, {
        w: defaultBenchScoreWeights,
        by: [],
        x: r => (axis === null ? cost(r) : getBenchNumbers(r)[axis]!),
      }).map(p => p.x)
    ).toEqual([3]);
    expect(getBenchAxis('minutes', fields)).toBe('minutes');
  });

  it.each([
    { why: 'infra failure', excluded: { infra: 'setup failed', hidden: 1 as const }, settings: {} },
    { why: 'no scores', excluded: {}, settings: {} },
    { why: 'dropped judge', excluded: { vsHuman: { sol: 1 } }, settings: { judges: ['opus'] } },
    { why: 'zero weight', excluded: { vsHuman: { sol: 1 } }, settings: { w: presets['hidden tests only']! } },
    {
      why: 'label filter',
      excluded: { hidden: 1 as const, labels: { arm: 'other' } },
      settings: { where: { arm: ['v2'] } },
    },
  ])('keeps a numeric axis when an unlabelled row is excluded by $why', ({ excluded, settings }) => {
    const labelled = row({ hidden: 1, labels: { ...row({}).labels, 'graph-words': '12' } });
    const rows = [labelled, row(excluded)];
    const lens = { w: defaultBenchScoreWeights, ...settings };
    const axis = getBenchAxis('graph-words', findBenchNumericFields(rows, lens));
    expect(axis).toBe('graph-words');
    expect(
      summarise(rows, { ...lens, by: [], x: r => (axis === null ? cost(r) : getBenchNumbers(r)[axis]!) })
        .filter(p => p.n > 0)
        .map(p => [p.x, p.repeats])
    ).toEqual([[12, 1]]);
  });

  it('requires numeric labels on infra rows when they count as zero', () => {
    const rows = [
      row({ hidden: 1, labels: { ...row({}).labels, 'graph-words': '12' } }),
      row({ infra: 'setup failed' }),
    ];
    const lens = { w: defaultBenchScoreWeights, infraZero: true };
    expect(findBenchNumericFields(rows, lens)).not.toContain('graph-words');
    expect(summarise(rows, { ...lens, by: [], x: r => r.minutes })[0]!.repeats).toBe(2);
  });

  it('costs a row at list price, with or without its cache reads', () => {
    expect(cost(row({ usd: 0.3, usdUncached: 0.5 }))).toBe(0.3);
    expect(cost(row({ usd: 0.3, usdUncached: 0.5 }), true)).toBe(0.5);
  });

  it('takes the median and quartiles between case means, whatever their order', () => {
    expect([0.25, 0.5, 0.75].map(q => getQuantile([1, 0, 0.5, 0.25], q))).toEqual([0.1875, 0.375, 0.625]);
    expect(getQuantile([0.4], 0.5)).toBe(0.4);
  });

  it('bootstraps cases then repeats the same way for the same seed', () => {
    const cases = [
      [
        { y: 0, x: 1 },
        { y: 1, x: 3 },
      ],
      [{ y: 1, x: 2 }],
      [{ y: 0.5, x: 1 }],
    ];
    const a = bootstrap(cases);
    expect(a).toEqual(bootstrap(cases));
    expect(a.y).toBeCloseTo(2 / 3);
    expect(a.x).toBeCloseTo(5 / 3);
    expect(a.yCi[0]).toBeLessThanOrEqual(a.y);
    expect(a.yCi[1]).toBeGreaterThanOrEqual(a.y);
  });

  it('summarises points without the human, with completion, and keeps the non-dominated ones', () => {
    const rows = [
      row({ case: 'a', hidden: 1, suite: 1 }),
      row({ case: 'b', infra: 'docker unreachable' }),
      row({ labels: { ...row({}).labels, arm: 'floor' }, case: 'a', hidden: 0, suite: 1 }),
      row({ labels: { ...row({}).labels, arm: 'human' }, case: 'a', hidden: 1 }),
    ];
    const s = summarise(rows, { w: defaultBenchScoreWeights, x: r => r.minutes });
    expect(s.map(p => [p.labels.arm, p.n, p.completion])).toEqual([
      ['v2', 1, 0.5],
      ['floor', 1, 1],
    ]);
    expect(summarise(rows, { w: defaultBenchScoreWeights, x: r => r.minutes, infraZero: true })[0]!.y).toBeCloseTo(0.5);
    const points = [
      { key: 'cheap', x: 1, y: 0.2 },
      { key: 'worse', x: 2, y: 0.1 },
      { key: 'better', x: 3, y: 0.8 },
      { key: 'tied', x: 4, y: 0.8 },
    ];
    expect(frontier(points)).toEqual(['cheap', 'better']);
  });

  it('leaves excluded runs out of points, counts and denominators unless kept, and drops infra ones too', () => {
    const exclude = (why: string) => ({ labels: { ...row({}).labels, exclude: why } });
    const rows = [
      row({ case: 'a', hidden: 1, suite: 1 }),
      row({ case: 'b', hidden: 0, ...exclude('flaky docker') }),
      row({ case: 'c', infra: 'docker unreachable', ...exclude('host down') }),
    ];
    const lens = { w: defaultBenchScoreWeights, x: (r: Row) => r.minutes, infraZero: true };
    const shown = (keepExcluded: boolean) =>
      summarise(rows, { ...lens, keepExcluded }).map(p => [p.n, p.repeats, p.completion, p.y]);
    expect([shown(false), shown(true)]).toEqual([[[1, 1, 1, 1]], [[3, 3, 2 / 3, 1 / 3]]]);
    expect(findBenchNumericFields([rows[1]!], lens)).toEqual([]);
  });

  it('copies a local label command for a run read through its store', () => {
    const at = { data: "/sets/it's/data", run: 'issue-1' };
    expect([formatBenchLabelCommand(at, 'flaky docker'), formatBenchLabelCommand(at, null)]).toEqual([
      `agi label '/sets/it'\\''s/data/issue-1' 'exclude=flaky docker'`,
      `agi label '/sets/it'\\''s/data/issue-1' exclude-`,
    ]);
  });

  it('reports judge-only cases as their own point, never averaged with tested ones', () => {
    const rows = [
      row({ case: 'a', labels: { ...row({}).labels, tests: 'hidden' }, hidden: 1 }),
      row({ case: 'b', labels: { ...row({}).labels, tests: 'judge-only' }, vsHuman: { opus: 0 } }),
    ];
    const s = summarise(rows, { w: defaultBenchScoreWeights, x: r => r.minutes });
    expect(s.map(p => [p.labels.tests, p.n, p.y])).toEqual([
      ['hidden', 1, 1],
      ['judge-only', 1, 0],
    ]);
    expect(s.map(p => p.judgeOnly)).toEqual([false, true]);
    expect(frontier([...s.map(p => ({ ...p, x: 2 })), { key: 'cheap', x: 1, y: 0.5 }])).toEqual(['cheap', s[0]!.key]);
  });
  it('filters any label and groups and colours independently, leaving the references out', () => {
    const labels = { ...row({}).labels, size: 'S', skills: 'true' };
    const rows = [
      row({ labels: { ...labels, arm: 'human', graph: '' }, hidden: 1 }),
      row({ labels: { ...labels, arm: 'base', graph: '' }, hidden: 0 }),
      row({ labels, hidden: 1, findings: { critical: 3, high: 0 }, against: { critical: 3, high: 0 } }),
      row({ labels: { ...labels, repo: 'me/b', skills: 'false' }, case: 'b', hidden: 0 }),
      row({ labels: { ...labels, size: 'L' }, case: 'c', hidden: 0 }),
    ];
    const lens = { w: defaultBenchScoreWeights, x: (r: Row) => r.minutes, by: ['size'], color: 'skills' };
    const filtered = summarise(rows, { ...lens, where: { arm: ['v2'], size: ['S'], repo: ['me/a'] } });
    expect(filtered.map(p => [p.labels, p.n, p.y])).toEqual([[{ size: 'S', skills: 'true', set: 'runs-3' }, 1, 1]]);
    expect(summarise(rows, lens).map(p => p.n)).toEqual([1, 1, 1]);
    expect(summarise(rows, { ...lens, color: '' }).map(p => p.n)).toEqual([2, 1]);
    const other = row({ labels: { ...labels, set: 'core' }, case: 'd', hidden: 1 });
    expect(summarise([...rows, other], { ...lens, by: [], color: '' }).map(p => p.labels.set)).toEqual([
      'runs-3',
      'core',
    ]);
  });

  it('keeps alternatives within a label and requires every filtered label', () => {
    const rows = ['smart', 'small', 'other'].map(model =>
      row({
        hidden: 1,
        labels: { ...row({}).labels, model },
      })
    );
    const lens = { w: defaultBenchScoreWeights, x: (r: Row) => r.minutes };
    expect(
      summarise(rows, { ...lens, where: { model: ['smart', 'small'], harness: ['opencode'] } }).map(p => p.labels.model)
    ).toEqual(['smart', 'small']);
    expect(summarise(rows, { ...lens, where: { model: [] } })).toEqual([]);
    expect(summarise(rows, { ...lens, where: { model: ['smart'], harness: ['missing'] } })).toEqual([]);
    expect(summarise(rows, lens)).toHaveLength(3);
  });

  it('groups points by label values without delimiter collisions', () => {
    const labels = row({}).labels;
    const rows = [
      row({ repeat: 2, hidden: 1, findings: { critical: 3, high: 0 }, against: { critical: 3, high: 0 } }),
      row({ labels: { ...labels, repo: 'a,b', size: 'c' }, case: 'b', hidden: 1 }),
      row({ labels: { ...labels, repo: 'a', size: 'b,c' }, case: 'c', hidden: 0 }),
    ];
    const points = summarise(rows, { w: defaultBenchScoreWeights, x: r => r.minutes, by: ['repo', 'size'] });
    expect(points.map(p => p.y)).toEqual([1, 1, 0]);
  });
  it('preserves every free label in Results, with distinct identities for combined setups', () => {
    const labels = { ...row({}).labels, point: 'experiment', case: 'category', hiddenTests: 'custom' };
    const result = readBenchRowResults(row({ labels, skipped: 'no hidden tests' }));
    const other = readBenchRowResults(row({ labels: { ...labels, model: 'other' }, run: 'run-2' }));
    expect(result.axes).toMatchObject(labels);
    expect(other.key).not.toBe(result.key);
  });
});

describe('the bench page data', () => {
  it('rejects a failed scan and lists each ended run of a slot once, linked to its run', async () => {
    const out = tmp('bench-api');
    const input = { case: 'c', arm: 'v2', repeat: 1, attempt: 1 };
    const data = join(out, 'data');
    mkdirSync(join(data, 'issue-1'), { recursive: true });
    const origin = { plugin: 'bench', version: 'v', job: 'set', input };
    const versions = { engine: 'abc123', harnesses: { opencode: '1.19.0' } };
    const run = { id: 'issue-1', started: at, workflow: 'issue', meta: { engine: { origin } }, versions };
    writeFileSync(join(data, 'issue-1', 'run.json'), '{');
    writeFileSync(join(data, 'issue-1', 'labels.jsonl'), '{"key":"engine","value":"written"}\n');
    const folder = join(out, 'pages');
    mkdirSync(join(folder, 'plugins'), { recursive: true });
    writeFileSync(join(folder, 'plugins/bench.ts'), `export { default } from ${JSON.stringify(bench)};`);
    writeFileSync(join(folder, 'settings.yaml'), `plugins:\n  bench:\n    sets: [${JSON.stringify(out)}]\n`);
    vi.stubEnv('AGI_STUDIO_DIR', undefined);
    vi.stubEnv('AGI_STUDIO_PLUGINS', folder);
    const routes: Record<string, (req: unknown, res: unknown) => void> = {};
    const plugin = makeStudioPagesPlugin().configureServer as (server: unknown) => Promise<void>;
    await plugin({
      watcher: { add: () => {}, on: () => {}, off: () => {} },
      config: { logger: { error: () => {} }, server: { fs: { allow: [] } } },
      middlewares: { use: (path: string, f: (typeof routes)[string]) => (routes[path] = f) },
    });
    const ask = () =>
      new Promise<{ status: number; body: BenchData }>(done => {
        const res = {
          statusCode: 200,
          setHeader: () => {},
          end: (body: string) => done({ status: res.statusCode, body: JSON.parse(body) }),
        };
        routes['/api/plugins']!({ url: '/bench/data', method: 'GET' }, res);
      });
    try {
      expect((await ask()).status).toBe(500);
      writeFileSync(join(data, 'issue-1', 'run.json'), JSON.stringify(run));
      expect((await ask()).body.rows).toEqual([]);
      const armed = { check: 'bench/arm', pass: true, ms: 0, value: { answers: 0, ms: 60_000 } };
      writeFileSync(
        join(data, 'issue-1', 'checks.jsonl'),
        `${JSON.stringify({ at, step: 'bench', check: armed, version: 'v', usd: 0, later: true })}\n`
      );
      const { rows } = (await ask()).body;
      expect(rows.map(r => [r.run, r.data, r.labels.arm, r.minutes])).toEqual([['issue-1', data, 'v2', 1]]);
      expect(rows[0]!.labels).toMatchObject({ engine: 'written', harnesses: 'opencode@1.19.0' });
    } finally {
      vi.unstubAllEnvs();
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('bench spread', () => {
  const lens = { w: presets['hidden tests only']!, x: (r: Row) => r.minutes };

  it('weights cases equally for the mean and keeps the spread of runs apart', () => {
    const rows = [row({ case: 'a', hidden: 1 }), ...[1, 2, 3].map(repeat => row({ case: 'b', repeat, hidden: 0 }))];
    const [p] = summarise(rows, lens);
    const { cases, runs } = getQualitySpread(p!.perCase);
    expect([p!.y, cases.median, runs.median, runs.range]).toEqual([0.5, 0.5, 0, [0, 1]]);
  });

  it('shows how the repeats of a single case vary, not only their mean', () => {
    const rows = ([0, 0, 1] as const).map((hidden, i) => row({ case: 'a', repeat: i + 1, hidden }));
    const { cases, runs } = getQualitySpread(summarise(rows, lens)[0]!.perCase);
    expect([cases.range, runs.median, runs.range]).toEqual([[1 / 3, 1 / 3], 0, [0, 1]]);
  });

  it('lists two arms on the same case and repeat as two runs of one point', async () => {
    const { createElement } = await studioDependency<{ createElement: (type: unknown, props: object) => unknown }>(
      'react'
    );
    const { renderToStaticMarkup } = await studioDependency<{ renderToStaticMarkup: (node: unknown) => string }>(
      'react-dom/server'
    );
    const server = await createStudioServer();
    vi.stubGlobal('location', new URL('http://studio/bench'));
    const { Forest } = await (server.ssrLoadModule as (id: string) => Promise<{ Forest: unknown }>)(
      join(import.meta.dirname, '../examples/plugins/bench/plugins/bench/Forest.tsx')
    );
    const rows = ['floor', 'v2'].map(arm =>
      row({ hidden: 1, labels: { ...row({}).labels, arm }, data: `/b/a/${arm}/data`, run: `run-${arm}` })
    );
    const [p] = summarise(rows, { ...lens, by: [] });
    expect(new Set(p!.perCase.map(s => getRowKey(s.row))).size).toBe(2);
    try {
      const html = renderToStaticMarkup(
        createElement(Forest, {
          points: [p],
          keys: [],
          weighting: 'composite',
          tone: () => '',
          rowCost: () => 0,
          picked: p!.key,
          onPick: () => {},
        })
      );
      expect(html.match(/href="\/runs\/[^"]+"/g)).toEqual([
        'href="/runs/run-floor?data=%2Fb%2Fa%2Ffloor%2Fdata"',
        'href="/runs/run-v2?data=%2Fb%2Fa%2Fv2%2Fdata"',
      ]);
    } finally {
      vi.unstubAllGlobals();
      await server.close();
    }
  });
});

describe('a bench data dir', () => {
  it('serves runs, logs and results only from real paths inside the bench dirs', async () => {
    const out = tmp('bench-runs');
    const data = join(out, 'c', 'v2', 'data');
    const elsewhere = tmp('bench-elsewhere');
    const run = {
      id: 'issue-1',
      issue: 1,
      started: at,
      workflow: 'issue',
      step: 'review',
      status: 'done',
      tries: 0,
      rounds: {},
    } as Run;
    const hash = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        for (const id of ['issue-1', 'issue-2']) yield* store.put({ ...run, id });
        yield* store.trace('issue-1', { at, step: 'review', event: { type: 'text', text: 'from the bench' } } as Trace);
        return (yield* store.log('full output', false))!.hash;
      }).pipe(Effect.provide(fileStore(data)))
    );
    renameSync(join(data, 'issue-2'), join(elsewhere, 'issue-2'));
    symlinkSync(join(elsewhere, 'issue-2'), join(data, 'issue-2'));
    symlinkSync(elsewhere, join(out, 'linked'));
    vi.stubEnv('AGI_STUDIO_DIR', undefined);
    vi.stubEnv('AGI_STUDIO_DATA', undefined);
    const folder = join(out, 'pages');
    mkdirSync(join(folder, 'plugins'), { recursive: true });
    writeFileSync(join(folder, 'plugins/bench.ts'), `export { default } from ${JSON.stringify(bench)};`);
    writeFileSync(
      join(folder, 'settings.yaml'),
      `plugins:\n  bench:\n    sets: [${JSON.stringify(join(out, 'c', 'v2'))}]\n`
    );
    vi.stubEnv('AGI_STUDIO_PLUGINS', folder);
    const q = (dir: string) => `?data=${encodeURIComponent(dir)}`;
    const { server, base } = await startStudioServer();
    try {
      const runs = (dir: string, id?: string) =>
        runStudioAction(`${base}/api/actions${q(dir)}`, actions => actions.runs(id === undefined ? {} : { id }));
      for (const dir of [join(out, '..'), join(out, 'linked')]) await expect(runs(dir)).rejects.toThrow();
      const listed = (await runs(data)) as { run: Run; data: string }[];
      expect(listed.map(r => [r.run.id, r.data])).toEqual([['issue-1', data]]);
      expect(await runs(data, 'issue-2')).toBeNull();
      const one = (await runs(data, 'issue-1')) as { data: string; trace: { event?: { text?: string } }[] };
      expect([one.data, one.trace.find(l => l.event)?.event?.text]).toEqual([data, 'from the bench']);
      expect(
        await Effect.runPromise(runLocalActions(makeInstanceHost({ data }), actions => actions.log({ hash })))
      ).toBe('full output');
      const results = await runStudioAction(`${base}/api/actions${q(data)}`, actions => actions.results());
      expect((results as { runs: { key: string }[] }).runs.map(r => r.key)).toContain('issue-1');
      await expect(
        runStudioAction(`${base}/api/actions${q(data)}`, actions =>
          actions.label({ id: 'issue-1', patch: { arm: 'x' } })
        )
      ).rejects.toThrow('a store read through ?data= is read-only');
    } finally {
      await server.close();
      vi.unstubAllEnvs();
      rmSync(out, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
