import { useAtom, useAtomValue } from 'jotai';
import { type ReactNode, useMemo, useState } from 'react';
import type { rowsOf } from '../../../bin/bench.ts';
import { live, queryParam } from '../state.ts';
import { Button, cx, Disclosure, Field, Fields, Help, Link, Loading, Muted, Select, Tooltip } from '../ui.tsx';
import { cost, defaults, frontier, presets, type price, summarise } from './score.ts';
import { Scatter } from './Scatter.tsx';

type Row = ReturnType<typeof rowsOf>[number];

const benchAtom = live<{ rows: Row[]; prices: Parameters<typeof price>[1] }>('/core/bench');
const params = {
  w: queryParam('w'),
  x: queryParam('x'),
  repo: queryParam('repo'),
  cache: queryParam('cache'),
  infra: queryParam('infra'),
  drop: queryParam('drop'),
  point: queryParam('point'),
};
const names = Object.keys(defaults) as (keyof typeof defaults)[];
const tones: Record<string, string> = {
  opencode: 'text-sky-600 dark:text-sky-400',
  pi: 'text-violet-600 dark:text-violet-400',
  claude: 'text-amber-600 dark:text-amber-400',
  'claude-sub': 'text-orange-600 dark:text-orange-400',
};
const help: Record<keyof typeof defaults, string> = {
  test: 'Hidden tests are the test files the merged pull request added. They run on top of the arm’s change after it finished: 1 when they pass, 0 when they fail.',
  judge: 'Twice the judges’ mean preference over the human. A tie scores 1, always preferring the run scores 2.',
  suite: 'Scores 1 when both the repo’s suite and typecheck pass.',
  crit: 'Penalty: a third for each critical or high finding above the human’s count on the same case, at most 1.',
  help: 'Penalty: the full weight when the run stopped to ask one or more questions.',
};
const labels: Record<keyof typeof defaults, string> = {
  test: 'hidden tests',
  judge: 'judges',
  suite: 'suite',
  crit: '− findings',
  help: '− asking',
};
const presetHelp: Record<string, string> = {
  composite: 'The default mix of hidden tests, judges and suite.',
  'hidden tests only': 'Only hidden tests count.',
  'judges only': 'Only judges count.',
};
const terms: [string, string][] = [
  ['point', 'One harness and model on one arm, with an engine commit, hub tree and case set. Each dot is a point.'],
  [
    'arm',
    'Who made the change. human is the merged pull request. v2 is the engine with the repo’s hub, where the change must pass the hub’s checks, like the repo’s own tests, and a reviewer can send it back once. floor is one plain session in the same sandbox and budget, without checks or review.',
  ],
  ['base', 'The repo at the pull request’s parent commit, before any change.'],
  ['tree', 'The git tree hash of the hub’s files, part of a point’s key. Changing the hub creates a new point.'],
  [
    'case',
    'One merged pull request. It is valid, and kept, only when the human diff applies to base, setup works, the hidden tests fail on base and pass on the human, and the human passes the suite.',
  ],
  ['hidden tests', 'The test files the merged pull request added, placed on top of the arm’s change after it ran.'],
  ['repeats', 'A repeat runs the same case again on the same point. cases counts distinct cases, runs every kept run.'],
  [
    'infra',
    'The environment broke, or the run left an empty diff, failed setup or never finished. These runs say nothing about the agent and are left out unless they count as 0. Every other failure counts against the agent.',
  ],
  [
    'waiting',
    'A run that stopped to ask a question. The bench answers once with “No more information. Use your judgment.” and asking at all costs the full help penalty.',
  ],
  [
    'quality',
    'Per run, the weighted mean of the hidden test, judge and suite scores it has, minus penalties for extra critical or high findings and for asking. 0 is nothing useful, 1 is as good as the human.',
  ],
  [
    'judges',
    'opus and sonnet (Claude) and sol (a GPT model) compare the run’s diff with the human’s in one or both orders, with names, issue numbers and lockfiles removed. A vote for the run scores 1, a tie 0.5, a vote for the human 0.',
  ],
  [
    'chart',
    'Crosses are 95 percent intervals from a bootstrap over cases, then repeats. The line steps through the setups no cheaper setup matches in quality, and is dashed and faint while a setup on it has fewer than 10 cases. A dimmed point has a cheaper setup that matches it. A hollow point is dimmed, but its interval still reaches the line.',
  ],
];

const parse = (key: string) => {
  const [, harness = '', model = '', arm = '', engine = '', tree = '', set = ''] =
    /^(.+?):(.+?)\/(\w+)@([^/]*)\/([^/]*)\/(.*)$/.exec(key) ?? [];
  return { harness, model, arm, engine, tree, set };
};
const fmt = (v: number | undefined, digits = 2) => (v === undefined || Number.isNaN(v) ? '' : v.toFixed(digits));
const usd = (v: number) => `$${v.toFixed(3)}`;
const ci = ([lo, hi]: [number, number], f: (v: number) => string) => `${f(lo)} to ${f(hi)}`;
const kilo = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);

const Control = ({ label, tip, children }: { label: string; tip?: string; children: ReactNode }) => (
  <div className="space-y-1">
    <Tooltip tip={tip} focusable={!!tip}>
      <h3 className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">{label}</h3>
    </Tooltip>
    {children}
  </div>
);

export const BenchPage = () => {
  const { value, failure } = useAtomValue(benchAtom);
  const [w, setW] = useAtom(params.w);
  const [xAxis, setX] = useAtom(params.x);
  const [repo, setRepo] = useAtom(params.repo);
  const [cache, setCache] = useAtom(params.cache);
  const [infra, setInfra] = useAtom(params.infra);
  const [drop, setDrop] = useAtom(params.drop);
  const [picked, setPicked] = useAtom(params.point);
  const [sort, setSort] = useState<{ col: number; down: boolean }>({ col: 4, down: true });
  const weights = useMemo(() => {
    const given = w?.split(',').map(Number) ?? [];
    return Object.fromEntries(names.map((k, i) => [k, given[i] ?? defaults[k]])) as typeof defaults;
  }, [w]);
  const dropped = useMemo(() => drop?.split(',').filter(Boolean) ?? [], [drop]);
  const minutes = xAxis === 'minutes';
  const rows = value?.rows;
  const judges = useMemo(() => [...new Set(rows?.flatMap(r => Object.keys(r.vsHuman)))].sort(), [rows]);
  const repos = useMemo(() => [...new Set(rows?.flatMap(r => r.strata.repo ?? []))].sort(), [rows]);
  const points = useMemo(() => {
    if (!value) return [];
    const shown = value.rows.filter(r => !repo || r.strata.repo === repo);
    return summarise(shown, {
      w: weights,
      x: r => (minutes ? r.minutes : cost(r, value.prices, cache === 'off')),
      judges: judges.filter(j => !dropped.includes(j)),
      infraZero: infra === 'zero',
    }).filter(p => p.n > 0);
  }, [value, repo, weights, minutes, cache, judges, dropped, infra]);

  if (!value) return failure ? <Muted>{failure}</Muted> : <Loading />;
  if (!value.rows.length)
    return <Muted>No bench rows. Start the studio with --bench and one or more bench out dirs.</Muted>;

  const front = frontier(points);
  const onFront = points.filter(p => front.includes(p.key));
  const rough = onFront.some(p => p.n < 10);
  const stair = (x: number) => Math.max(-Infinity, ...onFront.filter(p => p.x <= x).map(p => p.y));
  const harnesses = new Set(points.map(p => parse(p.key).harness + parse(p.key).model));
  const label = (key: string) => {
    const p = parse(key);
    return `${harnesses.size > 1 ? `${p.harness}:${p.model} ` : ''}${p.arm} ${p.set}`;
  };
  const describe = (key: string) => {
    const p = parse(key);
    return [
      `${p.harness}:${p.model} on ${p.arm}, set ${p.set}`,
      `engine ${p.engine.slice(0, 10)}${p.tree ? `, hub tree ${p.tree.slice(0, 10)}` : ''}`,
    ].join('\n');
  };
  const xLabel = minutes ? 'minutes per task' : `notional USD per task${cache === 'off' ? ', cache off' : ''}, log`;
  const fx = (v: number) => (minutes ? `${v.toFixed(1)} min` : usd(v));
  const tokens = (rs: Row[]) => {
    const sum = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    for (const t of rs.flatMap(r => Object.values(r.tokens)))
      for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += t[k] / rs.length;
    return `tokens per run: ${kilo(Math.round(sum.input))} in, ${kilo(Math.round(sum.cacheRead))} cache read, ${kilo(Math.round(sum.cacheWrite))} cache write, ${kilo(Math.round(sum.output))} out`;
  };
  const one = points.find(p => p.key === picked);
  const columns: [
    string,
    string,
    (p: (typeof points)[number]) => number | string,
    (p: (typeof points)[number]) => ReactNode,
  ][] = [
    [
      'point',
      'The harness and model, when there are several, followed by the arm and case set.',
      p => label(p.key),
      p => (
        <Tooltip tip={describe(p.key)}>
          <span>{label(p.key)}</span>
        </Tooltip>
      ),
    ],
    ['cases', 'Distinct cases with at least one kept run.', p => p.n, p => p.n],
    ['runs', 'All kept runs, including repeats.', p => p.repeats, p => p.repeats],
    ['completion', 'The share of runs that were not infra.', p => p.completion, p => fmt(p.completion)],
    ['quality', 'Mean quality and its 95 percent interval.', p => p.y, p => `${fmt(p.y)} (${ci(p.yCi, v => fmt(v))})`],
    [
      minutes ? 'minutes, interval' : 'usd per task',
      minutes
        ? 'Minutes per task and their 95 percent interval.'
        : 'Notional USD cost per task and its 95 percent interval.',
      p => p.x,
      p => `${fx(p.x)} (${ci(p.xCi, fx)})`,
    ],
    ['minutes', 'Mean wall time per run, with time the machine slept removed.', p => p.minutes, p => fmt(p.minutes, 1)],
    ['hidden pass', 'The share of runs that pass the hidden tests.', p => p.hidden ?? -1, p => fmt(p.hidden)],
    [
      'vs human',
      'Average judge preference. 1 means always preferring the run, 0.5 parity with the human, 0 always preferring the human.',
      p => p.vsHuman ?? -1,
      p => fmt(p.vsHuman),
    ],
  ];
  const sorted = points.toSorted((a, b) => {
    const [va, vb] = [columns[sort.col]![2](a), columns[sort.col]![2](b)];
    return (va < vb ? -1 : va > vb ? 1 : 0) * (sort.down ? -1 : 1);
  });

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="shrink-0 space-y-4 overflow-y-auto border-b border-zinc-200 p-4 text-xs md:w-64 md:border-r md:border-b-0 dark:border-zinc-800">
        <Control label="Weights" tip="Each run’s quality is the weighted mean of the parts it has, minus penalties.">
          <div className="flex flex-wrap gap-1">
            {Object.entries(presets).map(([name, p]) => (
              <Tooltip key={name} tip={presetHelp[name]}>
                <Button
                  aria-pressed={names.every(k => p[k] === weights[k])}
                  className="aria-pressed:border-zinc-500 aria-pressed:text-zinc-900 dark:aria-pressed:text-zinc-100"
                  onClick={() => setW(p === defaults ? null : names.map(k => p[k]).join(','))}
                >
                  {name}
                </Button>
              </Tooltip>
            ))}
          </div>
          {names.map(k => (
            <div key={k} className="w-full">
              <label className="grid w-full grid-cols-[6.5rem_1fr_2.25rem] items-center gap-2 font-mono text-zinc-600 dark:text-zinc-400">
                <span className="inline-flex items-center gap-1">
                  {labels[k]} <Help tip={help[k]} />
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={weights[k]}
                  onChange={e => setW(names.map(n => (n === k ? e.target.value : weights[n])).join(','))}
                  className="accent-zinc-700 dark:accent-zinc-300"
                />
                <span className="text-right tabular-nums">{weights[k].toFixed(2)}</span>
              </label>
            </div>
          ))}
        </Control>
        <Control
          label="Axis"
          tip="Cost prices each run’s tokens at list price, with their own rates for cache reads and writes, or takes the cost the harness reported when there are no tokens. Cache off prices cache reads and writes as plain input. Minutes are wall time, with time the machine slept removed."
        >
          <Select
            label="x"
            value={minutes ? 'minutes' : cache === 'off' ? 'off' : 'usd'}
            options={[
              { value: 'usd', label: 'cost, list price' },
              { value: 'off', label: 'cost, cache off' },
              { value: 'minutes', label: 'minutes' },
            ]}
            onChange={v => {
              setX(v === 'minutes' ? 'minutes' : null);
              setCache(v === 'off' ? 'off' : null);
            }}
          />
          {!minutes && value.prices.asOf && <p className="text-zinc-500">Prices as of {value.prices.asOf}.</p>}
        </Control>
        <Control label="Filter" tip="Show only cases from one repo, and choose how infra runs count.">
          <Select
            label="repo"
            value={repo ?? ''}
            options={[
              { value: '', label: 'every repo' },
              ...repos.map(r => ({ value: r, label: r.split('/').pop()! })),
            ]}
            onChange={v => setRepo(v || null)}
          />
          <Tooltip tip="Give infra runs a quality of 0 instead of leaving them out.">
            <label className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
              <input
                type="checkbox"
                checked={infra === 'zero'}
                onChange={e => setInfra(e.target.checked ? 'zero' : null)}
              />
              infra runs count as 0
            </label>
          </Tooltip>
        </Control>
        <Control
          label="Judges"
          tip="Untick a judge to remove its votes, for example to check whether it favours its own model family."
        >
          {judges.map(j => (
            <label key={j} className="flex items-center gap-1.5 font-mono text-zinc-600 dark:text-zinc-400">
              <input
                type="checkbox"
                checked={!dropped.includes(j)}
                onChange={e =>
                  setDrop((e.target.checked ? dropped.filter(d => d !== j) : [...dropped, j]).join(',') || null)
                }
              />
              {j}
            </label>
          ))}
        </Control>
      </aside>
      <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-4">
        <section className="max-w-3xl">
          <p className="mb-2 text-xs text-pretty text-zinc-600 dark:text-zinc-400">
            Each point is one setup: a harness and model on one arm and case set. Across is{' '}
            {minutes ? 'minutes' : 'cost'} per task, up is quality, where the human’s merged pull request scores 1. Up
            and to the left is better, and the line steps through the setups no cheaper setup matches in quality. This
            chart does not show change over time, the{' '}
            <Link
              href="/compound"
              className="underline underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-100"
            >
              Compound
            </Link>{' '}
            tab does.
          </p>
          <Scatter
            log={!minutes}
            xLabel={xLabel}
            yLabel="quality, human = 1"
            xTip={
              minutes
                ? 'Minutes per task, averaged over repeats within each case, then over cases.'
                : 'Notional USD cost per task on a log scale, averaged over repeats within each case, then over cases.'
            }
            yTip="Quality per task, averaged over repeats within each case, then over cases. 0 means nothing useful, 1 means as good as the human."
            hTip="The human’s quality is 1 by definition."
            hLine={1}
            line={onFront}
            rough={rough}
            note={rough ? 'few cases, the line is rough' : undefined}
            picked={picked ?? undefined}
            onPick={key => setPicked(key === picked ? null : key)}
            dots={points.map(p => {
              const { harness, arm } = parse(p.key);
              const dominated = !front.includes(p.key);
              return {
                key: p.key,
                x: p.x,
                y: p.y,
                xCi: p.xCi,
                yCi: p.yCi,
                label: label(p.key),
                tone: tones[harness] ?? 'text-zinc-600 dark:text-zinc-400',
                square: arm === 'floor',
                dim: dominated,
                open: dominated && p.yCi[1] >= stair(p.x),
                tip: [
                  label(p.key),
                  `quality ${fmt(p.y)} (${ci(p.yCi, v => fmt(v))})`,
                  `${fx(p.x)} per task (${ci(p.xCi, fx)})`,
                  `${p.n} cases, ${p.repeats} runs, ${fmt(p.completion * 100, 0)}% complete`,
                  `${fmt(p.minutes, 1)} min, reported ${usd(mean(p.perCase.map(s => s.row.usd ?? 0)))} per run`,
                  tokens(p.perCase.map(s => s.row)),
                  dominated && p.yCi[1] >= stair(p.x) ? 'within noise of the frontier' : '',
                ]
                  .filter(Boolean)
                  .join('\n'),
              };
            })}
          />
          <p className="mt-1 text-[11px] text-zinc-500">
            Circles are v2, the engine with its checks and review. Squares are floor, one plain session without them.
            Click a point to see its runs. The terms below explain the rest.
          </p>
          <Disclosure summary="What the terms mean" className="mt-2 text-[11px] text-zinc-500">
            <div className="mt-1 max-w-2xl">
              <Fields>
                {terms.map(([term, meaning]) => (
                  <Field key={term} name={<span className="font-mono">{term}</span>}>
                    {meaning}
                  </Field>
                ))}
              </Fields>
            </div>
          </Disclosure>
        </section>
        {one && (
          <section className="max-w-3xl">
            <Tooltip
              tip="Each dot is one run. Green means hidden tests passed, red means they failed, and grey means infra or no hidden tests."
              focusable
            >
              <h3 className="text-xs font-medium">{label(one.key)}, per case</h3>
            </Tooltip>
            <Scatter
              log={!minutes}
              height={200}
              xLabel={xLabel}
              yLabel="quality"
              hLine={1}
              dots={one.perCase.map(({ row, x, y }) => ({
                key: `${row.case}/${row.repeat}`,
                x,
                y,
                tone:
                  row.infra || row.hidden === undefined
                    ? 'text-zinc-400 dark:text-zinc-500'
                    : row.hidden
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-rose-500 dark:text-rose-400',
                tip: [
                  `${row.case}${row.repeat > 1 ? `, repeat ${row.repeat}` : ''}`,
                  row.infra
                    ? `infra: ${row.infra}`
                    : row.hidden === undefined
                      ? 'judged only'
                      : row.hidden
                        ? 'hidden tests pass'
                        : 'hidden tests fail',
                  `quality ${fmt(y)}, ${fx(x)}`,
                  Object.entries(row.vsHuman)
                    .map(([j, v]) => `${j} ${fmt(v)}`)
                    .join(', '),
                ]
                  .filter(Boolean)
                  .join('\n'),
              }))}
            />
          </section>
        )}
        <div className="overflow-x-auto">
          <table className="w-full max-w-5xl text-left text-xs whitespace-nowrap tabular-nums">
            <thead className="text-zinc-500">
              <tr className="border-b border-zinc-200 dark:border-zinc-800">
                {columns.map(([name, tip], i) => (
                  <th key={name} className="py-1 pr-3 font-medium">
                    <Tooltip tip={tip} action="Sort by this column">
                      <button
                        type="button"
                        onClick={() => setSort({ col: i, down: sort.col === i ? !sort.down : true })}
                        className="transition-colors duration-150 hover:text-zinc-900 dark:hover:text-zinc-100"
                      >
                        {name}
                        {sort.col === i && (sort.down ? ' ↓' : ' ↑')}
                      </button>
                    </Tooltip>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map(p => (
                <tr
                  key={p.key}
                  onClick={() => setPicked(p.key === picked ? null : p.key)}
                  className={cx(
                    'cursor-pointer border-b border-zinc-100 transition-colors duration-150 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900',
                    p.key === picked && 'bg-zinc-100 dark:bg-zinc-800'
                  )}
                >
                  {columns.map(([name, , , show]) => (
                    <td key={name} className={cx('py-1 pr-3', name === 'point' && 'font-mono')}>
                      {show(p)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);
