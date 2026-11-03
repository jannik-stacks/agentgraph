import { useAtom } from 'jotai';
import { Schema } from 'effect';
import { type ReactNode, useMemo } from 'react';
import type { DriveState } from '../../../bench/drive.ts';
import { getMean } from '../../../src/stats.ts';
import { queryParam } from '../state.ts';
import { usePluginData } from '../plugins.ts';
import { BenchData, type BenchRow as Row } from './data.ts';
import { Button, cx, Disclosure, Field, Fields, Help, Loading, Muted, Select, Tooltip } from '../ui.tsx';
import { cost, defaultBenchBy, defaultBenchScoreWeights, frontier, presets, roughBelow, summarise } from './score.ts';
import { Forest } from './Forest.tsx';
import { Scatter } from './Scatter.tsx';
import { readBenchRowResults, type RunResults } from '../results/result.ts';
import { findCheckFields } from '../../../src/results.ts';
import { ResultTable } from '../results/ResultTable.tsx';

const params = {
  w: queryParam('w'),
  x: queryParam('x'),
  where: queryParam('where'),
  by: queryParam('by'),
  color: queryParam('color'),
  cache: queryParam('cache'),
  infra: queryParam('infra'),
  drop: queryParam('drop'),
  point: queryParam('point'),
};
const names = Object.keys(defaultBenchScoreWeights) as (keyof typeof defaultBenchScoreWeights)[];
const tones = [
  'text-sky-600 dark:text-sky-400',
  'text-violet-600 dark:text-violet-400',
  'text-amber-600 dark:text-amber-400',
  'text-orange-600 dark:text-orange-400',
  'text-emerald-600 dark:text-emerald-400',
  'text-rose-600 dark:text-rose-400',
];
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
  'How the change is made. v2 uses the engine and repo’s graph, with checks and one chance for a reviewer to send it back. floor is one plain agent session with the same sandbox and budget, without checks or review. human is the merged pull request. Circles show v2, squares show floor.';
const set =
  'A pinned list of cases. Compare points on the same set. core uses real merged pull requests from the org’s repos. smoke uses three small, fast core cases for quick checks.';
const terms: [string, ReactNode][] = [
  ['arm', arm],
  ['case set', set],
  ['base', 'The repo at the pull request’s parent commit, before any change.'],
  ['tree', 'The git tree hash of the graph’s files, part of a point’s key. Changing the graph creates a new point.'],
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
      the line. Crosses show 95 percent intervals from a bootstrap over cases, then repeats.
    </>,
  ],
];

const BenchResults = ({ runs }: { runs: RunResults[] }) => {
  const fields = findCheckFields(runs).filter(f => f.check !== 'bench');
  if (!fields.length) return null;
  return (
    <section>
      <ResultTable runs={runs} fields={fields} by="point" />
    </section>
  );
};

const unpanelled = 'sol';

const fmt = (v: number | undefined, digits = 2) => (v === undefined || Number.isNaN(v) ? '' : v.toFixed(digits));
const usd = (v: number) => `$${v.toFixed(3)}`;
const ci = ([lo, hi]: [number, number], f: (v: number) => string) => `${f(lo)} to ${f(hi)}`;
const kilo = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);

const tokens = (rs: Row[]) => {
  const sum = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const t of rs.flatMap(r => Object.values(r.tokens)))
    for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += t[k] / rs.length;
  return `tokens per run: ${kilo(Math.round(sum.input))} in, ${kilo(Math.round(sum.cacheRead))} cache read, ${kilo(Math.round(sum.cacheWrite))} cache write, ${kilo(Math.round(sum.output))} out`;
};
const unpricedModels = (rs: Row[]) => {
  const missing = [...new Set(rs.flatMap(r => r.unpriced ?? []))];
  return missing.length ? `no list price for ${missing.join(', ')}, counted as $0` : '';
};

const statusTones: Record<DriveState['status'], string> = {
  running: 'text-sky-600 dark:text-sky-400',
  paused: 'text-amber-600 dark:text-amber-400',
  stopped: 'text-zinc-600 dark:text-zinc-400',
  crashed: 'text-rose-600 dark:text-rose-400',
  finished: 'text-emerald-600 dark:text-emerald-400',
};

const Benches = ({ drives }: { drives: readonly DriveState[] }) =>
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

const LabelChoices = ({
  values,
  selected,
  onChange,
}: {
  values: string[];
  selected: string[];
  onChange: (values: string[]) => void;
}) => (
  <div className="max-h-40 overflow-y-auto">
    {values.map(v => (
      <label key={v} className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={selected.includes(v)}
          onChange={e => onChange(e.target.checked ? [...selected, v] : selected.filter(s => s !== v))}
        />
        {v || '(empty)'}
      </label>
    ))}
  </div>
);

const BenchPage = () => {
  const { value, failure } = usePluginData('bench', BenchData);
  const [w, setW] = useAtom(params.w);
  const [xAxis, setX] = useAtom(params.x);
  const [whereParam, setWhere] = useAtom(params.where);
  const [byParam, setBy] = useAtom(params.by);
  const [colorParam, setColor] = useAtom(params.color);
  const where = useMemo(
    () =>
      Schema.decodeUnknownSync(
        Schema.Record({ key: Schema.String, value: Schema.mutable(Schema.Array(Schema.String)) })
      )(JSON.parse(whereParam ?? '{}')),
    [whereParam]
  );
  const groupKeys = useMemo(() => (byParam === null ? defaultBenchBy : byParam.split(',').filter(Boolean)), [byParam]);
  const color = colorParam ?? 'harness';
  const [cache, setCache] = useAtom(params.cache);
  const [infra, setInfra] = useAtom(params.infra);
  const [drop, setDrop] = useAtom(params.drop);
  const [picked, setPicked] = useAtom(params.point);
  const weights = useMemo(() => {
    const given = w?.split(',').map(Number) ?? [];
    return Object.fromEntries(
      names.map((k, i) => [k, given[i] ?? defaultBenchScoreWeights[k]])
    ) as typeof defaultBenchScoreWeights;
  }, [w]);
  const dropped = useMemo(() => (drop ?? unpanelled).split(',').filter(Boolean), [drop]);
  const minutes = xAxis === 'minutes';
  const rows = value?.rows;
  const judges = useMemo(() => [...new Set(rows?.flatMap(r => Object.keys(r.vsHuman)))].toSorted(), [rows]);
  const labelKeys = useMemo(() => [...new Set(rows?.flatMap(r => Object.keys(r.labels)))].toSorted(), [rows]);
  const points = useMemo(() => {
    if (!value) return [];
    return summarise(value.rows, {
      where,
      by: groupKeys,
      color,
      w: weights,
      x: r => (minutes ? r.minutes : cost(r, cache === 'off')),
      judges: judges.filter(j => !dropped.includes(j)),
      infraZero: infra === 'zero',
    }).filter(p => p.n > 0);
  }, [value, where, groupKeys, color, weights, minutes, cache, judges, dropped, infra]);

  if (!value) return failure ? <Muted>{failure}</Muted> : <Loading />;
  if (!value.rows.length)
    return value.drives.length ? (
      <div className="p-4">
        <Benches drives={value.drives} />
      </div>
    ) : (
      <Muted>No bench rows. Start the studio with --bench and one or more bench out dirs.</Muted>
    );

  const oneSet = new Set(points.map(p => p.labels.set)).size === 1;
  const front = oneSet ? frontier(points) : [];
  const onFront = points.filter(p => front.includes(p.key));
  const rough = onFront.some(p => p.n < roughBelow);
  const stair = (x: number) => Math.max(-Infinity, ...onFront.filter(p => p.x <= x).map(p => p.y));
  const varying = [...new Set(points.flatMap(p => Object.keys(p.labels)))].filter(
    k => new Set(points.map(p => p.labels[k])).size > 1
  );
  const label = (p: (typeof points)[number]) =>
    varying
      .map(k => p.labels[k] ?? '(missing)')
      .map(v => (/^[0-9a-f]{7,}$/.test(v) ? v.slice(0, 6) : v))
      .join(' / ') || 'all runs';
  const colors = [...new Set(points.map(p => p.labels[color]))].toSorted();
  const tone = (v: string | undefined) =>
    color ? tones[colors.indexOf(v) % tones.length]! : 'text-zinc-600 dark:text-zinc-400';
  const xLabel = minutes ? 'minutes per task' : `notional USD per task${cache === 'off' ? ', cache off' : ''}, log`;
  const fx = (v: number) => (minutes ? `${v.toFixed(1)} min` : usd(v));

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
          tip="Cost prices each run’s tokens at the public API list price from LiteLLM’s table, with separate rates for cache reads and writes, for every model, subscriptions and free ones included. A model the table lacks is named in the point’s tip. Without tokens, it uses the cost the run recorded. Cache off prices cache reads and writes as plain input. Checking cost is apart. Minutes are wall time with machine sleep removed."
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
        <Control
          label="Where"
          tip="Values within a label are alternatives; labels must all match. Clear a selection to include every value."
        >
          {whereParam && <Button onClick={() => setWhere(null)}>clear filters</Button>}
          {labelKeys.map(k => (
            <Disclosure key={k} summary={`${k}${where[k]?.length ? ` (${where[k]!.join(', ')})` : ''}`}>
              <LabelChoices
                values={[...new Set(rows?.flatMap(r => (r.labels[k] === undefined ? [] : [r.labels[k]!])))].toSorted()}
                selected={where[k] ?? []}
                onChange={vs =>
                  setWhere(
                    JSON.stringify(
                      Object.fromEntries(Object.entries({ ...where, [k]: vs }).filter(([, vs]) => vs.length))
                    )
                  )
                }
              />
            </Disclosure>
          ))}
        </Control>
        <Control
          label="By"
          tip="Select the labels that define each chart point. Colour also splits points. Judge-only cases stay separate."
        >
          <LabelChoices values={labelKeys} selected={groupKeys} onChange={vs => setBy(vs.join(','))} />
          <Select
            label="color"
            value={color}
            options={[{ value: '', label: 'no colour' }, ...labelKeys.map(k => ({ value: k, label: k }))]}
            onChange={setColor}
          />
          {color && (
            <div>
              {colors.map(v => (
                <span key={JSON.stringify(v ?? null)} className={cx('mr-2', tone(v))}>
                  {v ?? '(missing)'}
                </span>
              ))}
            </div>
          )}
        </Control>
        <Control label="Infra">
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
        <Benches drives={value.drives} />
        <section className="max-w-3xl">
          <p className="mb-2 text-xs text-pretty text-zinc-600 dark:text-zinc-400">
            Each point groups the selected labels. The human’s merged pull request is the baseline and scores 1.
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
            note={
              oneSet ? (rough ? 'few cases, the line is rough' : undefined) : 'pick one case set to see the frontier'
            }
            picked={picked ?? undefined}
            onPick={key => setPicked(key === picked ? null : key)}
            dots={points.map(p => {
              const dominated = oneSet && !front.includes(p.key);
              const sure = p.n >= roughBelow;
              return {
                key: p.key,
                x: p.x,
                y: p.y,
                ...(sure && { xCi: p.xCi, yCi: p.yCi }),
                ...((front.includes(p.key) || p.key === picked) && { label: label(p) }),
                tone: tone(p.labels[color]),
                square: p.labels.arm === 'floor',
                dim: dominated,
                open: dominated && !p.judgeOnly && p.yCi[1] >= stair(p.x),
                tip: [
                  JSON.stringify(p.labels, null, 2),
                  `quality ${fmt(p.y)} (${ci(p.yCi, v => fmt(v))})`,
                  `${fx(p.x)} per task (${ci(p.xCi, fx)})`,
                  `${p.n} cases, ${p.repeats} runs, ${fmt(p.completion * 100, 0)}% complete`,
                  `${fmt(p.minutes, 1)} min, checking ${usd(getMean(p.perCase.map(s => s.row.checkUsd)))} per run`,
                  tokens(p.perCase.map(s => s.row)),
                  unpricedModels(p.perCase.map(s => s.row)),
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
          <p className="mt-1 text-[11px] text-zinc-500">Click a point or a row below to see its runs.</p>
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
        <div className="overflow-x-auto">
          <Forest
            points={points}
            label={label}
            tone={p => tone(p.labels[color])}
            usd={p => getMean(p.perCase.map(s => cost(s.row, cache === 'off')))}
            picked={picked}
            onPick={setPicked}
          />
        </div>
        <BenchResults runs={points.flatMap(p => p.perCase.map(({ row }) => readBenchRowResults(row)))} />
      </div>
    </div>
  );
};

export default BenchPage;
