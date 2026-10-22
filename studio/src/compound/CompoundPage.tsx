import { useAtom, useAtomValue } from 'jotai';
import { type ReactNode, useMemo, useState } from 'react';
import { live, queryParam } from '../state.ts';
import { Badge, Button, cx, Field, Fields, IconButton, Loading, Muted, Select, Tooltip } from '../ui.tsx';
import {
  average,
  byIteration,
  type Point,
  runningBest,
  type Series,
  seriesOf,
  type Step,
  type TuneRows,
} from './climb.ts';
import { type Band, Bars, Climb, type Dot, type Line } from './Climb.tsx';

const compoundAtom = live<TuneRows[]>('/core/compound');
const params = {
  repo: queryParam('repo'),
  x: queryParam('x'),
  bar: queryParam('bar'),
  hide: queryParam('hide'),
  pick: queryParam('pick'),
};

const palette = [
  'text-zinc-700 dark:text-zinc-300',
  'text-sky-600 dark:text-sky-400',
  'text-violet-600 dark:text-violet-400',
  'text-amber-600 dark:text-amber-400',
];
const verdicts: Record<Step['verdict'], string> = {
  kept: 'Cleared the keep rule against the incumbent on the select cases, so it became the incumbent.',
  discarded: 'Ran on every select case but did not clear the keep rule.',
  'screened-out': 'Lost clearly on the screen cases, so it never ran on the rest.',
  infra: 'The run broke on infrastructure, so it says nothing about the hub.',
};
const proposers: Record<Step['proposer'], string> = {
  retro: 'Read the incumbent’s traces on fit cases below 1 and named a shared miss.',
  history: 'Read merged PRs and their reviews and turned a standing rule into the hub.',
  manual: 'A patch dropped in by hand.',
  skill: 'Written by a subagent of the tune skill.',
  structure:
    'Made one graph edit from a fixed menu, in turn: add a reviewer, drop a step, more tries, a scout, a check to warn.',
};
const metrics = {
  usd: { label: 'usd', unit: 'usd per iteration' },
  minutes: { label: 'minutes', unit: 'minutes per iteration' },
  points: { label: 'points', unit: 'Codex and Claude 5h points per iteration' },
};

const fmt = (v: number | undefined, digits = 2) => (v === undefined || !Number.isFinite(v) ? '' : v.toFixed(digits));
const usd = (v: number) => `$${v.toFixed(2)}`;
const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;

const Control = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="space-y-1.5">
    <h3 className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">{label}</h3>
    {children}
  </div>
);

const Chip = ({
  tip,
  on,
  onClick,
  children,
}: {
  tip: string;
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) => (
  <Tooltip tip={tip}>
    <Button
      aria-pressed={on}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 font-mono transition-colors aria-pressed:border-zinc-500 aria-pressed:text-zinc-900 dark:aria-pressed:text-zinc-100"
    >
      {children}
    </Button>
  </Tooltip>
);

const Swatch = ({ tone, off }: { tone: string; off?: boolean }) => (
  <span className={cx('size-2 rounded-full border-[1.5px] border-current', tone, !off && 'bg-current')} />
);

const DiffText = ({ diff }: { diff: string }) => (
  <pre className="max-h-80 overflow-auto rounded bg-zinc-50 py-1 font-mono text-[11px] leading-4 dark:bg-zinc-900">
    {diff.split('\n').map((line, i) => (
      <div
        key={i}
        className={cx(
          'px-2 whitespace-pre-wrap',
          /^\+(?!\+\+)/.test(line) && 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
          /^-(?!--)/.test(line) && 'bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300',
          /^(@@|diff |\+\+\+|---)/.test(line) && 'text-zinc-500'
        )}
      >
        {line || ' '}
      </div>
    ))}
  </pre>
);

const Detail = ({ series, point, onClose }: { series: Series; point: Point; onClose: () => void }) => {
  const { step } = point;
  return (
    <aside className="bhm-in shrink-0 space-y-3 overflow-y-auto border-t border-zinc-200 p-4 text-xs lg:w-[28rem] lg:border-t-0 lg:border-l dark:border-zinc-800">
      <div className="flex items-center gap-1.5">
        <h2 className="truncate font-mono font-medium">{step.id}</h2>
        <Tooltip tip={proposers[step.proposer]}>
          <Badge>{step.proposer}</Badge>
        </Tooltip>
        <Tooltip tip={verdicts[step.verdict]}>
          <Badge>{step.verdict}</Badge>
        </Tooltip>
        <IconButton tip="Close" variant="quiet" className="ml-auto" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true" className="size-3">
            <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </IconButton>
      </div>
      <Fields>
        <Field name="series">
          <span className="font-mono">{series.key}</span>
        </Field>
        <Field name="iteration">{step.iteration}</Field>
        <Field name="select">{fmt(point.y)}</Field>
        <Field name="why">{step.why}</Field>
        <Field name="hub">
          <span className="font-mono">
            {step.parent.slice(0, 7)} → {step.hub.slice(0, 7)}
          </span>
        </Field>
        <Field name="cost">
          {usd(point.usd)}, {fmt(point.minutes, 0)} min, {fmt(point.codex, 1)} Codex, {fmt(point.claude, 1)} Claude
        </Field>
      </Fields>
      <section className="space-y-1">
        <h3 className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">Rationale</h3>
        <p className="leading-relaxed whitespace-pre-line">{step.rationale}</p>
      </section>
      {step.evals.length > 0 && (
        <table className="w-full text-left whitespace-nowrap tabular-nums">
          <thead className="text-zinc-500">
            <tr className="border-b border-zinc-200 dark:border-zinc-800">
              {['split', 'cases', 'quality', 'delta', 'P(up)', 'usd'].map(h => (
                <th key={h} className="py-1 pr-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {step.evals.map((e, i) => (
              <tr key={i} className="border-b border-zinc-100 dark:border-zinc-900">
                <td className="py-1 pr-3">{e.split}</td>
                <td className="py-1 pr-3">{e.cases.length}</td>
                <td className="py-1 pr-3">
                  <Tooltip tip={`95% interval ${fmt(e.ci[0])} to ${fmt(e.ci[1])}`}>
                    <span>{fmt(e.quality)}</span>
                  </Tooltip>
                </td>
                <td className="py-1 pr-3">{e.delta === undefined ? '' : signed(e.delta)}</td>
                <td className="py-1 pr-3">{fmt(e.pUp)}</td>
                <td className="py-1 pr-3">{usd(e.usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {step.diff ? (
        <DiffText diff={step.diff} />
      ) : (
        <p className="text-zinc-500">No hub diff: this is the starting hub.</p>
      )}
    </aside>
  );
};

const View = ({ tunes, onReload }: { tunes: TuneRows[]; onReload: () => void }) => {
  const [repoParam, setRepo] = useAtom(params.repo);
  const [xParam, setX] = useAtom(params.x);
  const [barParam, setBar] = useAtom(params.bar);
  const [hideParam, setHide] = useAtom(params.hide);
  const [pick, setPick] = useAtom(params.pick);
  const all = useMemo(() => seriesOf(tunes), [tunes]);
  const repos = [...new Set(all.map(s => s.repo))].sort();
  const names = [...new Set(all.map(s => s.name))];
  const tone = (name: string) => palette[names.indexOf(name) % palette.length]!;
  const hidden = hideParam?.split(',').filter(Boolean) ?? [];
  const repo = repoParam && repos.includes(repoParam) ? repoParam : repos.length > 1 ? 'average' : repos[0]!;
  const spend = xParam === 'usd';
  const bar = (barParam ?? 'usd') as keyof typeof metrics;
  const shown = all.filter(s => !hidden.includes(s.name) && (repo === 'average' || s.repo === repo));
  const avg = useMemo(() => (repo === 'average' ? average(shown) : []), [repo, shown]);
  const picked = all.flatMap(s => s.points.map(p => ({ s, p }))).find(({ s, p }) => `${s.key}#${p.step.id}` === pick);

  const dots: Dot[] = [];
  const lines: Line[] = [];
  const bands: Band[] = [];
  if (repo === 'average')
    for (const a of avg) {
      const at = (r: (typeof a.rows)[number]) => (spend ? r.cum : r.iteration);
      const scored = a.rows.flatMap(({ best, lo, hi, ...r }) =>
        best === undefined ? [] : [{ ...r, best, lo: lo ?? best, hi: hi ?? best }]
      );
      lines.push({ key: a.name, tone: tone(a.name), points: scored.map(r => ({ x: at(r), y: r.best })) });
      if (a.repos > 1)
        bands.push({ key: a.name, tone: tone(a.name), points: scored.map(r => ({ x: at(r), lo: r.lo, hi: r.hi })) });
      for (const r of scored)
        dots.push({
          key: `${a.name}#${r.iteration}`,
          x: at(r),
          y: r.best,
          tone: tone(a.name),
          shape: 'mean',
          tip: [
            `${a.name}, iteration ${r.iteration}`,
            `mean best ${fmt(r.best)} over ${a.repos} repo${a.repos > 1 ? 's' : ''}`,
            ...r.per.map(p => `${p.repo} ${fmt(p.best)}`),
            `${usd(r.cum)} spent so far, mean`,
          ].join('\n'),
        });
    }
  else
    for (const s of shown) {
      const spread = new Map<number, number>();
      const xOf = (p: Point) => {
        if (spend) return p.cum;
        if (p.step.verdict === 'kept') return p.step.iteration;
        const j = spread.get(p.step.iteration) ?? 0;
        spread.set(p.step.iteration, j + 1);
        return p.step.iteration + (j % 2 ? 1 : -1) * 0.14 * Math.ceil((j + 1) / 2);
      };
      const placed = s.points.map(p => ({ p, x: xOf(p) }));
      const kept = placed.filter(({ p }) => p.step.verdict === 'kept');
      lines.push({
        key: s.key,
        tone: tone(s.name),
        points: runningBest(placed.map(({ p, x }) => ({ x, y: p.y, kept: p.step.verdict === 'kept' }))),
      });
      lines.push({
        key: `${s.key}/validate`,
        tone: tone(s.name),
        thin: true,
        points: kept.flatMap(({ p, x }) => {
          const v = p.step.evals.filter(e => e.split === 'validate');
          return v.length ? [{ x, y: v.reduce((a, e) => a + e.quality, 0) / v.length }] : [];
        }),
      });
      for (const { p, x } of placed) {
        const key = `${s.key}#${p.step.id}`;
        const test = p.step.evals.find(e => e.split === 'test');
        if (test)
          dots.push({
            key: `${key}/test`,
            x,
            y: test.quality,
            ci: test.ci,
            tone: tone(s.name),
            shape: 'diamond',
            tip: `${p.step.id}, test checkpoint\n${fmt(test.quality)} on ${test.cases.length} held-out cases (${fmt(test.ci[0])} to ${fmt(test.ci[1])})`,
          });
        if (p.y === undefined) continue;
        const delta = p.step.evals.findLast(e => e.delta !== undefined);
        dots.push({
          key,
          x,
          y: p.y,
          tone: tone(s.name),
          shape: p.step.verdict === 'kept' ? 'kept' : p.step.verdict === 'discarded' ? 'discarded' : 'small',
          tip: [
            `${p.step.id}, ${p.step.proposer}, ${p.step.verdict}`,
            `select ${fmt(p.y)}${delta?.delta === undefined ? '' : `, delta ${signed(delta.delta)}, P(up) ${fmt(delta.pUp)}`}`,
            `${usd(p.usd)}, ${usd(p.cum)} so far`,
            p.step.why,
          ].join('\n'),
        });
      }
    }
  const init = repo === 'average' ? undefined : shown.find(s => !s.skill)?.init;

  const groups =
    repo === 'average'
      ? avg.map(a => ({ name: a.name, rows: a.rows }))
      : shown.map(s => ({ name: s.name, rows: byIteration(s) }));
  const part = (r: (typeof groups)[number]['rows'][number]) =>
    bar === 'points' ? [r.codex, r.claude] : bar === 'minutes' ? [r.minutes] : [r.usd];
  const bars = groups.flatMap((g, slot) =>
    g.rows.map(r => ({
      key: `${g.name}#${r.iteration}`,
      x: r.iteration,
      slot,
      slots: groups.length,
      tone: tone(g.name),
      parts: part(r),
      tip: `${g.name}, iteration ${r.iteration}\n${usd(r.usd)}, ${fmt(r.minutes, 0)} min, ${fmt(r.codex, 1)} Codex, ${fmt(r.claude, 1)} Claude 5h`,
    }))
  );

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <aside className="shrink-0 space-y-4 overflow-y-auto border-b border-zinc-200 p-4 text-xs lg:w-60 lg:border-r lg:border-b-0 dark:border-zinc-800">
        <Control label="View">
          <Select
            label="repo"
            value={repo}
            options={[
              ...(repos.length > 1 ? [{ value: 'average', label: 'average over repos' }] : []),
              ...repos.map(r => ({ value: r, label: r.split('/').pop()! })),
            ]}
            onChange={v => setRepo(v === 'average' && repos.length > 1 ? null : v)}
          />
          <Select
            label="x"
            value={spend ? 'usd' : 'iteration'}
            options={[
              { value: 'iteration', label: 'iteration' },
              { value: 'usd', label: 'cumulative usd' },
            ]}
            onChange={v => setX(v === 'usd' ? 'usd' : null)}
          />
        </Control>
        <Control label="Series">
          <div className="flex flex-wrap gap-1">
            {names.map(name => {
              const of = all.filter(s => s.name === name);
              const off = hidden.includes(name);
              return (
                <Chip
                  key={name}
                  on={!off}
                  tip={`${of.map(s => `${s.repo}: ${s.points.length} candidates`).join('\n')}\n${off ? 'Show' : 'Hide'} on the chart`}
                  onClick={() => setHide((off ? hidden.filter(h => h !== name) : [...hidden, name]).join(',') || null)}
                >
                  <Swatch tone={tone(name)} off={off} />
                  {name}
                </Chip>
              );
            })}
          </div>
        </Control>
        <Button onClick={onReload}>Reload</Button>
      </aside>
      <div className="min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto p-4">
        <section className="max-w-3xl">
          <Climb
            dots={dots}
            lines={lines}
            bands={bands}
            levels={[
              { y: 1, label: 'human' },
              ...(init === undefined ? [] : [{ y: init, label: 'init', dashed: true }]),
            ]}
            integerX={!spend}
            xTick={spend ? t => `$${t}` : undefined}
            xLabel={spend ? 'cumulative usd' : 'iteration'}
            yLabel="quality on select, human = 1"
            picked={pick ?? undefined}
            onPick={repo === 'average' ? undefined : key => setPick(key === pick ? null : key.replace(/\/test$/, ''))}
          />
          <p className="mt-1 text-[11px] text-zinc-500">
            {repo === 'average'
              ? 'Each line is the mean over repos of the running best; the band runs from the lowest repo to the highest. Pick a repo to see its candidates.'
              : 'Filled points were kept, hollow ones discarded, small grey ones screened out. The line is the running best, the dotted line the kept hubs on validate alone. Diamonds are test checkpoints with judges, the only score that can pass the human. Click a point for its diff.'}
          </p>
        </section>
        <section className="max-w-3xl space-y-1">
          <div className="flex gap-1">
            {(Object.keys(metrics) as (keyof typeof metrics)[]).map(m => (
              <Chip key={m} on={bar === m} tip={metrics[m].unit} onClick={() => setBar(m === 'usd' ? null : m)}>
                {metrics[m].label}
              </Chip>
            ))}
          </div>
          <Bars bars={bars} xLabel="iteration" yLabel={metrics[bar].unit} />
        </section>
      </div>
      {picked && <Detail series={picked.s} point={picked.p} onClose={() => setPick(null)} />}
    </div>
  );
};

export const CompoundPage = () => {
  const [tick, setTick] = useState(0);
  return <Data key={tick} onReload={() => setTick(t => t + 1)} />;
};

const Data = ({ onReload }: { onReload: () => void }) => {
  const { value, failure } = useAtomValue(compoundAtom);
  if (!value)
    return failure ? (
      <Muted>
        {/ 404$|JSON|token/.test(failure)
          ? 'No tune data: this studio does not serve /core/compound yet.'
          : `Could not load tunes: ${failure}`}
      </Muted>
    ) : (
      <Loading />
    );
  if (!value.length) return <Muted>No tunes yet. Start one with node bin/tune.ts init, then reload.</Muted>;
  return <View tunes={value} onReload={onReload} />;
};
