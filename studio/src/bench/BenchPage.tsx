import { useAtom, useAtomValue } from 'jotai';
import { type ReactNode, useMemo, useState } from 'react';
import type { DriveState } from '../../../bench/drive.ts';
import type { readBenchRows } from '../../../bin/bench.ts';
import { makeLiveJsonAtom, queryParam } from '../state.ts';
import { Button, cx, Disclosure, Field, Fields, Help, Link, Loading, Muted, Select, Tooltip } from '../ui.tsx';
import { cost, defaultBenchScoreWeights, frontier, presets, type price, summarise } from './score.ts';
import { Scatter } from './Scatter.tsx';

type Row = ReturnType<typeof readBenchRows>[number];

const benchAtom = makeLiveJsonAtom<{ rows: Row[]; drives?: DriveState[]; prices: Parameters<typeof price>[1] }>(
  '/api/bench'
);
const params = {
  w: queryParam('w'),
  x: queryParam('x'),
  repo: queryParam('repo'),
  cache: queryParam('cache'),
  infra: queryParam('infra'),
  drop: queryParam('drop'),
  point: queryParam('point'),
};
const names = Object.keys(defaultBenchScoreWeights) as (keyof typeof defaultBenchScoreWeights)[];
const tones: Record<string, string> = {
  opencode: 'text-sky-600 dark:text-sky-400',
  pi: 'text-violet-600 dark:text-violet-400',
  claude: 'text-amber-600 dark:text-amber-400',
  'claude-sub': 'text-orange-600 dark:text-orange-400',
};
const help: Record<keyof typeof defaultBenchScoreWeights, string> = {
  test: 'Test files added by the merged pull request, run on the arm’s finished change. Passing scores 1, failing scores 0.',
  judge:
    'LLM judges compare the run’s diff with the human’s merged diff, blind. For quality, always preferring the human scores 0 and a tie scores 1, the human’s level. Preferring the run counts no higher than a tie, so judged and tested parts share one scale. Cases without hidden tests show as their own judge-only point.',
  suite: 'The repo’s own test suite and typecheck, run on the arm’s change: 1 when both pass.',
  crit: 'Penalty: a third for each critical or high finding above the human’s count on the same case, at most 1.',
  help: 'Penalty: the full weight when the run stopped to ask one or more questions.',
};
const labels: Record<keyof typeof defaultBenchScoreWeights, string> = {
  test: 'hidden tests',
  judge: 'LLM judges',
  suite: 'CI',
  crit: '− findings',
  help: '− asking',
};
const presetHelp: Record<string, string> = {
  composite: 'The default mix of hidden tests, judges and suite.',
  'hidden tests only': 'Only hidden tests count.',
  'judges only': 'Only judges count.',
};
const arm =
  'How the change is made. v2 uses the engine and repo’s hub, with checks and one chance for a reviewer to send it back. floor is one plain agent session with the same sandbox and budget, without checks or review. human is the merged pull request. Circles show v2, squares show floor.';
const set =
  'A pinned list of cases. Compare points on the same set. core uses real merged pull requests from the org’s repos. smoke uses three small, fast core cases for quick checks.';
const terms: [string, ReactNode][] = [
  ['arm', arm],
  ['case set', set],
  ['base', 'The repo at the pull request’s parent commit, before any change.'],
  ['tree', 'The git tree hash of the hub’s files, part of a point’s key. Changing the hub creates a new point.'],
  [
    'case',
    'One merged pull request. It is valid, and kept, only when the human diff applies to base, setup works, the hidden tests fail on base and pass on the human, and the human passes the suite.',
  ],
  ['repeats', 'Running the same case again on the same point.'],
  [
    'infra',
    'The environment failed the run: the proxy, docker or the machine broke, scoring setup failed, or the run never finished. These runs are left out by default. Every other failure counts against the agent, and a run that changed nothing scores 0.',
  ],
  ['waiting', 'A run stopped to ask a question. The bench answers once: “No more information. Use your judgment.”'],
  [
    'judges',
    'opus and sonnet are Claude models. sol is a GPT model. They see the diffs in one or both orders, with names, issue numbers and lockfiles removed.',
  ],
  [
    'chart',
    <>
      Higher and further left is better. The line joins setups whose quality no cheaper setup matches. It is faint and
      dashed if any setup on it has fewer than 10 cases. Dimmed points have a cheaper match or are judge-only, which
      judges alone score, so they stay off the line. Hollow points are dimmed but their quality interval still reaches
      the line. Crosses show 95 percent intervals from a bootstrap over cases, then repeats. This chart compares setups.
      The{' '}
      <Link href="/compound" className="underline underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-100">
        Compound
      </Link>{' '}
      tab shows change over time.
    </>,
  ],
];

/** Judges outside the default panel, unticked unless the page says otherwise. */
const unpanelled = 'sol';

const parse = (key: string) => {
  const [, harness = '', model = '', arm = '', engine = '', tree = '', set = ''] =
    /^(.+?):(.+?)\/(\w+)@([^/]*)\/([^/]*)\/(.*)$/.exec(key) ?? [];
  return { harness, model, arm, engine, tree, set };
};
const fmt = (v: number | undefined, digits = 2) => (v === undefined || Number.isNaN(v) ? '' : v.toFixed(digits));
const usd = (v: number) => `$${v.toFixed(3)}`;
const ci = ([lo, hi]: [number, number], f: (v: number) => string) => `${f(lo)} to ${f(hi)}`;
const kilo = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);

const statusTones: Record<DriveState['status'], string> = {
  running: 'text-sky-600 dark:text-sky-400',
  paused: 'text-amber-600 dark:text-amber-400',
  stopped: 'text-zinc-600 dark:text-zinc-400',
  crashed: 'text-rose-600 dark:text-rose-400',
  finished: 'text-emerald-600 dark:text-emerald-400',
};

/** Every driven bench dir with its progress and, when it is not running, why. */
const Benches = ({ drives }: { drives: DriveState[] }) =>
  drives.length ? (
    <section className="max-w-5xl overflow-x-auto">
      <Tooltip
        tip="Bench dirs a driver runs. Resume a paused, stopped or crashed one with node bench/drive.ts resume <dir>; finished jobs are kept and never rerun."
        focusable
      >
        <h3 className="mb-1 text-xs font-medium">Benches</h3>
      </Tooltip>
      <table className="w-full text-left text-xs tabular-nums">
        <thead className="text-zinc-500">
          <tr className="border-b border-zinc-200 dark:border-zinc-800">
            {['bench', 'status', 'done', 'partial', 'since', 'reason'].map(h => (
              <th key={h} className="py-1 pr-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {drives.map(d => (
            <tr key={d.dir} className="border-b border-zinc-100 dark:border-zinc-900">
              <td className="py-1 pr-3 font-mono whitespace-nowrap" title={d.dir}>
                {d.dir.split('/').pop()}
              </td>
              <td className={cx('py-1 pr-3', statusTones[d.status])}>{d.status}</td>
              <td className="py-1 pr-3 whitespace-nowrap">
                {d.done}/{d.total}
              </td>
              <td className="py-1 pr-3">{d.partial || ''}</td>
              <td className="py-1 pr-3 whitespace-nowrap">{d.at?.slice(0, 16).replace('T', ' ') ?? ''}</td>
              <td className="py-1 pr-3 text-zinc-600 dark:text-zinc-400">{d.reason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  ) : null;

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
  const [sort, setSort] = useState({ col: 'quality', down: true });
  const weights = useMemo(() => {
    const given = w?.split(',').map(Number) ?? [];
    return Object.fromEntries(
      names.map((k, i) => [k, given[i] ?? defaultBenchScoreWeights[k]])
    ) as typeof defaultBenchScoreWeights;
  }, [w]);
  const dropped = useMemo(() => (drop ?? unpanelled).split(',').filter(Boolean), [drop]);
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
    return value.drives?.length ? (
      <div className="p-4">
        <Benches drives={value.drives} />
      </div>
    ) : (
      <Muted>No bench rows. Start the studio with --bench and one or more bench out dirs.</Muted>
    );

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
  type Point = (typeof points)[number];
  const all: [string, string, (p: Point) => number | string, (p: Point) => ReactNode][] = [
    [
      'point',
      'Each dot is one harness and model on one arm, with an engine commit, hub tree and case set. Labels show the arm and case set, plus the harness and model when there are several.',
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
    [
      'quality',
      'Mean quality and its 95 percent interval. Each run uses the weighted mean of its available hidden test, judge and CI scores, minus the findings and asking penalties. 0 means nothing useful.',
      p => p.y,
      p => `${fmt(p.y)} (${ci(p.yCi, v => fmt(v))})`,
    ],
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
      'Average judge vote, before doubling for quality. A vote for the run scores 1, a tie 0.5, a vote for the human 0.',
      p => p.vsHuman ?? -1,
      p => fmt(p.vsHuman),
    ],
  ];
  const columns = all.filter(([name]) => !(minutes && name === 'minutes'));
  const by = (columns.find(([name]) => name === sort.col) ?? columns.find(([name]) => name === 'quality')!)[2];
  const sorted = points.toSorted((a, b) => {
    const [va, vb] = [by(a), by(b)];
    return (va < vb ? -1 : va > vb ? 1 : 0) * (sort.down ? -1 : 1);
  });

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="shrink-0 space-y-4 overflow-y-auto border-b border-zinc-200 p-4 text-xs md:w-64 md:border-r md:border-b-0 dark:border-zinc-800">
        <Control label="Weights" tip="Choose a preset or adjust how much each score and penalty counts.">
          <div className="flex flex-wrap gap-1">
            {Object.entries(presets).map(([name, p]) => (
              <Tooltip key={name} tip={presetHelp[name]}>
                <Button
                  aria-pressed={names.every(k => p[k] === weights[k])}
                  className="aria-pressed:border-zinc-500 aria-pressed:text-zinc-900 dark:aria-pressed:text-zinc-100"
                  onClick={() => setW(p === defaultBenchScoreWeights ? null : names.map(k => p[k]).join(','))}
                >
                  {name}
                </Button>
              </Tooltip>
            ))}
          </div>
          {names.map(k => (
            <div
              key={k}
              className="grid w-full grid-cols-[6rem_0.875rem_1fr_2rem] items-center gap-x-1.5 font-mono text-zinc-600 dark:text-zinc-400"
            >
              <label htmlFor={`w-${k}`} className="whitespace-nowrap">
                {labels[k]}
              </label>
              <Help tip={help[k]} />
              <input
                id={`w-${k}`}
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={weights[k]}
                onChange={e => setW(names.map(n => (n === k ? e.target.value : weights[n])).join(','))}
                className="w-full min-w-0 accent-zinc-700 dark:accent-zinc-300"
              />
              <span className="text-right tabular-nums">{weights[k].toFixed(2)}</span>
            </div>
          ))}
        </Control>
        <Control
          label="Axis"
          tip={`Cost prices each run’s tokens at list price, with separate rates for cache reads and writes. Without tokens, it uses the cost reported by the harness. Cache off prices cache reads and writes as plain input. Minutes are wall time with machine sleep removed.${!minutes && value.prices.asOf ? ` Prices as of ${value.prices.asOf}.` : ''}`}
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
                onChange={e => {
                  const next = (e.target.checked ? dropped.filter(d => d !== j) : [...dropped, j]).join(',');
                  setDrop(next === unpanelled ? null : next);
                }}
              />
              {j}
            </label>
          ))}
        </Control>
      </aside>
      <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-4">
        <Benches drives={value.drives ?? []} />
        <section className="max-w-3xl">
          <p className="mb-2 text-xs text-pretty text-zinc-600 dark:text-zinc-400">
            Each point is a harness and model running one arm <Help tip={arm} /> on one case set <Help tip={set} />. The
            human’s merged pull request is the baseline and scores 1.
          </p>
          <Scatter
            log={!minutes}
            xLabel={xLabel}
            yLabel="quality"
            xTip={
              minutes
                ? 'Minutes per task, averaged over repeats within each case, then over cases.'
                : 'Notional USD cost per task on a log scale, averaged over repeats within each case, then over cases.'
            }
            yTip="Quality per task, averaged over repeats within each case, then over cases."
            hTip="The human baseline."
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
                open: dominated && !p.judgeOnly && p.yCi[1] >= stair(p.x),
                tip: [
                  label(p.key),
                  `quality ${fmt(p.y)} (${ci(p.yCi, v => fmt(v))})`,
                  `${fx(p.x)} per task (${ci(p.xCi, fx)})`,
                  `${p.n} cases, ${p.repeats} runs, ${fmt(p.completion * 100, 0)}% complete`,
                  `${fmt(p.minutes, 1)} min, reported ${usd(mean(p.perCase.map(s => s.row.usd ?? 0)))} per run`,
                  tokens(p.perCase.map(s => s.row)),
                  p.perCase.some(s => s.row.usdSource === 'list-price estimate')
                    ? 'paid by a subscription: the cost is a list-price estimate'
                    : '',
                  p.judgeOnly
                    ? 'judges alone score these cases, so the point stays off the line'
                    : dominated && p.yCi[1] >= stair(p.x)
                      ? 'within noise of the frontier'
                      : '',
                ]
                  .filter(Boolean)
                  .join('\n'),
              };
            })}
          />
          <p className="mt-1 text-[11px] text-zinc-500">Click a point to see its runs.</p>
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
                {columns.map(([name, tip]) => (
                  <th key={name} className="py-1 pr-3 font-medium">
                    <Tooltip tip={tip} action="Sort by this column">
                      <button
                        type="button"
                        onClick={() => setSort({ col: name, down: sort.col === name ? !sort.down : true })}
                        className="transition-colors duration-150 hover:text-zinc-900 dark:hover:text-zinc-100"
                      >
                        {name}
                        {sort.col === name && (sort.down ? ' ↓' : ' ↑')}
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
