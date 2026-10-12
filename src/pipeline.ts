import { Effect } from 'effect';
import { apply } from './apply.ts';
import { jobOrder, type Config, type Persona, type Workflow } from './config.ts';
import type { PlannedJob } from './dispatch.ts';
import { executors } from './executors/index.ts';
import type { GitHub } from './github-app.ts';
import { extractProposals, validate, type Proposal } from './outputs.ts';
import { runJob, type limiter } from './runner.ts';
import { SafeOutputKind, type Executor, type Job } from './schema.ts';
import type { EventRecord, Outcome, Run, Store } from './store.ts';
import type { BotEvent, ExecutorAdapter, RunSpec } from './types.ts';
import type { Workspaces } from './workspace.ts';

const examples: Record<SafeOutputKind, string> = {
  reply: '{ "kind": "reply", "body": "Markdown comment on the issue or pull request" }',
  label: '{ "kind": "label", "add": ["bug"], "remove": ["needs-triage"] }',
  'push-branch': '{ "kind": "push-branch", "branch": "bothub/<issue>-<slug>", "files": ["src/changed.ts"] }',
  'open-pr':
    '{ "kind": "open-pr", "title": "…", "body": "Closes #<issue>", "head": "bothub/<issue>-<slug>", "base": "main", "draft": true }',
  'propose-rule': '{ "kind": "propose-rule", "path": "rules/<name>.md", "content": "The rule, in Markdown" }',
  'ask-human': '{ "kind": "ask-human", "question": "What should happen when …?" }',
};

const proposing = (kinds: SafeOutputKind[]) => {
  const has = (kind: SafeOutputKind) => kinds.includes(kind);
  const notes = [
    (has('push-branch') || has('open-pr')) && 'Branches must start with `bothub/`.',
    has('push-branch') && '`files` lists every file you changed, as repository-relative paths.',
    has('open-pr') && 'Leave out `base` to target the default branch.',
    'Include only the proposals you need.',
  ].filter(Boolean);
  return [
    '## Proposing changes',
    '',
    'You cannot write to GitHub yourself. To post a comment, label, push or open a pull request, end your',
    'final message with one fenced block tagged `bothub` that holds a JSON array of proposals. Only the',
    'last such block counts. Anything the job does not allow is rejected.',
    '',
    '```bothub',
    '[',
    kinds.map(kind => `  ${examples[kind]}`).join(',\n'),
    ']',
    '```',
    '',
    notes.join(' '),
  ].join('\n');
};

const fenced = (text: string) => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
};

const eventContext = (event: BotEvent, args: string | undefined) => {
  const facts = [
    `Repository: ${event.repo}`,
    event.number !== undefined && `Number: #${event.number}`,
    `Actor: @${event.actor.login} (${event.actor.association})`,
    event.url && `URL: ${event.url}`,
    `Trigger: ${event.trigger}${event.action ? ` (${event.action})` : ''}`,
    event.ref && `Ref: ${event.ref}`,
  ].filter(Boolean);
  const quoted =
    args !== undefined
      ? `Command arguments:\n\n${fenced(args)}`
      : event.body
        ? `Text:\n\n${fenced(event.body)}`
        : undefined;
  return ['## Event', facts.join('\n'), quoted].filter(Boolean).join('\n\n');
};

/** The agent session for one job: persona instructions plus the proposal format, and the job prompt plus the event. */
export const buildSpec = ({
  persona,
  workflow,
  job,
  args,
  event,
  cwd,
}: Pick<PlannedJob, 'job' | 'args'> & { persona: Persona; workflow: Workflow; event: BotEvent; cwd: string }) => {
  const definition = workflow.jobs[job];
  if (!definition) throw new Error(`workflow "${workflow.name}" has no job "${job}"`);
  const kinds = SafeOutputKind.options.filter(kind => kind in definition['safe-outputs']);
  const spec: RunSpec = {
    prompt: [workflow.prompts[job], eventContext(event, args)].filter(Boolean).join('\n\n'),
    system: [persona.prompt, kinds.length ? proposing(kinds) : ''].filter(Boolean).join('\n\n'),
    cwd,
    ...(persona.model && { model: persona.model }),
    tools: persona.tools,
    maxTurns: persona['max-turns'],
  };
  return { spec, timeoutMinutes: definition['timeout-minutes'] ?? persona['timeout-minutes'] };
};

const secretKeys: Record<Executor, string[]> = { 'claude-code': ['CLAUDE_CODE_OAUTH_TOKEN'], codex: [] };

/** The secrets an executor needs, picked from `env`. */
export const secretsFor = (executor: Executor, env: Record<string, string | undefined>) =>
  Object.fromEntries(secretKeys[executor].flatMap(key => (env[key] ? [[key, env[key]]] : [])));

/** Everything a planned job needs to run. Without `gh`, nothing is applied. */
export type Pipeline = {
  config: Config;
  event: BotEvent;
  store: Store;
  workspaces: Workspaces;
  limit: Effect.Effect.Success<ReturnType<typeof limiter>>;
  env: Record<string, string | undefined>;
  gh?: GitHub;
  adapters?: Record<Executor, ExecutorAdapter>;
  onEvent?: (run: Run, record: EventRecord) => void;
};

/** A planned job, either skipped with a stored reason or run with its outcome once the agent finished. */
export type JobResult = PlannedJob & ({ skipped: string } | { run: Run; outcome?: Outcome });

const settle = async (final: string, run: Run, job: Job, p: Pipeline): Promise<Outcome> => {
  const { proposals, errors } = extractProposals(final);
  const { accepted, rejected, apply: allowed } = validate(proposals, job['safe-outputs'], job.mode);
  const { gh, event, workspaces } = p;
  const applied = run.status === 'succeeded' && allowed && gh !== undefined;
  const paths = job['safe-outputs']['push-branch']?.paths;
  const push = ({ kind: _, ...proposal }: Extract<Proposal, { kind: 'push-branch' }>) =>
    workspaces.publish(event.repo, run.id, { ...proposal, ...(paths && { paths }), message: `bothub: ${run.job}` });
  const results = applied ? await apply(accepted, { event, gh, push }) : [];
  return { proposals, errors, accepted, rejected, results, applied };
};

const skip = async (planned: PlannedJob, reason: string, p: Pipeline): Promise<JobResult> => {
  const { workflow, job, persona } = planned;
  await p.store.create({ workflow, job, ...(persona && { persona }), event: p.event, status: 'skipped', reason });
  return { ...planned, skipped: reason };
};

/**
 * Runs one planned job in a fresh worktree, then validates its proposals and applies them when the job's mode and
 * a GitHub client allow it. The outcome is stored next to the run and the worktree is always removed.
 */
export const runPlanned = (planned: PlannedJob, p: Pipeline): Effect.Effect<JobResult> =>
  Effect.gen(function* () {
    const workflow = p.config.workflows[planned.workflow];
    const job = workflow?.jobs[planned.job];
    const persona = planned.persona ? p.config.personas[planned.persona] : undefined;
    if (!workflow || !job) return yield* Effect.promise(() => skip(planned, 'the job is not in the config', p));
    if (!persona) return yield* Effect.promise(() => skip(planned, 'the job has no persona', p));

    const { store, event } = p;
    const created = yield* Effect.promise(() =>
      store.create({
        workflow: planned.workflow,
        job: planned.job,
        persona: persona.name,
        executor: persona.executor,
        event,
      })
    );
    const fail = (e: unknown) =>
      Effect.promise(() =>
        store.update(created.id, {
          status: 'failed',
          error: e instanceof Error ? e.message : String(e),
          endedAt: new Date().toISOString(),
        })
      );

    const execute = (cwd: string) =>
      Effect.gen(function* () {
        const { spec, timeoutMinutes } = buildSpec({ ...planned, persona, workflow, event, cwd });
        let result: string | undefined;
        let lastText = '';
        const run = yield* runJob({
          adapter: (p.adapters ?? executors)[persona.executor],
          spec,
          timeoutMinutes,
          store,
          runId: created.id,
          secrets: secretsFor(persona.executor, p.env),
          onEvent: record => {
            if (record.event.type === 'text') lastText = record.event.text;
            if (record.event.type === 'end') result = record.event.result;
            p.onEvent?.(created, record);
          },
        });
        const outcome = yield* Effect.promise(() => settle(result ?? lastText, run, job, p));
        yield* Effect.promise(() => store.saveOutcome(run.id, outcome));
        return { ...planned, run, outcome };
      });

    return yield* p.limit(
      Effect.acquireUseRelease(
        Effect.tryPromise(() => p.workspaces.create(event, created.id)),
        execute,
        () => Effect.promise(() => p.workspaces.remove(event.repo, created.id))
      ).pipe(Effect.catchAll(e => Effect.map(fail(e.error), run => ({ ...planned, run }))))
    );
  });

/**
 * Runs planned jobs workflow by workflow, each in dependency order. A job whose `needs` did not all succeed in
 * this run is skipped.
 */
export const runPlan = (planned: PlannedJob[], p: Pipeline): Effect.Effect<JobResult[]> =>
  Effect.forEach(
    [...new Set(planned.map(j => j.workflow))],
    name =>
      Effect.gen(function* () {
        const workflow = p.config.workflows[name];
        const results: JobResult[] = [];
        const succeeded = new Set<string>();
        for (const id of workflow ? jobOrder(workflow) : []) {
          const job = planned.find(j => j.workflow === name && j.job === id);
          if (!job) continue;
          const blocked = workflow?.jobs[id]?.needs.filter(need => !succeeded.has(need)) ?? [];
          const reason = `needs ${blocked.map(need => `"${need}"`).join(', ')}, which did not succeed`;
          const result = blocked.length ? yield* Effect.promise(() => skip(job, reason, p)) : yield* runPlanned(job, p);
          if ('run' in result && result.run.status === 'succeeded') succeeded.add(id);
          results.push(result);
        }
        return results;
      }),
    { concurrency: 'unbounded' }
  ).pipe(Effect.map(results => results.flat()));
