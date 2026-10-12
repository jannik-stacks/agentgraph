import { type AnyStateMachine, createMachine } from 'xstate';
import type { Config } from '../../../src/config.ts';

type Workflow = Config['workflows'][string];
type Job = Workflow['jobs'][string];
type StateConfig = {
  initial?: string;
  type?: 'parallel' | 'final';
  description?: string;
  meta?: { label?: string };
  states?: Record<string, StateConfig>;
  on?: Record<string, Transition | Transition[]>;
  onDone?: Transition | Transition[];
  after?: Record<string, Transition>;
  always?: Transition | Transition[];
};
type Transition = { target: string; guard?: string; reenter?: boolean };

const closures = ['blocked', 'deferred', 'no-op'] as const;

const checkRegion = (): StateConfig => ({
  initial: 'running',
  states: {
    running: { on: { passed: { target: 'pass' }, failed: { target: 'fail' } } },
    pass: { type: 'final' },
    fail: { type: 'final' },
  },
});

const jobState = (machine: string, job: Job, next: string | undefined, config: Config): StateConfig => {
  const bot = job.bot ? config.bots[job.bot] : undefined;
  const notes = [
    job.bot && `bot ${job.bot}${bot ? ` (${bot.harness})` : ''}`,
    job.skill && `skill ${job.skill}`,
    `mode ${job.mode}${job['timeout-minutes'] ? `, ${job['timeout-minutes']} min` : ''}`,
    bot?.notes?.length && `reads notes: ${bot.notes.join(', ')}`,
  ].filter(Boolean);
  const until = job.until;
  const forEach = job['for-each'];
  const working: StateConfig = {
    on: {
      'agent ended': until
        ? { target: 'checking' }
        : forEach
          ? [{ target: 'working', guard: `more ${forEach}s`, reenter: true }, { target: 'closed' }]
          : { target: 'closed' },
    },
  };
  const states: Record<string, StateConfig> = {
    working: forEach ? { ...working, meta: { label: `working per ${forEach}` } } : working,
    closed: { type: 'final' },
  };
  if (until)
    states.checking = {
      type: 'parallel',
      states: Object.fromEntries(until.checks.map(check => [check, checkRegion()])),
      onDone: [
        { target: 'closed', guard: 'all checks pass' },
        { target: 'working', guard: `attempt under ${until.max}`, reenter: true },
        { target: `#${machine}.blocked`, guard: `${until.max} attempts failed, opens unsure issue` },
      ],
    };
  return {
    initial: 'working',
    description: notes.join('\n'),
    states,
    onDone: [
      { target: next ? `#${machine}.${next}` : `#${machine}.done`, guard: 'closure done or handed-off' },
      ...closures.map(closure => ({ target: `#${machine}.${closure}`, guard: `closure ${closure}` })),
    ],
  };
};

const order = (jobs: Workflow['jobs']) => {
  const sorted: string[] = [];
  const visit = (name: string) => {
    if (sorted.includes(name)) return;
    jobs[name]?.needs.forEach(visit);
    sorted.push(name);
  };
  Object.keys(jobs).forEach(visit);
  return sorted;
};

/** A workflow as an XState machine: one compound state per job, check gates as parallel regions, closures as final states. */
export const workflowMachine = (config: Config, name: string): AnyStateMachine => {
  const workflow = config.workflows[name];
  if (!workflow) throw new Error(`no workflow ${name}`);
  const jobs = order(workflow.jobs);
  const triggers = Object.entries(workflow.on).map(([trigger, filter]) => ({
    event: [trigger, filter?.command].filter(Boolean).join(' '),
    guard: filter?.guard ? `author is ${filter.guard.associations.join(', ')}` : undefined,
  }));
  const states: Record<string, StateConfig> = {
    idle: {
      on: Object.fromEntries(
        triggers.map(({ event, guard }) => [event, { target: jobs[0] ?? 'done', ...(guard && { guard }) }])
      ),
    },
    ...Object.fromEntries(
      jobs.map(job => [
        job,
        jobState(
          name,
          workflow.jobs[job]!,
          jobs.find(other => workflow.jobs[other]!.needs.includes(job)),
          config
        ),
      ])
    ),
    done: { type: 'final', description: 'pull request ready, a human merges' },
    ...Object.fromEntries(closures.map(closure => [closure, { type: 'final' } satisfies StateConfig])),
  };
  return createMachine({ id: name, initial: 'idle', states } as Parameters<typeof createMachine>[0]);
};

/** The lifecycle of one run, from queued to its terminal status. */
export const runMachine: AnyStateMachine = createMachine({
  id: 'run',
  initial: 'queued',
  states: {
    queued: {
      on: {
        start: { target: 'running' },
        'needs not met': { target: 'skipped' },
        'process gone': { target: 'interrupted' },
      },
    },
    running: {
      initial: 'sandbox',
      on: { cancel: { target: 'cancelled' }, 'process gone': { target: 'interrupted' } },
      after: { timeout: { target: 'timed-out' } },
      states: {
        sandbox: { on: { ready: { target: 'agent' }, error: { target: '#run.sandbox-failed' } } },
        agent: {
          on: {
            'agent ended': [{ target: 'checks', guard: 'job has until' }, { target: '#run.succeeded' }],
            'agent error': { target: '#run.failed' },
          },
        },
        checks: {
          on: {
            pass: { target: '#run.succeeded' },
            fail: [
              { target: 'agent', guard: 'attempts left', reenter: true },
              { target: '#run.failed' },
            ],
          },
        },
      },
    },
    succeeded: { type: 'final', description: 'closure done, handed-off, blocked, deferred or no-op' },
    failed: { type: 'final' },
    cancelled: { type: 'final' },
    'timed-out': { type: 'final' },
    skipped: { type: 'final' },
    interrupted: { type: 'final' },
    'sandbox-failed': { type: 'final' },
  },
});
