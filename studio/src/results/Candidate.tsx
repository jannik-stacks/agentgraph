import type { Step } from '../../../bin/tune.ts';
import { sum } from '../../../src/stats.ts';
import { Badge, cx, Field, Fields, Help, IconButton, Tooltip } from '../ui.tsx';

const verdicts: Record<Step['verdict'], string> = {
  kept: 'Cleared the keep rule against the incumbent on the select cases, so it became the incumbent.',
  discarded: 'Ran on every select case but did not clear the keep rule.',
  'screened-out': 'Lost clearly on the screen cases, so it never ran on the rest.',
  infra: 'The run broke on infrastructure, so it says nothing about the graph.',
};
const proposers: Record<Step['proposer'], string> = {
  retro: 'Read the incumbent’s traces on fit cases below 1 and named a shared miss.',
  history: 'Read merged PRs and their reviews and turned a standing rule into the graph.',
  manual: 'A patch dropped in by hand.',
  skill: 'Written by a subagent of the tune skill.',
  structure:
    'Made one graph edit from a fixed menu, in turn: add a reviewer, drop a step, more tries, a scout, a check to warn.',
};
const help = {
  iteration:
    'One round of the climb: proposers write up to k candidate graphs, each runs on the select cases, and at most one is kept.',
  verdict:
    'Kept means the candidate beat the current graph, by winning more cases than it lost or by costing less per run without dropping a case. Discarded means it ran on every select case and did neither. Screened out means it dropped two of its four screen cases and lifted none. Infra means its runs broke for reasons outside the graph.',
  split:
    'Fit cases are the ones proposers may study. Validate cases count toward keeping a candidate but proposers never see them. Together they are the select cases. Test cases stay held out and run only at checkpoints, with judges.',
  quality:
    "Each run gets 0.87 of its score when the hidden tests from the human's merged change pass, plus 0.13 when the repo's own test suite still passes. Averaged over cases, so the human scores 1.",
  delta: "The candidate's average quality minus the current graph's, compared case by case.",
  pUp: 'The share of 2000 resampled sets of the cases (bootstrap resamples) where the candidate came out ahead of the current graph.',
};

const fmt = (v: number | undefined, digits = 2) => (v === undefined || !Number.isFinite(v) ? '' : v.toFixed(digits));
const usd = (v: number) => `$${v.toFixed(2)}`;
const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;

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

export const Candidate = ({ tune, step, onClose }: { tune: string; step: Step; onClose: () => void }) => {
  const usage = (k: 'usd' | 'minutes' | 'codex' | 'claude5h') => sum(step.evals.map(e => e[k]));
  return (
    <aside className="agi-in shrink-0 space-y-3 overflow-y-auto border-t border-zinc-200 p-4 text-xs lg:w-[28rem] lg:border-t-0 lg:border-l dark:border-zinc-800">
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
        <Field name="tune">
          <span className="font-mono">{tune}</span>
        </Field>
        <Field
          name={
            <span className="inline-flex items-center gap-1">
              iteration <Help tip={help.iteration} />
            </span>
          }
        >
          {step.iteration}
        </Field>
        <Field
          name={
            <span className="inline-flex items-center gap-1">
              verdict <Help tip={help.verdict} />
            </span>
          }
        >
          {step.verdict}
        </Field>
        <Field name="why">{step.why}</Field>
        <Field name="graph">
          <span className="font-mono">
            {step.parent.slice(0, 7)} → {step.graph.slice(0, 7)}
          </span>
        </Field>
        <Field name="cost">
          {usd(usage('usd'))}, {fmt(usage('minutes'), 0)} min, {fmt(usage('codex'), 1)} Codex,{' '}
          {fmt(usage('claude5h'), 1)} Claude
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
              {(
                [
                  ['split', help.split],
                  ['cases'],
                  ['quality', help.quality],
                  ['delta', help.delta],
                  ['P(up)', help.pUp],
                  ['usd'],
                ] as const
              ).map(([h, tip]) => (
                <th key={h} className="py-1 pr-3 font-medium">
                  <span className="inline-flex items-center gap-1">
                    {h}
                    {tip && <Help tip={tip} />}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {step.evals.map((e, i) => (
              <tr key={i} className="border-b border-zinc-100 dark:border-zinc-900">
                <td className="py-1 pr-3">{step.iteration > 0 && i === 0 ? 'fit screen' : e.split}</td>
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
        <p className="text-zinc-500">No graph diff: this is the starting graph.</p>
      )}
    </aside>
  );
};
