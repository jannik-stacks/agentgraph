import { basename } from 'node:path';
import { Either, ParseResult, Schema } from 'effect';
import { parse } from 'yaml';
import type { Verdict } from './check.ts';
import type { Applied, Message } from './forge.ts';

/** A hub file after parsing: its name, where it lives and its markdown body. */
export type Doc<T> = T & { name: string; path: string; body: string };

export type Problem = { path: string; message: string };

/** An ordered list of steps; the body is the description, or the prompt when there are no steps. */
export type Workflow = Doc<{
  on: Partial<Record<'issues' | 'issue_comment' | 'pull_request', { command?: string; branches?: string[] }>>;
  branch?: string;
  into?: string;
  steps: Step[];
}>;

export type Step = {
  name: string;
  does: { bot: string; skill?: string } | { run: string } | { wait: 'human' };
  checks: string[];
  tries: number;
  back?: { to: string; until?: string; rounds?: number };
  each?: 'files' | 'hunks' | { run: string };
};

/** How one try of a step ended, or what a human said to a parked run. */
export type Outcome =
  | { kind: 'pass' }
  | { kind: 'refused'; failing: Verdict[]; rejected: Applied[]; problems: string[] }
  | { kind: 'back'; why: string }
  | { kind: 'ask'; question: string }
  | { kind: 'answer'; text: string }
  | { kind: 'stop'; why: string };

/** Where one workflow run on one thread stands. Enough to stop and pick it up on another machine. */
export type Run = {
  id: string;
  workflow: string;
  thread: number;
  step: string;
  status: 'running' | 'asking' | 'waiting' | 'done' | 'stopped';
  tries: number;
  rounds: Record<string, number>;
  sessions: Record<string, { id: string; home: string }>;
  carry?: string;
  reason?: string;
  started: string;
  ended?: string;
  usd: number;
};

const exact = <S extends Schema.Schema.All>(schema: S) => Schema.optionalWith(schema, { exact: true });
const Count = Schema.Int.pipe(Schema.positive());
const Names = Schema.mutable(Schema.Array(Schema.String));
const Trigger = Schema.NullOr(Schema.Struct({ command: exact(Schema.String), branches: exact(Names) }));
const Event = Schema.Literal('issues', 'issue_comment', 'pull_request');

const StepFile = Schema.Struct({
  bot: exact(Schema.String),
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
    Event,
    Schema.Struct({ issues: exact(Trigger), issue_comment: exact(Trigger), pull_request: exact(Trigger) })
  ),
  branch: exact(Schema.String),
  into: exact(Schema.String),
  bot: exact(Schema.String),
  steps: exact(Schema.Record({ key: Schema.String, value: StepFile })),
});

const decode = Schema.decodeUnknownEither(Front, { onExcessProperty: 'error', errors: 'all' });

const split = (text: string): { data: unknown; body: string } => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  return m ? { data: parse(m[1] ?? '') ?? {}, body: (m[2] ?? '').trim() } : { data: {}, body: text.trim() };
};

/** Parses a workflow file and fills its defaults. Problems are data; the workflow is set only when there are none. */
export function load(
  path: string,
  text: string,
  names: Record<'bots' | 'skills' | 'checks', string[]>
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

  if (front.steps && front.bot) say('bot', 'only a workflow without steps names its bot');
  if (!front.steps && !front.bot && names.bots.length !== 1) say('bot', 'a workflow without steps names its bot');
  const files = front.steps ?? { [name]: { bot: front.bot ?? names.bots[0] ?? '' } };
  const order = Object.keys(files);
  if (order.length === 0) say('steps', 'name at least one step');

  const steps = order.map((stepName, i): Step => {
    const s = files[stepName]!;
    const key = `steps.${stepName}`;
    const doers = [s.bot, s.run, s.wait].filter(d => d !== undefined);
    if (doers.length !== 1) say(key, 'name exactly one of bot, run and wait');
    if (s.bot !== undefined && !names.bots.includes(s.bot)) say(`${key}.bot`, `unknown bot ${s.bot}`);
    if (s.skill !== undefined && !names.skills.includes(s.skill)) say(`${key}.skill`, `unknown skill ${s.skill}`);
    for (const check of s.checks ?? []) {
      if (!names.checks.includes(check)) say(`${key}.checks`, `unknown check ${check}`);
    }
    if (s.back !== undefined) {
      const to = order.indexOf(s.back);
      if (to < 0) say(`${key}.back`, `unknown step ${s.back}`);
      else if (to > i) say(`${key}.back`, `${s.back} comes later; a way back goes to this step or an earlier one`);
    }
    if (s.bot !== undefined && s.back !== undefined && s.until === undefined) {
      say(`${key}.until`, 'a bot step with a way back says until when');
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
          : { bot: s.bot ?? '', ...(skill !== undefined && { skill }) };
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
    ...(front.into !== undefined && { into: front.into }),
    steps,
  };
  return { workflow, problems };
}

const waits = (step: Step) => 'wait' in step.does;
const entered = (step: Step): Run['status'] => (waits(step) ? 'waiting' : 'running');

const fresh = ({ carry: _carry, reason: _reason, ...run }: Run): Run => run;

const refusalText = (o: Extract<Outcome, { kind: 'refused' }>) =>
  [
    ...o.failing.map(v => `${v.check}: ${v.findings ?? 'failed'}`),
    ...o.rejected.map(a => `${a.proposal.kind} rejected: ${a.reason ?? 'not allowed'}`),
    ...o.problems,
  ].join('\n');

/** The run at the first step of a workflow. */
export function begin(w: Workflow, run: Pick<Run, 'id' | 'thread' | 'started'>): Run {
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

/** The whole state machine. Entering a step forward drops its session; every other move keeps it. */
export function transition(w: Workflow, run: Run, o: Outcome): Run {
  const i = w.steps.findIndex(s => s.name === run.step);
  const step = w.steps[i];
  if (!step) return run;
  const stop = (why: string): Run => ({ ...fresh(run), status: 'stopped', reason: why });
  const ask = (question: string): Run => ({ ...fresh(run), status: 'asking', reason: question });

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
      carry: `the ${step.name} step sent this back: ${why}`,
    };
  };

  if (run.status === 'running') {
    switch (o.kind) {
      case 'pass':
        return forward();
      case 'refused': {
        const tries = run.tries + 1;
        const text = refusalText(o);
        return tries < step.tries ? { ...fresh(run), tries, carry: text } : { ...ask(text), tries };
      }
      case 'back':
        if (step.back) return back(o.why);
        return transition(w, run, {
          kind: 'refused',
          failing: [],
          rejected: [{ proposal: { kind: 'back', why: o.why }, ok: false, reason: `${step.name} has no way back` }],
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
  if (run.status === 'waiting') {
    if (o.kind === 'pass') return forward();
    if (o.kind === 'back') return back(o.why);
    if (o.kind === 'stop') return stop(o.why);
    return run;
  }
  if (run.status === 'asking') {
    if (o.kind === 'stop') return stop(o.why);
    if (o.kind !== 'answer') return run;
    const taken = run.rounds[step.name] ?? 0;
    const tries = run.tries >= step.tries ? step.tries - 1 : run.tries;
    const outOfRounds = run.tries < step.tries && step.back?.rounds !== undefined && taken >= step.back.rounds;
    const rounds = outOfRounds ? { ...run.rounds, [step.name]: taken - 1 } : run.rounds;
    return { ...fresh(run), status: entered(step), tries, rounds, carry: o.text };
  }
  return run;
}

/** What a new message means for a parked run; undefined when it is only context. */
export function reenter(w: Workflow, run: Run, m: Message): Outcome | undefined {
  if (!m.trusted || m.thread !== run.thread) return undefined;
  if (m.kind === 'closed' && (run.status === 'waiting' || run.status === 'asking'))
    return { kind: 'stop', why: 'closed' };
  const command = Object.values(w.on).find(t => t?.command)?.command;
  const body = m.comment?.body.trim() ?? '';
  const said =
    m.kind === 'comment' && command !== undefined && body.startsWith(command)
      ? body.slice(command.length).trim()
      : undefined;
  if (run.status === 'waiting') {
    if (m.kind === 'merged' || m.kind === 'approved' || (m.kind === 'label' && m.label === 'approved'))
      return { kind: 'pass' };
    if (m.kind === 'changes') return { kind: 'back', why: body || 'changes requested' };
    if (said !== undefined) return { kind: 'back', why: said };
  }
  if (run.status === 'asking' && said !== undefined) {
    const [first = '', ...rest] = said.split(/\s+/);
    return first.toLowerCase() === 'stop'
      ? { kind: 'stop', why: rest.join(' ') || 'a human said stop' }
      : { kind: 'answer', text: said };
  }
  return undefined;
}
