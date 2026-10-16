import type { Check } from '../../../core/src/check.ts';
import type { Outcome, Run, Step, Workflow } from '../../../core/src/workflow.ts';

/** One outcome a run met, with the run as it stood before it. */
export type Trail = { at: Run; outcome: Outcome }[];

/** A simulated run: what happened and where it ended. */
type Simulated = { label: string; trail: Trail; run: Run };

/** A fixture workflow with its checks and the runs simulated over it. */
export type Fixture = {
  id: string;
  workflow: Workflow;
  checks: Record<string, Pick<Check, 'mode' | 'judge'>>;
  runs: Simulated[];
};

/** Picks the next outcome at a step, or undefined to leave the run where it is. */
type Policy = (step: Step, run: Run, trail: Trail) => Outcome | undefined;

const isBot = (s: Step) => 'bot' in s.does;
const waits = (s: Step) => 'wait' in s.does;
const pass: Outcome = { kind: 'pass' };
const sentBack = (s: Step): Outcome => ({ kind: 'back', why: s.back?.until ?? 'not there yet' });

/** A failure naming the first `n` checks of the step. */
const refuse = (s: Step, n = 2): Outcome => ({
  kind: 'failed',
  checks: s.checks.slice(0, n).map(check => ({ check, pass: false, findings: `${check} found a problem`, ms: 40 })),
  proposals: [],
  problems: s.checks.length ? [] : ['the change does not build'],
});

/** How many outcomes the run already met at this step on this visit. */
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

/** Passes every step before `name`, then lets `then` decide. */
const at =
  (name: string, then: Policy): Policy =>
  (s, run, trail) =>
    s.name === name ? then(s, run, trail) : pass;

/** The step with the most checks fails twice, then passes; a bot with a way back sends it back once; a human waits. */
const typical =
  (w: Workflow): Policy =>
  (s, run, trail) => {
    if (waits(s)) return undefined;
    const n = onVisit(run, trail);
    const busiest = w.steps.reduce((a, b) => (b.checks.length > a.checks.length ? b : a));
    if (s === busiest && s.checks.length > 0 && visitsTo(run, trail) === 0 && n < Math.min(2, s.tries - 1))
      return refuse(s, n === 0 ? 3 : 1);
    if (s.back && isBot(s) && visitsTo(run, trail) === 0) return sentBack(s);
    return pass;
  };

type Scenario = { label: string; next: Policy };

/** The simulated runs that make sense for a workflow, each skipped when the workflow cannot reach it. */
export const scenarios = (w: Workflow, checks: Fixture['checks']): Scenario[] => {
  const retried = w.steps.find(s => !waits(s) && s.tries > 1);
  const tried = retried ?? w.steps.find(s => !waits(s));
  const loop = w.steps.find(s => isBot(s) && s.back?.rounds !== undefined);
  const human = w.steps.find(waits);
  const guarded = w.steps.find(s => s.checks.some(c => checks[c]?.mode === 'stop'));
  const one = (when: unknown, item: () => Scenario) => (when ? [item()] : []);
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

/** Replays a policy through the engine's own transition until the run settles or asks. */
export const simulate = (
  w: Workflow,
  next: Policy,
  engine: Pick<typeof import('../../../core/src/workflow.ts'), 'begin' | 'transition'>
): { trail: Trail; run: Run } => {
  let run = engine.begin(w, { id: 'sim', issue: 1, started: '2026-10-16T00:00:00Z' });
  const trail: Trail = [];
  for (let i = 0; i < 60 && (run.status === 'running' || run.status === 'waiting'); i++) {
    const outcome = next(
      w.steps.find(s => s.name === run.step)!,
      run,
      trail
    );
    if (!outcome) break;
    trail.push({ at: run, outcome });
    run = engine.transition(w, run, outcome);
  }
  return { trail, run };
};
