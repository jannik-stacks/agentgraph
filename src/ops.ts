import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { operator, type Message, type Thread } from './channel.ts';
import { isLive, type Run, type Store } from './store.ts';
import type { Runner, Work } from './serve.ts';
import type { BotEvent } from './types.ts';

/** An operation refused, with the HTTP status that says why. */
export class OpError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** One operation: what it does, its input, and how a runner carries it out. */
export type Op<I extends z.ZodObject = z.ZodObject, O = unknown> = {
  description: string;
  input: I;
  run: (runner: Runner, input: z.output<I>) => Promise<O>;
};

const op = <I extends z.ZodObject, O>(definition: Op<I, O>) => definition;

/** Who an operation acts as: the local operator, trusted like a repository owner. */
export const operatorActor = (): BotEvent['actor'] => ({ login: operator(), association: 'OWNER' });

const Target = z.object({
  repo: z.string().optional(),
  issue: z.int().positive().optional(),
  pull: z.int().positive().optional(),
});

/** What starts work: a workflow run on an issue or merge request, or a comment planned through each workflow's `on:`. */
export const TriggerInput = Target.extend({
  workflow: z.string().optional(),
  text: z.string().optional(),
});
export type TriggerInput = z.infer<typeof TriggerInput>;

/** What a trigger started: its event and the jobs it planned, or `held` while the runner is paused. */
export type Started = { event: string; jobs: string[]; held?: true };

const repoOf = (runner: Runner, repo: string | undefined) => {
  const named = repo ?? runner.repo;
  if (!named) throw new OpError('name the repository');
  return named;
};

const threadOf = (runner: Runner, { repo, issue, pull }: z.infer<typeof Target>): Thread => {
  if ((issue === undefined) === (pull === undefined)) throw new OpError('name either an issue or a merge request');
  return { repo: repoOf(runner, repo), ...(pull !== undefined ? { pull } : { issue: issue! }) };
};

/**
 * Starts work as `actor`: with `workflow`, every job of that workflow on the issue or merge request, with `text` as
 * its arguments; without, `text` as a comment on it, which starts what a comment with that text would.
 */
export const trigger = async (runner: Runner, input: TriggerInput, actor: BotEvent['actor']): Promise<Started> => {
  const { workflow, issue, pull, text } = input;
  if (!workflow && !text) throw new OpError('name a workflow or give the comment text');
  if (workflow && !(await runner.config()).workflows[workflow]) throw new OpError(`no workflow "${workflow}"`, 404);
  const number = pull ?? issue;
  const event: BotEvent = {
    id: `${workflow ? 'dispatch' : 'comment'}-${randomUUID()}`,
    ts: new Date().toISOString(),
    source: 'cli',
    trigger: workflow ? 'workflow_dispatch' : 'issue_comment',
    ...(!workflow && { action: 'created' }),
    repo: repoOf(runner, input.repo),
    ...(number !== undefined && { number }),
    ...(pull !== undefined && { pull, ref: `refs/pull/${pull}/head` }),
    actor,
    ...(text && { body: text }),
  };
  return runner.start({ event, ...(workflow && { workflow }) });
};

/** A question a bot asked that no later run of its workflow on the same issue has taken up. */
export type Question = { run: string; repo: string; issue?: number; workflow: string; question: string };

/** The questions bots asked and are waiting on, newest first. */
export const questions = async (store: Store): Promise<Question[]> => {
  const latest = new Map<string, Run>();
  for (const run of await store.list()) {
    const key = `${run.event.repo}#${run.event.number}/${run.workflow}`;
    if (!latest.has(key)) latest.set(key, run);
  }
  const asked = await Promise.all(
    [...latest.values()].map(async run =>
      ((await store.outcome(run.id))?.proposals ?? []).flatMap(p =>
        p.kind === 'ask'
          ? [
              {
                run: run.id,
                repo: run.event.repo,
                ...(run.event.number !== undefined && { issue: run.event.number }),
                workflow: run.workflow,
                question: p.question,
              },
            ]
          : []
      )
    )
  );
  return asked.flat();
};

const held = (work: Work[]) =>
  work.map(({ event, workflow }) => ({
    event: event.id,
    repo: event.repo,
    ...(event.number !== undefined && { issue: event.number }),
    ...(workflow && { workflow }),
  }));

/** Every operation the runner offers, the same over HTTP, the CLI and MCP. */
export const ops = {
  status: op({
    description: 'Whether the runner is paused, the work it holds, the runs going now, open questions and hub errors.',
    input: z.object({}),
    run: async runner => {
      const control = await runner.control();
      return {
        paused: control.paused,
        held: held(control.held),
        live: (await runner.store.list()).filter(isLive),
        questions: await questions(runner.store),
        hubErrors: runner.hubErrors?.() ?? [],
      };
    },
  }),
  runs_list: op({
    description: 'List runs, newest first.',
    input: z.object({ limit: z.int().positive().default(50) }),
    run: async (runner, { limit }) => (await runner.store.list()).slice(0, limit),
  }),
  runs_get: op({
    description: 'Read one run and its outcome.',
    input: z.object({ id: z.string() }),
    run: async (runner, { id }) => {
      const run = await runner.store.read(id);
      if (!run) throw new OpError(`no run "${id}"`, 404);
      return { run, outcome: (await runner.store.outcome(id)) ?? null };
    },
  }),
  runs_stop: op({
    description: 'Stop a run this runner is running; its work is parked and the attempt does not count.',
    input: z.object({ id: z.string() }),
    run: async (runner, { id }) => {
      const stop = runner.stops?.get(id);
      if (!stop) throw new OpError(`run "${id}" is not running here`, 409);
      stop();
      return { stopped: id };
    },
  }),
  trigger: op({
    description:
      'Start work on an issue or merge request: a named workflow with text as its arguments, or text as a comment that starts what its command starts.',
    input: TriggerInput,
    run: (runner, input) => trigger(runner, input, operatorActor()),
  }),
  pause: op({
    description: 'Stop taking new work; triggers wait until resume. With now, also stop the runs going now.',
    input: z.object({ now: z.boolean().default(false) }),
    run: async (runner, { now }) => {
      const stopped = now ? [...(runner.stops?.entries() ?? [])] : [];
      const runs = await Promise.all(stopped.map(([id]) => runner.store.read(id)));
      await runner.edit(control => ({
        paused: true,
        held: [...control.held, ...runs.flatMap(run => (run ? [{ event: run.event, workflow: run.workflow }] : []))],
      }));
      for (const [, stop] of stopped) stop();
      return { paused: true, stopped: stopped.map(([id]) => id) };
    },
  }),
  resume: op({
    description: 'Take new work again and start the work held while paused.',
    input: z.object({}),
    run: async runner => {
      let work: Work[] = [];
      await runner.edit(control => {
        work = control.held;
        return { paused: false, held: [] };
      });
      const unique = [...new Map(work.map(w => [`${w.event.id}/${w.workflow ?? ''}`, w])).values()];
      return { started: await Promise.all(unique.map(w => runner.start(w))) };
    },
  }),
  answer: op({
    description:
      'Answer the open question on an issue: post the answer in its thread and continue the workflow that asked.',
    input: z.object({ issue: z.int().positive(), text: z.string().min(1), repo: z.string().optional() }),
    run: async (runner, { issue, text, repo }) => {
      const named = repoOf(runner, repo);
      const asked = (await questions(runner.store)).find(q => q.repo === named && q.issue === issue);
      if (!asked) throw new OpError(`no open question on #${issue}`, 404);
      const actor = operatorActor();
      await runner.channel.post({ repo: named, issue }, text, actor.login);
      return trigger(runner, { repo: named, issue, workflow: asked.workflow, text }, actor);
    },
  }),
  issues_file: op({
    description: 'File an issue.',
    input: z.object({
      title: z.string().min(1),
      body: z.string().default(''),
      labels: z.array(z.string()).default([]),
      parent: z.int().positive().optional(),
      repo: z.string().optional(),
    }),
    run: async (runner, { repo, parent, ...issue }) => {
      const issues = await runner.issues(repoOf(runner, repo));
      if (!issues) throw new OpError('this runner has no issue tracker', 409);
      const created = await issues.create({ ...issue, ...(parent !== undefined && { parent }) });
      return { number: created.number, ...(created.url && { url: created.url }) };
    },
  }),
  say: op({
    description:
      'Say something in an issue or merge request thread, as a person would on the forge: the runner hears it and starts what it starts.',
    input: Target.extend({ text: z.string().min(1), as: z.string().optional() }),
    run: async (runner, { text, as: author = operator(), ...target }) => {
      const thread = threadOf(runner, target);
      await runner.channel.post(thread, text, author);
      return (await hear(runner, { thread, author, trusted: !author.endsWith('[bot]'), text })) ?? null;
    },
  }),
};

export type Ops = typeof ops;
export type OpName = keyof Ops;
export const opNames = Object.keys(ops) as OpName[];

/** Validates `input` with the op's schema and runs it. */
export const callOp = async (runner: Runner, name: string, input: unknown) => {
  if (!(name in ops)) throw new OpError(`no op "${name}"`, 404);
  const definition = ops[name as OpName] as unknown as Op;
  const parsed = definition.input.safeParse(input ?? {});
  if (!parsed.success) throw new OpError(z.prettifyError(parsed.error));
  return definition.run(runner, parsed.data);
};

/** A client for the ops of the runner served at `url`, over `POST <url>/rpc/<op>`. */
export const rpc =
  (url: string, fetcher: typeof fetch = fetch) =>
  async (name: string, input: unknown = {}): Promise<unknown> => {
    const res = await fetcher(`${url.replace(/\/$/, '')}/rpc/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new OpError(body.error ?? `${name} failed with ${res.status}`, res.status);
    return body;
  };

export type Rpc = ReturnType<typeof rpc>;

const mention = /(^|\s)@bothub\b/i;

/**
 * Turns a message into a trigger: a trusted author's comment starts what its text starts. A mention that starts
 * nothing gets a reply in its thread naming the commands that would.
 */
export const hear = async (runner: Runner, message: Message): Promise<Started | undefined> => {
  if (!message.trusted) return;
  const { thread, text } = message;
  const started = await trigger(
    runner,
    {
      repo: thread.repo,
      text,
      ...(thread.pull !== undefined && { pull: thread.pull }),
      ...(thread.issue !== undefined && { issue: thread.issue }),
    },
    { login: message.author, association: 'OWNER' }
  );
  if (!started.jobs.length && !started.held && mention.test(text)) {
    const commands = Object.values((await runner.config()).workflows).flatMap(w => w.on.issue_comment?.command ?? []);
    await runner.channel.post(
      thread,
      commands.length
        ? `Nothing starts on this. Start a comment with ${commands.join(' or ')}.`
        : 'Nothing starts on a comment in this hub.'
    );
  }
  return started;
};
