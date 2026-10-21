import { useAtom, useAtomValue } from 'jotai';
import { type ReactNode, useMemo, useState } from 'react';
import type { rowsOf } from '../../../bin/bench.ts';
import { live, queryParam } from '../state.ts';
import { Button, cx, Loading, Muted, Select, Tooltip } from '../ui.tsx';
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
  test: 'Hidden tests pass: 0 or 1',
  judge: 'Twice the judges’ mean preference over the human, so parity is 1',
  suite: 'Suite and typecheck both pass',
  crit: 'Penalty: critical and high findings above the human’s, a third per finding, at most 1',
  help: 'Penalty: the run asked the human',
};

const parse = (key: string) => {
  const [, harness = '', model = '', arm = '', engine = '', set = ''] =
    /^(.+?):(.+?)\/(\w+)@([^/]*)\/[^/]*\/(.*)$/.exec(key) ?? [];
  return { harness, model, arm, engine, set };
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
  const drawn = onFront.length > 0 && onFront.every(p => p.n >= 10);
  const stair = (x: number) => Math.max(-Infinity, ...onFront.filter(p => p.x <= x).map(p => p.y));
  const harnesses = new Set(points.map(p => parse(p.key).harness + parse(p.key).model));
  const label = (key: string) => {
    const p = parse(key);
    return `${harnesses.size > 1 ? `${p.harness}:${p.model} ` : ''}${p.arm} ${p.set}`;
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
    (p: (typeof points)[number]) => number | string,
    (p: (typeof points)[number]) => ReactNode,
  ][] = [
    ['point', p => label(p.key), p => label(p.key)],
    ['cases', p => p.n, p => p.n],
    ['runs', p => p.repeats, p => p.repeats],
    ['completion', p => p.completion, p => fmt(p.completion)],
    ['quality', p => p.y, p => `${fmt(p.y)} (${ci(p.yCi, v => fmt(v))})`],
    [minutes ? 'minutes, interval' : 'usd per task', p => p.x, p => `${fx(p.x)} (${ci(p.xCi, fx)})`],
    ['minutes', p => p.minutes, p => fmt(p.minutes, 1)],
    ['hidden pass', p => p.hidden ?? -1, p => fmt(p.hidden)],
    ['vs human', p => p.vsHuman ?? -1, p => fmt(p.vsHuman)],
  ];
  const sorted = points.toSorted((a, b) => {
    const [va, vb] = [columns[sort.col]![1](a), columns[sort.col]![1](b)];
    return (va < vb ? -1 : va > vb ? 1 : 0) * (sort.down ? -1 : 1);
  });

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="shrink-0 space-y-4 overflow-y-auto border-b border-zinc-200 p-4 text-xs md:w-64 md:border-r md:border-b-0 dark:border-zinc-800">
        <Control label="Weights" tip="Quality per case: the weighted mean of the parts it has, less the penalties">
          <div className="flex flex-wrap gap-1">
            {Object.entries(presets).map(([name, p]) => (
              <Button
                key={name}
                aria-pressed={names.every(k => p[k] === weights[k])}
                className="aria-pressed:border-zinc-500 aria-pressed:text-zinc-900 dark:aria-pressed:text-zinc-100"
                onClick={() => setW(p === defaults ? null : names.map(k => p[k]).join(','))}
              >
                {name}
              </Button>
            ))}
          </div>
          {names.map(k => (
            <Tooltip key={k} tip={help[k]} className="w-full">
              <label className="grid w-full grid-cols-[2.5rem_1fr_2.25rem] items-center gap-2 font-mono text-zinc-600 dark:text-zinc-400">
                {k}
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
            </Tooltip>
          ))}
        </Control>
        <Control label="Axis">
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
        <Control label="Filter">
          <Select
            label="repo"
            value={repo ?? ''}
            options={[
              { value: '', label: 'every repo' },
              ...repos.map(r => ({ value: r, label: r.split('/').pop()! })),
            ]}
            onChange={v => setRepo(v || null)}
          />
          <label className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={infra === 'zero'}
              onChange={e => setInfra(e.target.checked ? 'zero' : null)}
            />
            infra runs count as 0
          </label>
        </Control>
        <Control label="Judges" tip="Drop a judge to check for self-preference">
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
          <Scatter
            log={!minutes}
            xLabel={xLabel}
            yLabel="quality, human = 1"
            hLine={1}
            line={drawn ? onFront : []}
            note={drawn ? undefined : 'n too small for a frontier'}
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
            Circles are v2, squares the floor. Crosses are 95% intervals over cases and repeats. Dimmed points are
            dominated; an open one is within noise of the frontier. Click a point for its cases.
          </p>
        </section>
        {one && (
          <section className="max-w-3xl">
            <h3 className="text-xs font-medium">{label(one.key)}, per case</h3>
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
                {columns.map(([name], i) => (
                  <th key={name} className="py-1 pr-3 font-medium">
                    <button
                      type="button"
                      onClick={() => setSort({ col: i, down: sort.col === i ? !sort.down : true })}
                      className="transition-colors duration-150 hover:text-zinc-900 dark:hover:text-zinc-100"
                    >
                      {name}
                      {sort.col === i && (sort.down ? ' ↓' : ' ↑')}
                    </button>
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
                  {columns.map(([name, , show]) => (
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
