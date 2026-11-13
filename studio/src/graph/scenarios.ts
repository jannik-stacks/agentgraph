import type { Doc, Step, Workflow } from '../../../src/workflow.ts';
import { type Agent, type Check, type Outcome, type Run, type Trace } from '../../../src/types.ts';
import type * as WorkflowModule from '../../../src/workflow.ts';
import type { Trail } from '../../../src/actions.ts';

export const makeTrailOutcome = (o: Outcome, after: Pick<Run, 'reason'>) =>
  o.kind === 'failed'
    ? { kind: o.kind, failed: o.checks.length + o.proposals.length + o.problems.length }
    : o.kind === 'back' && after.reason !== undefined
      ? { kind: o.kind, outOfRounds: true as const }
      : { kind: o.kind };

export type RunDrawnOnWorkflow = {
  fixture: Fixture;
  run: Pick<Run, 'id' | 'issue' | 'step' | 'status' | 'tries' | 'rounds' | 'reason' | 'waiting' | 'said'>;
  trail: Trail;
  trace?: Trace[];
};

export type Fixture = {
  id: string;
  workflow: Workflow;
  checks: Record<string, Pick<Check, 'mode' | 'agent' | 'run' | 'returns'> & Partial<Pick<Doc<Check>, 'body'>>>;
  runs: { label: string; trace: Trace[]; run: Run }[];
  agents?: Record<string, string>;
  skills?: Record<string, string>;
  roles?: Record<string, Pick<Agent, 'returns' | 'reads' | 'model'>>;
};

type Policy = (step: Step, run: Run, trail: Trail) => Outcome | undefined;

const isAgent = (s: Step) => 'agent' in s.does;
const waits = (s: Step) => 'wait' in s.does;
const pass: Outcome = { kind: 'pass' };
const sentBack = (s: Step): Outcome => ({ kind: 'back', why: s.back?.until ?? 'not there yet' });

const refuse = (s: Step, n = 2): Outcome => ({
  kind: 'failed',
  checks: s.checks.slice(0, n).map(check => ({ check, pass: false, findings: `${check} found a problem`, ms: 40 })),
  proposals: [],
  problems: s.checks.length ? [] : ['the change does not build'],
});

const onVisit = (run: Run, trail: Trail) => {
  let n = 0;
  for (const { at, outcome } of trail.toReversed()) {
    if (at.step !== run.step || outcome.kind === 'pass' || outcome.kind === 'back') break;
    n++;
  }
  return n;
};
const visitsTo = (run: Run, trail: Trail) =>
  trail.filter(({ at, outcome }) => at.step === run.step && (outcome.kind === 'pass' || outcome.kind === 'back'))
    .length;

const at =
  (name: string, then: Policy): Policy =>
  (s, run, trail) =>
    s.name === name ? then(s, run, trail) : pass;

const typical =
  (w: Workflow): Policy =>
  (s, run, trail) => {
    if (waits(s)) return undefined;
    const n = onVisit(run, trail);
    const busiest = w.steps.reduce((a, b) => (b.checks.length > a.checks.length ? b : a));
    if (s === busiest && s.checks.length > 0 && visitsTo(run, trail) === 0 && n < Math.min(2, s.tries - 1))
      return refuse(s, n === 0 ? 3 : 1);
    if (s.back && isAgent(s) && visitsTo(run, trail) === 0) return sentBack(s);
    return pass;
  };

const one = (when: unknown, item: () => ReturnType<typeof scenarios>[number]) => (when ? [item()] : []);

export const scenarios = (w: Workflow, checks: Fixture['checks']): { label: string; next: Policy }[] => {
  const retried = w.steps.find(s => !waits(s) && s.tries > 1);
  const tried = retried ?? w.steps.find(s => !waits(s));
  const loop = w.steps.find(s => isAgent(s) && s.back?.rounds !== undefined);
  const human = w.steps.find(waits);
  const guarded = w.steps.find(s => s.checks.some(c => checks[c]?.mode === 'stop'));
  return [
    { label: 'a typical run', next: typical(w) },
    ...one(retried, () => ({
      label: `${retried!.name}, try 2 of ${retried!.tries}`,
      next: at(retried!.name, (s, run) => (run.tries === 0 ? refuse(s) : undefined)),
    })),
    ...one(loop, () => ({
      label: `${loop!.back!.to}, round 1 of ${loop!.back!.rounds}`,
      next: (s, run, trail) =>
        trail.some(t => t.outcome.kind === 'back') ? undefined : at(loop!.name, sentBack)(s, run, trail),
    })),
    ...one(tried, () => ({ label: `${tried!.name}, waiting, out of tries`, next: at(tried!.name, s => refuse(s)) })),
    ...one(loop, () => ({
      label: `${loop!.name}, waiting, out of rounds`,
      next: s => (s === loop ? sentBack(s) : pass),
    })),
    ...one(human, () => ({ label: `${human!.name}, waiting for a human`, next: s => (waits(s) ? undefined : pass) })),
    ...one(guarded, () => {
      const check = guarded!.checks.find(c => checks[c]?.mode === 'stop')!;
      return {
        label: `stopped by the ${check} check`,
        next: at(guarded!.name, () => ({ kind: 'stop', why: `the ${check} check failed` })),
      };
    }),
    { label: 'done', next: () => pass },
  ];
};

export const simulate = (
  w: Workflow,
  next: Policy,
  engine: Pick<typeof WorkflowModule, 'begin' | 'transition'>
): { trace: Trace[]; run: Run } => {
  let run = engine.begin(w, { id: 'sim', issue: 1, started: '2026-10-16T00:00:00Z' });
  const trail: Trail = [];
  const trace: Trace[] = [];
  for (let i = 0; i < 60 && (run.status === 'running' || run.status === 'waiting'); i++) {
    const outcome = next(
      w.steps.find(s => s.name === run.step)!,
      run,
      trail
    );
    if (!outcome) break;
    const { step, status, tries, rounds } = run;
    run = engine.transition(w, run, outcome);
    trail.push({ at: { step, status, tries, rounds }, outcome: makeTrailOutcome(outcome, run) });
    trace.push({
      at: '',
      step,
      outcome,
      run: {
        step: run.step,
        status: run.status,
        tries: run.tries,
        rounds: run.rounds,
        ...(run.reason !== undefined && { reason: run.reason }),
      },
    });
  }
  return { trace, run };
};
