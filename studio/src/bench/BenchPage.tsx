import { useAtom } from 'jotai';
import { Schema } from 'effect';
import { type ReactNode, useMemo } from 'react';
import { getMean } from '../../../src/stats.ts';
import { queryParam } from '../state.ts';
import { usePluginData } from '../plugins.ts';
import { BenchData, type BenchRow as Row } from './data.ts';
import { Button, cx, Disclosure, Live, MultiSelect, Muted, Select, Tooltip, useScrollFade } from '../ui.tsx';
import {
  cost,
  getBenchNumbers,
  getBenchAxis,
  findBenchNumericFields,
  defaultBenchBy,
  defaultBenchScoreWeights,
  formatMinutes,
  formatUsd,
  getRowKey,
  frontier,
  presets,
  roughBelow,
  formatLabel,
  summarise,
  isBenchMatch,
} from './score.ts';
import { Forest, BenchRunLink } from './Forest.tsx';
import { Scatter } from './Scatter.tsx';
import { readBenchRowResults, type RunResults } from '../results/result.ts';
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
  name: queryParam('name'),
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
const BenchResults = ({ runs, value }: { runs: RunResults[]; value: BenchData }) => {
  const fields = value.fields.filter(f => runs.some(run => run.results[f.check]));
  return (
    <section className="space-y-2">
      {value.conflicts.map(conflict => (
        <Muted key={conflict}>{conflict}</Muted>
      ))}
      {fields.length > 0 && <ResultTable runs={runs} fields={fields} by="point" />}
    </section>
  );
};

const unpanelled = 'sol';

const defaultNames = (varying: string[]) => {
  const named = ['harness', 'model', 'arm'].filter(k => varying.includes(k));
  return named.length ? named : varying.slice(0, 1);
};

const fmt = (v: number) => (Number.isNaN(v) ? '' : v.toFixed(2));
const unpricedModels = (rs: Row[]) => {
  const missing = [...new Set(rs.flatMap(r => r.unpriced ?? []))];
  return missing.length ? `no list price for ${missing.join(', ')}, counted as $0` : '';
};

const Control = ({ label, tip, children }: { label: string; tip: string; children: ReactNode }) => (
  <div className="space-y-1 py-4">
    <h3 className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
      <Tooltip tip={tip} focusable>
        <span className="cursor-help underline decoration-zinc-200 decoration-dotted underline-offset-3 hover:decoration-zinc-400 dark:decoration-zinc-700">
          {label}
        </span>
      </Tooltip>
    </h3>
    {children}
  </div>
);

const BenchPage = () => <Live state={usePluginData('bench', BenchData)}>{value => <Bench value={value} />}</Live>;

const Bench = ({ value }: { value: BenchData }) => {
  const fade = useScrollFade();
  const [w, setW] = useAtom(params.w);
  const [selectedAxis, setX] = useAtom(params.x);
  const [whereParam, setWhere] = useAtom(params.where);
  const [byParam, setBy] = useAtom(params.by);
  const [colorParam, setColor] = useAtom(params.color);
  const where = useMemo(
    () =>
      Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.mutable(Schema.Array(Schema.String))))(
        JSON.parse(whereParam ?? '{}')
      ),
    [whereParam]
  );
  const groupKeys = useMemo(() => (byParam === null ? defaultBenchBy : byParam.split(',').filter(Boolean)), [byParam]);
  const color = colorParam ?? 'harness';
  const [cache, setCache] = useAtom(params.cache);
  const [infra, setInfra] = useAtom(params.infra);
  const [drop, setDrop] = useAtom(params.drop);
  const [picked, setPicked] = useAtom(params.point);
  const [nameParam, setNames] = useAtom(params.name);
  const weights = useMemo(() => {
    const given = w?.split(',').map(Number) ?? [];
    return Object.fromEntries(
      names.map((k, i) => [k, given[i] ?? defaultBenchScoreWeights[k]])
    ) as typeof defaultBenchScoreWeights;
  }, [w]);
  const dropped = useMemo(() => (drop ?? unpanelled).split(',').filter(Boolean), [drop]);
  const rows = value.rows;
  const judges = useMemo(() => [...new Set(rows.flatMap(r => Object.keys(r.vsHuman)))].toSorted(), [rows]);
  const labelKeys = useMemo(() => [...new Set(rows.flatMap(r => Object.keys(r.labels)))].toSorted(), [rows]);
  const labelValues = labelKeys.map(key => ({
    key,
    values: [...new Set(rows.flatMap(r => (r.labels[key] === undefined ? [] : [r.labels[key]!])))].toSorted(),
  }));
  const infraRows = rows.filter(r => r.infra && isBenchMatch(r, {}));
  const matchingInfraRows = infraRows.filter(r => isBenchMatch(r, where));
  const scoring = useMemo(
    () => ({ where, w: weights, judges: judges.filter(j => !dropped.includes(j)), infraZero: infra === 'zero' }),
    [where, weights, judges, dropped, infra]
  );
  const numericFields = findBenchNumericFields(rows, scoring);
  const xAxis = getBenchAxis(selectedAxis, numericFields);
  const minutes = xAxis === 'minutes';
  const isCost = xAxis === null || xAxis === 'usd';
  const rowCost = (r: Row) => cost(r, cache === 'off');
  const points = useMemo(() => {
    return summarise(value.rows, {
      ...scoring,
      by: groupKeys,
      color,
      x: r => (isCost ? rowCost(r) : getBenchNumbers(r)[xAxis]!),
    }).filter(p => p.n > 0);
  }, [value, scoring, groupKeys, color, isCost, xAxis, cache]);

  if (!value.rows.length)
    return <Muted>No runs. Add an instance, or start the studio with --bench and one or more bench set dirs.</Muted>;

  const oneSet = new Set(points.map(p => p.labels.set)).size === 1;
  const front = oneSet ? frontier(points) : [];
  const onFront = points.filter(p => front.includes(p.key));
  const rough = onFront.some(p => p.n < roughBelow);
  const stair = (x: number) => Math.max(-Infinity, ...onFront.filter(p => p.x <= x).map(p => p.y));
  const varying = [...new Set(points.flatMap(p => Object.keys(p.labels)))].filter(
    k => new Set(points.map(p => p.labels[k])).size > 1
  );
  const shown = nameParam === null ? defaultNames(varying) : nameParam.split(',').filter(k => varying.includes(k));
  const label = (p: (typeof points)[number]) => shown.map(k => formatLabel(p.labels[k])).join(' / ');
  const weighting =
    Object.entries(presets).find(([, p]) => names.every(k => p[k] === weights[k]))?.[0] ?? 'custom weights';
  const colors = [...new Set(points.map(p => p.labels[color]))].toSorted();
  const tone = (v: string | undefined) =>
    color ? tones[colors.indexOf(v) % tones.length]! : 'text-zinc-600 dark:text-zinc-400';
  const xLabel = minutes
    ? 'minutes per task'
    : isCost
      ? `notional USD per task${cache === 'off' ? ', cache off' : ''}, log`
      : xAxis;

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside
        ref={fade}
        className="shrink-0 divide-y divide-zinc-200 overflow-y-auto border-b border-zinc-200 px-4 text-xs md:w-64 md:border-r md:border-b-0 dark:divide-zinc-800 dark:border-zinc-800"
      >
        <Control label="Weights" tip="Choose a preset or adjust how much each score and penalty counts.">
          <div className="flex flex-wrap gap-1">
            {Object.entries(presets).map(([name, p]) => (
              <Tooltip key={name} tip={presetHelp[name]}>
                <Button
                  aria-pressed={weighting === name}
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
              className="grid w-full grid-cols-[6rem_1fr_2rem] items-center gap-x-1.5 font-mono text-zinc-600 dark:text-zinc-400"
            >
              <Tooltip tip={help[k]} focusable>
                <label
                  htmlFor={`w-${k}`}
                  className="cursor-help whitespace-nowrap underline decoration-zinc-200 decoration-dotted underline-offset-3 hover:decoration-zinc-400 dark:decoration-zinc-700"
                >
                  {labels[k]}
                </label>
              </Tooltip>
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
          tip="Choose list-price token cost (checking cost excluded), cost with cache tokens priced as plain input, wall minutes with machine sleep removed, or any numeric row field. Cost falls back to the recorded amount without tokens; models missing from the price table are named in point tips."
        >
          <Select
            label="x"
            value={isCost ? (cache === 'off' ? 'off' : 'usd') : minutes ? 'minutes' : `field:${xAxis}`}
            options={[
              { value: 'usd', label: 'cost, list price' },
              { value: 'off', label: 'cost, cache off' },
              { value: 'minutes', label: 'minutes' },
              ...numericFields
                .filter(k => !['usd', 'minutes'].includes(k))
                .map(k => ({ value: `field:${k}`, label: k })),
            ]}
            onChange={v => {
              setX(v.startsWith('field:') ? v.slice(6) : v === 'minutes' ? 'minutes' : null);
              setCache(v === 'off' ? 'off' : null);
            }}
          />
          {selectedAxis !== xAxis && <Muted>{selectedAxis} is unavailable on the current rows. Showing cost.</Muted>}
        </Control>
        <Control
          label="Filter"
          tip="Keep only runs whose label values you pick: values within a label are OR, different labels are AND. All includes every value; none keeps no runs."
        >
          {whereParam && <Button onClick={() => setWhere(null)}>clear filters</Button>}
          <div className="space-y-2">
            {labelValues
              .filter(({ values }) => values.length > 1)
              .map(({ key, values }) => (
                <MultiSelect
                  key={key}
                  label={key}
                  values={values}
                  selected={where[key] ?? values}
                  onChange={vs => {
                    const next = { ...where, [key]: vs };
                    if (values.every(value => vs.includes(value))) delete next[key];
                    setWhere(Object.keys(next).length ? JSON.stringify(next) : null);
                  }}
                />
              ))}
          </div>
        </Control>
        <Control
          label="Group by"
          tip="Each point merges runs sharing the ticked labels, averaged over repeats within a case, then over cases; fewer labels merge more runs. Colour and case set also split points, and judge-only cases stay separate."
        >
          <MultiSelect label="Labels" values={labelKeys} selected={groupKeys} onChange={vs => setBy(vs.join(','))} />
          <Select
            label="color"
            className="grid grid-cols-2 gap-2 [&_select]:min-w-0 [&_select]:w-full"
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
        <Control
          label="Infra"
          tip="Infrastructure failures are excluded from scores by default. Count them as zero to include them, or inspect their reasons and runs below."
        >
          <p className="text-zinc-500">
            {matchingInfraRows.length} of {infraRows.length} infra runs match filters
          </p>
          <label className="flex items-start gap-1.5 text-zinc-600 dark:text-zinc-400">
            <input
              className="mt-0.5 shrink-0"
              type="checkbox"
              checked={infra === 'zero'}
              onChange={e => setInfra(e.target.checked ? 'zero' : null)}
            />
            Count infra runs as 0
          </label>
          <Disclosure summary={`Inspect infra runs (${matchingInfraRows.length})`}>
            <ul className="mt-2 space-y-2">
              {matchingInfraRows.map(row => (
                <li key={getRowKey(row)} className="space-y-0.5 break-words">
                  <BenchRunLink row={row} className="underline underline-offset-2">
                    {row.labels.model} / {row.labels.harness} / {row.case} / repeat {row.repeat}
                  </BenchRunLink>
                  <p className="text-zinc-500 [overflow-wrap:anywhere]">{row.infra}</p>
                </li>
              ))}
            </ul>
          </Disclosure>
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
        <section className="max-w-3xl">
          <div className="mb-2 flex flex-wrap items-center gap-1 text-xs text-zinc-500">
            <Tooltip tip="Which labels name the points on the chart. Each point is the runs that share the labels picked under Group by.">
              <span className="mr-1">names</span>
            </Tooltip>
            {varying.map(k => (
              <Button
                key={k}
                aria-pressed={shown.includes(k)}
                className="aria-pressed:border-zinc-500 aria-pressed:text-zinc-900 dark:aria-pressed:text-zinc-100"
                onClick={() => setNames((shown.includes(k) ? shown.filter(n => n !== k) : [...shown, k]).join(','))}
              >
                {k}
              </Button>
            ))}
          </div>
          <Scatter
            log={isCost}
            xLabel={xLabel}
            yLabel="quality"
            xTip={
              minutes
                ? 'Minutes per task, averaged over repeats within each case, then over cases.'
                : isCost
                  ? 'Notional USD cost per task on a log scale, averaged over repeats within each case, then over cases.'
                  : `${xAxis}, averaged over repeats within each case, then over cases.`
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
                ...(shown.length && { label: label(p) }),
                tone: tone(p.labels[color]),
                square: p.labels.arm === 'floor',
                dim: dominated,
                open: dominated && !p.judgeOnly && p.yCi[1] >= stair(p.x),
                tip: [
                  varying.map(k => `${k} ${formatLabel(p.labels[k])}`).join(', '),
                  `quality ${fmt(p.y)} ± ${fmt((p.yCi[1] - p.yCi[0]) / 2)}`,
                  `${formatUsd(getMean(p.perCase.map(s => rowCost(s.row))))} and ${formatMinutes(p.minutes)} per run`,
                  `${p.n} cases, ${p.repeats} runs`,
                  unpricedModels(p.perCase.map(s => s.row)),
                  p.judgeOnly ? 'judged only, so off the line' : '',
                ]
                  .filter(Boolean)
                  .join('\n'),
              };
            })}
          />
          <p className="mt-1 text-[11px] text-zinc-500">Click a point or a row below to see its runs.</p>
        </section>
        <div className="overflow-x-auto">
          <Forest
            points={points}
            keys={varying.filter(k => k !== 'set')}
            weighting={weighting}
            tone={p => tone(p.labels[color])}
            rowCost={rowCost}
            picked={picked}
            onPick={setPicked}
          />
        </div>
        <BenchResults runs={rows.filter(row => isBenchMatch(row, where)).map(readBenchRowResults)} value={value} />
      </div>
    </div>
  );
};

export default BenchPage;
