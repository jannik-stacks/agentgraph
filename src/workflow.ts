import { basename } from 'node:path';
import { Either, ParseResult, Schema } from 'effect';
import { parse } from 'yaml';
import type { Applied, Event, Proposal } from './forge.ts';

/** A check's verdict; `empty` when its `each` found nothing to judge. */
export type CheckResult = { check: string; pass: boolean; empty?: true; findings?: string; ms: number };

/** A hub file after parsing: its name, where it lives and its markdown body. */
export type Doc<T> = T & { name: string; path: string; body: string };

export type Problem = { path: string; message: string };

/** An ordered list of steps; the body is the description, or the prompt when there are no steps. `dispatch` starts it only from a `run` proposal. */
export type Workflow = Doc<{
  on: Partial<
    Record<
      'issues' | 'issue_comment' | 'pull_request' | 'dispatch',
      { command?: string; label?: string; branches?: string[] }
    >
  >;
  branch?: string;
  base?: string;
  steps: Step[];
}>;

export type Step = {
  name: string;
  does: { agent: string; skill?: string } | { run: string } | { wait: 'human' };
  checks: string[];
  tries: number;
  back?: { to: string; until?: string; rounds?: number };
  each?: 'files' | 'hunks' | { run: string };
};

/** How one try of a step ended, or what a human said to a waiting run. */
export type Outcome =
  | { kind: 'pass'; answered?: true }
  | { kind: 'failed'; checks: CheckResult[]; proposals: Applied[]; problems: string[] }
  | { kind: 'back'; why: string }
  | { kind: 'ask'; question: string }
  | { kind: 'answer'; text: string }
  | { kind: 'stop'; why: string };

/** How far a session has read its issues: the time of the last event it saw and the base its pull request was on. */
export type Seen = { at: string; base?: string };

/** Where one workflow run on one issue stands. */
export type Run = {
  id: string;
  workflow: string;
  issue: number;
  /** The issue's title and body as the run last saw them. */
  title?: string;
  body?: string;
  step: string;
  status: 'running' | 'waiting' | 'done' | 'stopped';
  tries: number;
  rounds: Record<string, number>;
  sessions: Record<string, { id: string; home: string; seen?: Seen }>;
  feedback?: string;
  /** What a human answered while the run waited, with the question each answer settled. */
  answers?: { asked: string; said: string }[];
  reason?: string;
  comment?: string;
  said?: { issue: number; under?: string };
  /** The 👀 the run gave where it was woken, as the proposal that takes it back once the run has replied. */
  eyes?: { issue: number; undo: Extract<Proposal, { kind: 'react' }> };
  /** The open pull request the run stacks on, and the head of it the run's branch builds on. */
  base?: { pull: number; branch: string; sha: string };
  /** The version of the hub the run was last checked under. */
  hub?: string;
  /** The run whose `run` proposal started this one. */
  by?: string;
  started: string;
  ended?: string;
  usd: number;
};

const exact = <S extends Schema.Schema.All>(schema: S) => Schema.optionalWith(schema, { exact: true });
const Count = Schema.Int.pipe(Schema.positive());
const Names = Schema.mutable(Schema.Array(Schema.String));
const Trigger = Schema.NullOr(
  Schema.Struct({ command: exact(Schema.String), label: exact(Schema.String), branches: exact(Names) })
);
const EventName = Schema.Literal('issues', 'issue_comment', 'pull_request', 'dispatch');

const StepFile = Schema.Struct({
  agent: exact(Schema.String),
  run: exact(Schema.String),
  wait: exact(Schema.Literal('human')),
  skill: exact(Schema.String),
  checks: exact(Names),
  tries: exact(Count),
  back: exact(Schema.String),
  until: exact(Schema.String),
  rounds: exact(Count),
  each: exact(Schema.Union(Schema.Literal('files', 'hunks'), Schema.Struct({ run: Schema.String }))),
});

const Front = Schema.Struct({
  on: Schema.Union(
    EventName,
    Schema.Struct({
      issues: exact(Trigger),
      issue_comment: exact(Trigger),
      pull_request: exact(Trigger),
      dispatch: exact(Schema.Null),
    })
  ),
  branch: exact(Schema.String),
  base: exact(Schema.String),
  agent: exact(Schema.String),
  steps: exact(Schema.Record({ key: Schema.String, value: StepFile })),
});

const decode = Schema.decodeUnknownEither(Front, { onExcessProperty: 'error', errors: 'all' });

/** Splits a markdown file into its parsed YAML frontmatter and its trimmed body. */
export const split = (text: string): { data: unknown; body: string } => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  return m ? { data: parse(m[1] ?? '') ?? {}, body: (m[2] ?? '').trim() } : { data: {}, body: text.trim() };
};

/** Parses a workflow file and fills its defaults. Problems are data; the workflow is set only when there are none. */
export function load(
  path: string,
  text: string,
  names: Record<'agents' | 'skills' | 'checks', string[]>
): { workflow?: Workflow; problems: Problem[] } {
  const problems: Problem[] = [];
  const say = (key: string, message: string) => problems.push({ path, message: `${key}: ${message}` });
  let file: { data: unknown; body: string };
  try {
    file = split(text);
  } catch (e) {
    return { problems: [{ path, message: `frontmatter: ${(e as Error).message}` }] };
  }
  const decoded = decode(file.data);
  if (Either.isLeft(decoded)) {
    const seen = new Set<string>();
    for (const issue of ParseResult.ArrayFormatter.formatErrorSync(decoded.left)) {
      const key = issue.path.join('.') || 'frontmatter';
      if (!seen.has(key)) say(key, issue.message);
      seen.add(key);
    }
    return { problems };
  }
  const front = decoded.right;
  const name = basename(path, '.md');

  if (front.steps && front.agent) say('agent', 'only a workflow without steps names its agent');
  if (!front.steps && !front.agent && names.agents.length !== 1)
    say('agent', 'a workflow without steps names its agent');
  const files = front.steps ?? { [name]: { agent: front.agent ?? names.agents[0] ?? '' } };
  const order = Object.keys(files);
  if (order.length === 0) say('steps', 'name at least one step');

  const steps = order.map((stepName, i): Step => {
    const s = files[stepName]!;
    const key = `steps.${stepName}`;
    const doers = [s.agent, s.run, s.wait].filter(d => d !== undefined);
    if (doers.length !== 1) say(key, 'name exactly one of agent, run and wait');
    if (s.agent !== undefined && !names.agents.includes(s.agent)) say(`${key}.agent`, `unknown agent ${s.agent}`);
    if (s.skill !== undefined && !names.skills.includes(s.skill)) say(`${key}.skill`, `unknown skill ${s.skill}`);
    for (const check of s.checks ?? []) {
      if (!names.checks.includes(check)) say(`${key}.checks`, `unknown check ${check}`);
    }
    if (s.back !== undefined) {
      const to = order.indexOf(s.back);
      if (to < 0) say(`${key}.back`, `unknown step ${s.back}`);
      else if (to > i) say(`${key}.back`, `${s.back} comes later; a way back goes to this step or an earlier one`);
    }
    if (s.agent !== undefined && s.back !== undefined && s.until === undefined) {
      say(`${key}.until`, 'an agent step with a way back says until when');
    }
    if (s.back === undefined && s.until !== undefined) say(`${key}.until`, 'until needs back');
    if (s.back === undefined && s.rounds !== undefined) say(`${key}.rounds`, 'rounds needs back');

    const checks = s.checks ?? [];
    const skill = s.skill ?? (names.skills.includes(stepName) ? stepName : undefined);
    const does: Step['does'] =
      s.run !== undefined
        ? { run: s.run }
        : s.wait !== undefined
          ? { wait: 'human' }
          : { agent: s.agent ?? '', ...(skill !== undefined && { skill }) };
    const rounds = s.rounds ?? (s.wait ? undefined : 3);
    return {
      name: stepName,
      does,
      checks,
      tries: s.tries ?? (checks.length > 0 ? 3 : 1),
      ...(s.back !== undefined && {
        back: {
          to: s.back,
          ...(s.until !== undefined && { until: s.until }),
          ...(rounds !== undefined && { rounds }),
        },
      }),
      ...(s.each !== undefined && { each: s.each }),
    };
  });
  if (problems.length > 0) return { problems };

  const on = typeof front.on === 'string' ? { [front.on]: {} } : front.on;
  const workflow: Workflow = {
    name,
    path,
    body: file.body,
    on: Object.fromEntries(Object.entries(on).map(([event, trigger]) => [event, trigger ?? {}])),
    ...(front.branch !== undefined && { branch: front.branch }),
    ...(front.base !== undefined && { base: front.base }),
    steps,
  };
  return { workflow, problems };
}

export const waits = (step: Step) => 'wait' in step.does;
const entered = (step: Step): Run['status'] => (waits(step) ? 'waiting' : 'running');

const fresh = ({ feedback: _feedback, reason: _reason, ...run }: Run): Run => run;

export const failure = (o: Extract<Outcome, { kind: 'failed' }>) =>
  [
    ...o.checks.map(c => `${c.check}: ${c.findings ?? 'failed'}`),
    ...o.proposals.map(a => `${a.proposal.kind} failed: ${a.reason ?? 'not allowed'}`),
    ...o.problems,
  ].join('\n');

/** The run at the first step of a workflow. */
export function begin(w: Workflow, run: Pick<Run, 'id' | 'issue' | 'started'>): Run {
  const first = w.steps[0]!;
  return {
    ...run,
    workflow: w.name,
    step: first.name,
    status: entered(first),
    tries: 0,
    rounds: {},
    sessions: {},
    usd: 0,
  };
}

/** Moves a run to its next state. Entering a step forward drops its session; every other move keeps it. */
export function transition(w: Workflow, run: Run, o: Outcome): Run {
  const i = w.steps.findIndex(s => s.name === run.step);
  const step = w.steps[i];
  if (!step) return run;
  const stop = (why: string): Run => ({ ...fresh(run), status: 'stopped', reason: why });
  const ask = (question: string): Run => ({ ...fresh(run), status: 'waiting', reason: question });

  const forward = (): Run => {
    const next = w.steps[i + 1];
    if (!next) return { ...fresh(run), status: 'done' };
    const { [next.name]: _dropped, ...sessions } = run.sessions;
    return { ...fresh(run), step: next.name, status: entered(next), tries: 0, sessions };
  };

  const back = (why: string): Run => {
    if (!step.back) return run;
    const taken = run.rounds[step.name] ?? 0;
    if (step.back.rounds !== undefined && taken >= step.back.rounds) return ask(why);
    const to = w.steps.find(s => s.name === step.back!.to)!;
    return {
      ...fresh(run),
      step: to.name,
      status: entered(to),
      tries: 0,
      rounds: { ...run.rounds, [step.name]: taken + 1 },
      feedback: `the ${step.name} step sent this back: ${why}`,
    };
  };

  if (run.status === 'running') {
    switch (o.kind) {
      case 'pass':
        return o.answered ? { ...fresh(run), status: 'done' } : forward();
      case 'failed': {
        const tries = run.tries + 1;
        const text = failure(o);
        return tries < step.tries ? { ...fresh(run), tries, feedback: text } : { ...ask(text), tries };
      }
      case 'back':
        if (step.back) return back(o.why);
        return transition(w, run, {
          kind: 'failed',
          checks: [],
          proposals: [{ proposal: { kind: 'back', why: o.why }, ok: false, reason: `${step.name} has no way back` }],
          problems: [],
        });
      case 'ask':
        return ask(o.question);
      case 'stop':
        return stop(o.why);
      case 'answer':
        return run;
    }
  }
  if (run.status === 'waiting' && waits(step)) {
    if (o.kind === 'pass') return forward();
    if (o.kind === 'back') return back(o.why);
    if (o.kind === 'stop') return stop(o.why);
    return run;
  }
  if (run.status === 'waiting') {
    if (o.kind === 'stop') return stop(o.why);
    if (o.kind !== 'answer') return run;
    const taken = run.rounds[step.name] ?? 0;
    const tries = run.tries >= step.tries ? step.tries - 1 : run.tries;
    const outOfRounds = run.tries < step.tries && step.back?.rounds !== undefined && taken >= step.back.rounds;
    const rounds = outOfRounds ? { ...run.rounds, [step.name]: taken - 1 } : run.rounds;
    const answers = [...(run.answers ?? []), { asked: run.reason ?? '', said: o.text }];
    return { ...fresh(run), status: entered(step), tries, rounds, feedback: o.text, answers };
  }
  return run;
}

/**
 * What a new event means for a waiting run: a review at a human step, an answer elsewhere; undefined when it is only
 * context. `lined` are the line comments that came with a review.
 */
export function reenter(w: Workflow, run: Run, m: Event, fallback?: string, lined: Event[] = []): Outcome | undefined {
  if (!m.trusted || m.issue !== run.issue) return undefined;
  const label = w.on.issues?.label;
  if (m.kind === 'unlabel' && label !== undefined && m.label === label && run.status !== 'done')
    return { kind: 'stop', why: `the ${label} label was removed` };
  const waiting = run.status === 'waiting';
  if (m.kind === 'closed' && waiting) return { kind: 'stop', why: 'closed' };
  const command = Object.values(w.on).find(t => t?.command)?.command ?? fallback;
  const body = m.comment?.body.trim() ?? '';
  const said =
    m.kind === 'comment' && command !== undefined && body.startsWith(command)
      ? body.slice(command.length).trim()
      : undefined;
  const [first = '', ...rest] = said?.split(/\s+/) ?? [];
  if (first.toLowerCase() === 'stop' && waiting) return { kind: 'stop', why: rest.join(' ') || 'a human said stop' };
  const step = w.steps.find(s => s.name === run.step);
  if (waiting && step && waits(step)) {
    if (m.kind === 'merged' || m.kind === 'approved' || (m.kind === 'label' && m.label === 'approved'))
      return { kind: 'pass' };
    if (m.kind === 'changes_requested') {
      const notes = lined.flatMap(({ comment: c }) =>
        c?.path ? `${c.path}${c.line ? `:${c.line}` : ''}: ${c.body}` : []
      );
      return { kind: 'back', why: [body || 'changes requested', ...notes].join('\n') };
    }
    if (said !== undefined) return { kind: 'back', why: said };
  }
  if (waiting && said !== undefined) return { kind: 'answer', text: said };
  return undefined;
}
