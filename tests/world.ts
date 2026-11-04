import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { onTestFinished } from 'vitest';
import { folderTracker, Tracker, TrackerError, currentRunLinkRef } from '../src/tracker.ts';
import type { Event, IssueStatus, RunLink } from '../src/event.ts';
import type { Proposal } from '../src/proposal.ts';
import { Sandbox, type Command } from '../src/sandbox.ts';
import { Session } from '../src/session.ts';
import { fileStore, Store } from '../src/store.ts';
import type { CheckEntry, Trace, SessionEvent, SessionSpec } from '../src/trace.ts';
import type { Graph } from '../src/folder.ts';
import { begin, type Run } from '../src/workflow.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { makeTestGraph, result, seeded, start } from './fixtures.ts';
import { runWorkflow } from '../src/run/drive.ts';
import { appendIssueAt, issuePath, writeIssueAt } from './kit.ts';

export const replyHint = 'Reply `/agent` and your answer, or `/agent stop` to end the run.';
export const graph = makeTestGraph('kit', {
  types: { run: '! grep -q TODO hello.txt' },
  safety: { run: '! test -e secret.txt' },
  claims: { agent: 'claim-checker' },
});
export const w = graph.workflows.issue!;

export const removeAfter = (dir: string) => onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

/** A bare origin with one commit on main, a tracker with issue #7 and its `/agent` comment, and a data dir. */
export const world = () => {
  const { root, data } = seeded(
    'run',
    {
      'README.md': 'demo\n',
      'package.json': JSON.stringify({ scripts: { test: '! grep -q TODO hello.txt' } }),
    },
    'tracker/origin.git'
  );
  removeAfter(root);
  const tracker = join(root, 'tracker');
  writeIssueAt(
    issuePath(tracker, 7),
    '---\ntitle: Add a greeting\nstate: open\nauthor: morgan\nlabels: []\n---\n\nAdd hello.txt.\n'
  );
  const human = (body: string, at: string) =>
    appendIssueAt(
      issuePath(tracker, 7, 'events.jsonl'),
      `${JSON.stringify({ issue: 7, kind: 'comment', actor: 'morgan', trusted: true, at, comment: { id: at, author: 'morgan', body, at } } satisfies Event)}\n`
    );
  human('/agent', '2026-10-16T00:00:00.000Z');
  return { root, origin: join(tracker, 'origin.git'), tracker, data, human };
};

export const push = { kind: 'push', branch: 'agentgraph/7', message: 'Add hello' } satisfies Proposal;
export const pull = {
  kind: 'pull_request',
  branch: 'agentgraph/7',
  base: 'main',
  title: 'Add hello',
  body: 'Closes #7',
} satisfies Proposal;
export const judged: SessionEvent[] = [
  start('j'),
  { type: 'usage', input: 4, output: 2, usd: 0.25 },
  result({ pass: true, why: 'no claims' }),
];

/** The file doubles, with every session spec and every sandbox command recorded, both also in `order`. */
export const services = (
  where: ReturnType<typeof world>,
  turns: SessionEvent[][],
  slug?: string,
  opened: (spec: SessionSpec) => unknown = () => undefined,
  refuse: (status: IssueStatus) => boolean = () => false
) => {
  const specs: SessionSpec[] = [];
  const commands: Command[] = [];
  const order: (SessionSpec | Command)[] = [];
  const marks: [Proposal['kind'], RunLink | undefined][] = [];
  const recording = Layer.effect(
    Session,
    Effect.map(Session, s => ({
      open: (spec: SessionSpec) => (specs.push(spec), order.push(spec), opened(spec), s.open(spec)),
    }))
  ).pipe(Layer.provide(replaySession(turns)));
  const sandbox = Layer.effect(
    Sandbox,
    Effect.map(Sandbox, s => ({
      ...s,
      exec: (c: Command) => (commands.push(c), order.push(c), s.exec(c)),
    }))
  ).pipe(Layer.provide(hostSandbox(where.origin)));
  const named = Layer.effect(
    Tracker,
    Effect.map(Tracker, f => ({
      ...f,
      ...(slug && { slug: Effect.succeed(slug) }),
      apply: (n: number, p: Proposal, work?: Parameters<typeof f.apply>[2]) =>
        Effect.andThen(
          Effect.map(currentRunLinkRef, mark => marks.push([p.kind, mark])),
          f.apply(n, p, work)
        ),
      status: (...args: Parameters<NonNullable<typeof f.status>>) =>
        refuse(args[1])
          ? Effect.fail(new TrackerError({ message: 'refused' }))
          : Effect.andThen(
              Effect.map(currentRunLinkRef, mark => marks.push(['label', mark])),
              f.status!(...args)
            ),
    }))
  ).pipe(Layer.provide(folderTracker(where.tracker)));
  const layer = Layer.mergeAll(named, fileStore(where.data), sandbox, recording);
  const run = <A, E>(effect: Effect.Effect<A, E, Tracker | Store | Session | Sandbox>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
  return { specs, commands, order, marks, run };
};

const readLines = <A>(path: string) =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as A)
    : [];

export const readTrace = (data: string, id: string) => readLines<Trace>(join(data, id, 'trace.jsonl'));

export const readChecks = (data: string, id: string) => readLines<CheckEntry>(join(data, id, 'checks.jsonl'));

/** The 👀 a run gave and took back, in order, as the reaction id each took back or undefined when it gave one. */
export const reactions = (data: string, id: string) =>
  readTrace(data, id).flatMap(t =>
    'applied' in t && t.applied.proposal.kind === 'react' ? [[t.applied.ok, t.applied.proposal.remove]] : []
  );

export const bodies = (t: { events: Event[] }) => t.events.flatMap(m => (m.comment ? [m.comment.body] : []));

/** Drives `r` as tick does: from the store, so a run the test changed in memory is saved first. */
export const driveStored = (flow: typeof w, r: Run, h: Graph) =>
  Effect.andThen(
    Effect.flatMap(Store, s => s.put(r)),
    runWorkflow(flow, r, h)
  );

export const fresh = (): Run => begin(w, { id: 'run-7', issue: 7, started: '2026-10-16T00:00:01.000Z' });

export const say = (where: ReturnType<typeof world>, m: Event) =>
  appendIssueAt(issuePath(where.tracker, m.issue, 'events.jsonl'), `${JSON.stringify(m)}\n`);

export const comment = (issue: number, actor: string, trusted: boolean, body: string, at: string): Event => ({
  issue,
  kind: 'comment',
  actor,
  trusted,
  at,
  comment: { id: at, author: actor, body, at },
});
export const check = (issue: number, name: string, conclusion: string, at: string): Event => ({
  issue,
  kind: 'check',
  actor: 'ci',
  trusted: false,
  at,
  check: { name, conclusion },
});

/** Pull request #8 on run 7's branch. */
export const pullRequest = (where: ReturnType<typeof world>, base = 'b1') => {
  writeIssueAt(
    issuePath(where.tracker, 8),
    '---\ntitle: Add hello\nstate: open\nauthor: agentgraph[bot]\n---\n\nCloses #7\n'
  );
  writeIssueAt(
    issuePath(where.tracker, 8, 'pull.json'),
    JSON.stringify({ branch: 'agentgraph/7', base: 'main', head: 'x', baseSha: base })
  );
};
