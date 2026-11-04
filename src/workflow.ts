import { basename } from 'node:path';
import { Schema, SchemaIssue } from 'effect';
import { parse } from 'yaml';
import type { Applied, Event } from './event.ts';
import { Kind, type Proposal } from './proposal.ts';
import type { Result } from './result.ts';
import type { PluginMetadata } from './meta.ts';

/**
 * A check's result: whether it passed, the `value` its result held when the check has its own `returns`, and with
 * `each` the `share` of items that passed. `empty` means no evidence: `each` found nothing, or a result could not
 * be read, with the reason in `findings`.
 */
export type CheckResult = {
  check: string;
  pass: boolean;
  value?: Result;
  share?: number;
  empty?: true;
  na?: true;
  findings?: string;
  ms: number;
};

/** A graph file after parsing: its name, where it lives and its markdown body. */
export type Doc<T> = T & { name: string; path: string; body: string };

export type Problem = { path: string; message: string };

/**
 * An ordered list of steps; the body is the description, or the prompt when there are no steps. `dispatch` starts it
 * only from a `run` proposal, `feedback` on what a trusted person says or pushes where another run worked, `conflict`
 * when the pull request of a run waiting on a human conflicts with its base.
 */
export type Workflow = Doc<{
  on: Partial<
    Record<
      'issues' | 'issue_comment' | 'pull_request' | 'dispatch' | 'feedback' | 'conflict',
      { label?: string; column?: string; project?: string; branches?: string[] }
    >
  >;
  branch?: string;
  base?: string;
  /** What a trusted comment does to a run that is working: reach its session, wait for the try to end, or cut the try short. */
  concurrency: 'steer' | 'queue' | 'cancel';
  steps: Step[];
  checks: string[];
}>;

/**
 * One step. On a `wait` step, `checks` are what runs again when the pull request's base moves and its change stays the
 * same, and `follow` is how the branch follows the base: a merge commit, a rebase, or not at all.
 */
export type Step = {
  name: string;
  does:
    | { agent: string; skill?: string }
    | { run: string; returns: NonNullable<(typeof StepFile.Type)['returns']>; reads?: 'traces' }
    | { wait: 'human' };
  checks: string[];
  follow?: 'merge' | 'rebase' | 'none';
  tries: number;
  carry?: boolean;
  back?: { to: string; until?: string; rounds?: number };
  each?: 'files' | 'hunks' | { run: string };
};

/** How one try of a step ended, or what a human said to a waiting run. */
export type Outcome =
  | { kind: 'pass'; answered?: true; text?: string }
  | { kind: 'failed'; checks: CheckResult[]; proposals: Applied[]; problems: string[] }
  | { kind: 'back'; why: string }
  | { kind: 'ask'; question: string }
  | { kind: 'answer'; text: string }
  | { kind: 'stop'; why: string };

/** How far a session has read its issues: the time of the last event it saw and the base its pull request was on. */
export type Seen = { at: string; base?: string };

/** Where one workflow run on one issue stands. */
export type Run = {
  meta?: PluginMetadata;
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
  /** What a human answered or said to the run, with the question each answer settled. */
  answers?: { asked: string; said: string }[];
  reason?: string;
  /** A runner error has already been retried at this step. */
  retried?: true;
  /** The time of the newest event the run has taken in: its start, answers, and everything its sessions were shown. */
  seen?: string;
  comment?: string;
  /** Where humans last spoke to the run: the issue, and each review thread it has yet to answer. */
  said?: { issue: number; under?: string }[];
  /** The 👀 the run gave where it was woken, as the proposal that takes it back once the run has replied. */
  eyes?: { issue: number; undo: Extract<Proposal, { kind: 'react' }> };
  /** The open pull request the run stacks on; from keeps the successful base while a follow is pending. */
  base?: { pull: number; branch: string; sha: string; from?: string };
  /**
   * The base head the next push lands on, when following it conflicted: the work tree starts there with the change
   * applied and conflict markers left, and the push replaces the branch, or merges into it with `merge`.
   */
  onto?: { sha: string; merge?: true };
  /** The version of the graph the run was last checked under. */
  graph?: string;
  graphTree?: string;
  blocked?: { base: string; head: string; graph: string };
  /** The run whose `run` proposal started this one. */
  by?: string;
  startCommit?: string;
  owed?: string[];
  unshown?: true;
  started: string;
  ended?: string;
};

export type RunRecord = Omit<Run, 'issue'> & Partial<Pick<Run, 'issue'>>;

export const isRunDone = (run: RunRecord) => run.status === 'done' || run.status === 'stopped';

const Count = Schema.Int.check(Schema.isGreaterThan(0));
const Names = Schema.mutable(Schema.Array(Schema.String));
const Trigger = Schema.NullOr(
  Schema.Struct({
    label: Schema.optionalKey(Schema.String),
    column: Schema.optionalKey(Schema.String),
    project: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[\w.-]+\/\d+$/, { message: 'owner/number' }))),
    branches: Schema.optionalKey(Names),
  })
);
const EventName = Schema.Literals(['issues', 'issue_comment', 'pull_request', 'dispatch', 'feedback', 'conflict']);

const StepFile = Schema.Struct({
  agent: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  returns: Schema.optionalKey(Schema.mutable(Schema.Array(Kind))),
  reads: Schema.optionalKey(Schema.Literal('traces')),
  wait: Schema.optionalKey(Schema.Literal('human')),
  follow: Schema.optionalKey(Schema.Literals(['merge', 'rebase', 'none'])),
  skill: Schema.optionalKey(Schema.String),
  checks: Schema.optionalKey(Names),
  tries: Schema.optionalKey(Count),
  carry: Schema.optionalKey(Schema.Boolean),
  back: Schema.optionalKey(Schema.String),
  until: Schema.optionalKey(Schema.String),
  rounds: Schema.optionalKey(Count),
  each: Schema.optionalKey(Schema.Union([Schema.Literals(['files', 'hunks']), Schema.Struct({ run: Schema.String })])),
});

const Front = Schema.Struct({
  on: Schema.Union([
    EventName,
    Schema.Struct({
      issues: Schema.optionalKey(Trigger),
      issue_comment: Schema.optionalKey(Trigger),
      pull_request: Schema.optionalKey(Trigger),
      dispatch: Schema.optionalKey(Schema.Null),
      feedback: Schema.optionalKey(Schema.Null),
      conflict: Schema.optionalKey(Schema.Null),
    }),
  ]),
  branch: Schema.optionalKey(Schema.String),
  base: Schema.optionalKey(Schema.String),
  concurrency: Schema.optionalKey(Schema.Literals(['steer', 'queue', 'cancel'])),
  agent: Schema.optionalKey(Schema.String),
  steps: Schema.optionalKey(Schema.Record(Schema.String, StepFile)),
  checks: Schema.optionalKey(Names),
});

const decode = Schema.decodeUnknownResult(Front, { onExcessProperty: 'error', errors: 'all' });

/** Splits a markdown file into its parsed YAML frontmatter and its trimmed body. */
export const splitFrontmatter = (text: string): { data: unknown; body: string } => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  return m ? { data: parse(m[1] ?? '') ?? {}, body: (m[2] ?? '').trim() } : { data: {}, body: text.trim() };
};

const formatLeaf: SchemaIssue.LeafHook = issue =>
  issue._tag === 'UnexpectedKey' && issue.ast._tag === 'Objects'
    ? `is unexpected, expected: ${issue.ast.propertySignatures.map(p => `"${String(p.name)}"`).join(' | ')}`
    : SchemaIssue.defaultLeafHook(issue);

export const formatIssues = (issue: SchemaIssue.Issue) => {
  const seen = new Set<string>();
  return SchemaIssue.makeFormatterStandardSchemaV1({ leafHook: formatLeaf })(issue)
    .issues.map(({ path, message }) => ({ key: path?.join('.') || 'frontmatter', message }))
    .filter(({ key }) => !seen.has(key) && seen.add(key));
};

/** Parses a workflow file and fills its defaults. Problems are data; the workflow is set only when there are none. */
export function compileWorkflow(
  path: string,
  text: string,
  names: Record<'agents' | 'skills' | 'checks', string[]> & { judged?: string[]; warned?: string[] }
): { workflow?: Workflow; problems: Problem[] } {
  const problems: Problem[] = [];
  const say = (key: string, message: string) => problems.push({ path, message: `${key}: ${message}` });
  let file: { data: unknown; body: string };
  try {
    file = splitFrontmatter(text);
  } catch (e) {
    return { problems: [{ path, message: `frontmatter: ${(e as Error).message}` }] };
  }
  const decoded = decode(file.data);
  if (decoded._tag === 'Failure') {
    for (const { key, message } of formatIssues(decoded.failure.issue)) say(key, message);
    return { problems };
  }
  const front = decoded.success;
  const name = basename(path, '.md');
  if (commandVerbs.includes(name))
    problems.push({ path, message: `${name} is the command /agent:${name}; rename the workflow` });
  const trigger = typeof front.on === 'string' ? undefined : front.on.issues;
  if (trigger?.project !== undefined && trigger.column === undefined) say('on.issues.project', 'project needs column');

  if (front.steps && front.agent) say('agent', 'only a workflow without steps names its agent');
  if (!front.steps && !front.agent && names.agents.length !== 1)
    say('agent', 'a workflow without steps names its agent');
  const files = front.steps ?? { [name]: { agent: front.agent ?? names.agents[0] ?? '' } };
  const order = Object.keys(files);
  if (order.length === 0) say('steps', 'name at least one step');
  for (const check of front.checks ?? []) {
    if (!names.checks.includes(check)) say('checks', `unknown check ${check}`);
    else if (names.warned && !names.warned.includes(check))
      say('checks', `${check} runs at the end, so its mode is info or warn`);
  }

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
    if (s.follow !== undefined && s.wait === undefined) say(`${key}.follow`, 'only a wait step follows its base');
    if (s.returns !== undefined && s.run === undefined)
      say(`${key}.returns`, "only a run step lists returns; an agent's returns are in its file");
    if (s.reads !== undefined && s.run === undefined)
      say(`${key}.reads`, 'only a run step reads traces; an agent says so in its file');

    const scripts = (files[s.back ?? '']?.checks ?? []).filter(c => !names.judged?.includes(c));
    const checks = s.checks ?? (s.wait !== undefined ? scripts : []);
    const skill = s.skill ?? (names.skills.includes(stepName) ? stepName : undefined);
    const does: Step['does'] =
      s.run !== undefined
        ? { run: s.run, returns: s.returns ?? ['run'], ...(s.reads && { reads: s.reads }) }
        : s.wait !== undefined
          ? { wait: 'human' }
          : { agent: s.agent ?? '', ...(skill !== undefined && { skill }) };
    const rounds = s.rounds ?? (s.wait ? undefined : 3);
    return {
      name: stepName,
      does,
      checks,
      tries: s.tries ?? (checks.length > 0 && s.wait === undefined ? 3 : 1),
      ...(s.back !== undefined && {
        back: {
          to: s.back,
          ...(s.until !== undefined && { until: s.until }),
          ...(rounds !== undefined && { rounds }),
        },
      }),
      ...(s.carry !== undefined && { carry: s.carry }),
      ...(s.each !== undefined && { each: s.each }),
      ...(s.wait !== undefined && { follow: s.follow ?? 'merge' }),
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
    concurrency: front.concurrency ?? 'steer',
    steps,
    checks: front.checks ?? [],
  };
  return { workflow, problems };
}

export const isHumanWaitStep = (step: Step) => 'wait' in step.does;
export const isQuiet = (w: Workflow) => w.on.feedback !== undefined || w.on.conflict !== undefined;
const entered = (step: Step): Run['status'] => (isHumanWaitStep(step) ? 'waiting' : 'running');

const fresh = ({ feedback: _feedback, reason: _reason, retried: _retried, ...run }: Run): Run => run;

/** Why a try that leaves its checkout at base fails: its agent returns code and no pull request or finished run holds work. */
export const unchanged = (returns: readonly string[], held: boolean) =>
  !held && returns.includes('push')
    ? 'no change was made: change the files the issue needs and push them, or ask'
    : undefined;

const unapplied =
  'Nothing from this reply was applied: fix what failed, then send every proposal again, not only the fixed ones. Only you see these findings, so answer them by changing the code, not with a comment.';

export const formatFailedTryFeedback = (o: Extract<Outcome, { kind: 'failed' }>) =>
  [
    ...o.checks.map(c => `${c.check}: ${c.findings ?? 'failed'}`),
    ...o.proposals.map(a => `${a.proposal.kind} failed: ${a.reason ?? 'not allowed'}`),
    ...o.problems,
  ].join('\n');

const readable = (findings: string) =>
  findings
    .split('\n')
    .map(line => {
      try {
        const finding: unknown = JSON.parse(line);
        if (finding && typeof finding === 'object' && 'why' in finding && typeof finding.why === 'string')
          return 'at' in finding && typeof finding.at === 'string' ? `${finding.at}: ${finding.why}` : finding.why;
      } catch {}
      return line;
    })
    .join('\n');

/** The run at the first step of a workflow, or at `first`. */
export function begin(w: Workflow, run: Pick<Run, 'id' | 'issue' | 'started'>, first = w.steps[0]!): Run {
  return {
    ...run,
    workflow: w.name,
    step: first.name,
    status: entered(first),
    tries: 0,
    rounds: {},
    sessions: {},
  };
}

/** Moves a run to its next state. Entering a step forward drops its session; every other move keeps it. */
export function transition(w: Workflow, run: Run, o: Outcome): Run {
  const i = w.steps.findIndex(s => s.name === run.step);
  const step = w.steps[i];
  if (!step) return run;
  const owed = w.checks.length > 0 && { owed: w.checks };
  const stop = (why: string): Run => ({ ...fresh(run), status: 'stopped', reason: why, ...owed });
  const ask = (question: string): Run =>
    isQuiet(w) ? stop(question) : { ...fresh(run), status: 'waiting', reason: question };

  const forward = (): Run => {
    const next = w.steps[i + 1];
    if (!next) return { ...fresh(run), status: 'done', ...owed };
    const { [next.name]: _dropped, ...sessions } = run.sessions;
    return {
      ...fresh(run),
      step: next.name,
      status: entered(next),
      tries: 0,
      sessions,
      ...(step.carry &&
        o.kind === 'pass' &&
        o.text && {
          feedback: `## What the ${step.name} step reported\n\n${o.text}`,
        }),
    };
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
        return o.answered ? { ...fresh(run), status: 'done', ...owed } : forward();
      case 'failed': {
        const tries = run.tries + 1;
        const text = formatFailedTryFeedback(o);
        const question =
          o.checks.length > 0
            ? [
                `${step.name} failed after ${tries} tries (checks: ${o.checks.map(c => c.check).join(', ')}).`,
                formatFailedTryFeedback({
                  ...o,
                  checks: o.checks.map(c => ({
                    ...c,
                    ...(c.findings !== undefined && { findings: readable(c.findings) }),
                  })),
                }),
                'How should I proceed?',
              ].join('\n\n')
            : text;
        const feedback = [
          ...(run.answers ?? []).map(answer => answer.said),
          text,
          o.proposals.length === 0 && unapplied,
        ]
          .filter(Boolean)
          .join('\n\n');
        return tries < step.tries ? { ...fresh(run), tries, feedback } : { ...ask(question), tries, feedback };
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
        return {
          ...run,
          feedback: [run.feedback, o.text].filter(Boolean).join('\n\n'),
          answers: [...(run.answers ?? []), { asked: '', said: o.text }],
        };
    }
  }
  if (run.status === 'waiting' && isHumanWaitStep(step)) {
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
    const feedback = run.retried ? [run.feedback, o.text].filter(Boolean).join('\n\n') : o.text;
    return { ...fresh(run), status: entered(step), tries, rounds, feedback, answers };
  }
  return run;
}

export function makeRunWithFreshRound(w: Workflow, run: Run): Run {
  const step = w.steps.find(s => s.name === run.step);
  const cap = step?.back?.rounds;
  const taken = run.rounds[run.step] ?? 0;
  if (run.status !== 'waiting' || !step || !isHumanWaitStep(step) || cap === undefined || taken < cap) return run;
  return { ...run, rounds: { ...run.rounds, [run.step]: taken - 1 } };
}

const issueSources: Record<string, (trigger: NonNullable<Workflow['on']['issues']>, m: Event) => boolean> = {
  label: (t, m) => m.kind === 'label' && m.label === t.label && m.trusted,
  column: (t, m) =>
    m.kind === 'column' &&
    m.column?.name === t.column &&
    (t.project === undefined ? m.trusted : t.project === m.column?.project),
};

export const isIssueTriggered = (w: Workflow, m: Event) =>
  w.on.issues !== undefined && Object.values(issueSources).some(matches => matches(w.on.issues!, m));

/** What a comment says to the bot, or undefined when it does not call it with `/agent`. */
export const parseAgentRequest = (m: Event) => (m.kind === 'comment' ? m.comment?.agentRequest : undefined);

export const CommandSettings = Schema.Record(
  Schema.String,
  Schema.Union([Schema.Boolean, Schema.Array(Schema.String)])
);

export const commandVerbs = ['stop', 'cancel', 'restart'];

export function getCommand(
  m: Event,
  picks: Workflow[],
  target: Workflow | undefined,
  commands: typeof CommandSettings.Type = {}
) {
  const said = parseAgentRequest(m) ?? '';
  const found = /^:[\w-]+(?::[\w-]+)*/.exec(said);
  if (!found) return undefined;
  const words = found[0].slice(1).split(':');
  const picked = picks.find(w => w.name === words[0]);
  const [verb, step, ...extra] = picked ? words.slice(1) : words;
  const workflow = picked ?? target;
  if (
    (verb !== undefined && !commandVerbs.includes(verb)) ||
    (step !== undefined && verb !== 'restart') ||
    extra.length
  )
    return {
      why: `\`/agent${found[0]}\` is not a command. Use ${[...commandVerbs, 'restart:<step>', ...picks.map(w => w.name)]
        .map(c => `\`/agent:${c}\``)
        .join(', ')}.`,
    };
  if (step !== undefined && !workflow?.steps.some(s => s.name === step))
    return {
      why: `\`/agent${found[0]}\`: ${workflow?.name ?? 'the issue'} has no step ${step}. Its steps are ${
        workflow?.steps.map(s => s.name).join(', ') ?? 'none'
      }.`,
    };
  const whyNot = (name: string) => {
    const allowed = commands[name] ?? true;
    if (allowed === false) return `\`/agent:${name}\` is turned off here.`;
    if (allowed !== true && !allowed.includes(m.actor)) return `Only ${allowed.join(', ')} may use \`/agent:${name}\`.`;
  };
  const why = m.source === 'cli' ? undefined : [picked?.name, verb].map(name => name && whyNot(name)).find(Boolean);
  return why ? { why } : { workflow: picked, verb, step, text: said.slice(found[0].length).trim() };
}

/**
 * The question a run parks with when a human cancels the try it is on.
 * @internal
 */
export const cancelled = 'Cancelled. Say /agent and how to go on from here, or /agent:stop to end the run.';

/**
 * What a new event means for a live run: a review at a human step, an answer elsewhere, `/agent:cancel` parks a working
 * run; undefined when it is only context or a command `commands` refuses. `lined` are the line comments that came with
 * a review.
 */
export function getEventOutcome(
  w: Workflow,
  run: Run,
  m: Event,
  lined: Event[] = [],
  commands?: typeof CommandSettings.Type
): Outcome | undefined {
  if (!m.trusted || m.issue !== run.issue) return undefined;
  const label = w.on.issues?.label;
  if (m.kind === 'unlabel' && label !== undefined && m.label === label && run.status !== 'done')
    return { kind: 'stop', why: `the ${label} label was removed` };
  const waiting = run.status === 'waiting';
  if (m.kind === 'closed' && !isRunDone(run)) return { kind: 'stop', why: 'closed' };
  const said = parseAgentRequest(m);
  const body = m.comment?.body.trim() ?? '';
  const command = getCommand(m, w.on.issue_comment ? [w] : [], w, commands);
  if (command && 'why' in command) return undefined;
  if (command?.verb === 'stop' && !isRunDone(run)) return { kind: 'stop', why: command.text || 'a human said stop' };
  if (command?.verb === 'restart' && !isRunDone(run)) return { kind: 'stop', why: 'a human restarted it' };
  if (command?.verb === 'cancel') return run.status === 'running' ? { kind: 'ask', question: cancelled } : undefined;
  const step = w.steps.find(s => s.name === run.step);
  if (waiting && step && isHumanWaitStep(step)) {
    if (m.kind === 'merged' || m.kind === 'approved' || (m.kind === 'label' && m.label === 'approved'))
      return { kind: 'pass' };
    if (m.kind === 'changes_requested') {
      const notes = lined.flatMap(l =>
        l.comment?.path
          ? `${l.comment.path}${l.comment.line ? `:${l.comment.line}` : ''}: ${l.comment.agentRequest ?? l.comment.body}`
          : []
      );
      return { kind: 'back', why: [body || 'changes requested', ...notes].join('\n') };
    }
  }
  if (said !== undefined && !isRunDone(run)) return { kind: 'answer', text: command?.text ?? said };
  return undefined;
}

/** Several outcomes at once as one: the first that is not an answer, else every answer joined. */
export const fold = (outcomes: Outcome[]): Outcome | undefined => {
  const answers = outcomes.flatMap(o => (o.kind === 'answer' ? [o.text] : []));
  return (
    outcomes.find(o => o.kind !== 'answer') ??
    (answers.length > 0 ? { kind: 'answer', text: answers.join('\n\n') } : undefined)
  );
};
