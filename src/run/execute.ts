import { randomUUID } from 'node:crypto';
import { Context, Effect, Semaphore, Stream, Option } from 'effect';
import { Tracker } from '../tracker.ts';
import { Store } from '../store.ts';
import { Session } from '../session.ts';
import { type SandboxError, Sandbox } from '../sandbox.ts';
import type { Graph } from '../folder.ts';
import { pickUsed } from '../trace.ts';
import { getRecordedResult } from '../result.ts';
import { readPlugins } from '../plugin.ts';
import { startTools } from '../tools.ts';
import { formatRedactedText, formatSqueezed } from '../context.ts';
import { type Aside, type Checkout, type SessionSpec, SessionStop, type Trace, type TrackerError } from '../types.ts';

export type Services = Tracker | Store | Session | Sandbox;

export const makeAgentSessionSpec = (
  graph: Graph,
  name: string,
  work: Pick<Checkout, 'dir'> & Partial<Pick<Checkout, 'base'>>
) => {
  const agent = graph.agents[name]!;
  return {
    harness: agent.harness,
    agent: name,
    minutes: graph.limits.minutes,
    limits: graph.limits,
    ...(agent.model !== undefined && { model: agent.model }),
    system: agent.body,
    dir: work.dir,
    ...(work.base !== undefined && { base: work.base }),
    tools: agent.tools,
  };
};

export const runShell = (
  script: string,
  graph: Graph,
  dir: string,
  env: Record<string, string>,
  minutes: number,
  network: 'none' | 'proxy' = 'none'
) =>
  Effect.flatMap(Sandbox, s =>
    Effect.scoped(
      s.exec({
        limits: graph.limits,
        cmd: 'sh',
        args: ['-c', script],
        dir,
        graph: graph.dir,
        env,
        network,
        minutes,
      })
    ).pipe(withSessionPermit(graph))
  );

type Ended = Pick<Extract<Trace, { session: unknown }>['session'], 'ended' | 'exit' | 'used'>;

export const sessionPermitsRef = Context.Reference<Semaphore.Semaphore>('agentgraph/sessionPermits', {
  defaultValue: () => Semaphore.makeUnsafe(1),
});

const withSessionPermit =
  (graph: Graph) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(sessionPermitsRef, permits =>
      Effect.andThen(permits.resize(graph.limits.sessions), permits.withPermits(1)(effect))
    );

type SessionOptions<A, R> = Partial<{
  item: string | undefined;
  until: Effect.Effect<A, never, R> | undefined;
  aside: Aside;
  dropped: string;
}>;

/**
 * One harness session: what it was opened with, every event and how it ended become lines of the trace of the run
 * `into`, or of the list `into`. It holds a session permit only while the harness runs. When `until` ends first, the session is cut short and its result comes back as `cut`.
 * With `fresh`, a resume that fails before the harness starts, or of a session another harness ran, runs once fresh
 * with `fresh` as its prompt, traced with why the resume was dropped.
 */
export const runSession = <A = never, R = never>(
  graph: Graph,
  into: string | Trace[],
  step: string,
  spec: SessionSpec,
  o: SessionOptions<A, R> & { fresh?: string } = {}
) => {
  const { fresh, ...rest } = o;
  if (fresh === undefined || !spec.resume) return openSession(graph, into, step, spec, rest);
  const { resume, fork: _, ...unresumed } = spec;
  const anew = (dropped: string) =>
    openSession(graph, into, step, { ...unresumed, prompt: fresh }, { ...rest, dropped });
  if (resume.harness !== undefined && resume.harness !== spec.harness)
    return anew(`the session ran on ${resume.harness}`);
  return Effect.flatMap(openSession(graph, into, step, spec, rest, true), r =>
    r.lost === undefined ? Effect.succeed(r) : Effect.map(anew(r.lost), k => ({ ...k, usd: r.usd + k.usd }))
  );
};

const openSession = <A, R>(
  graph: Graph,
  into: string | Trace[],
  step: string,
  spec: SessionSpec,
  { item, until, aside, dropped }: SessionOptions<A, R>,
  droppable = false
) =>
  Effect.gen(function* () {
    const session = yield* Session;
    const store = yield* Store;
    const seen = {
      id: spec.resume?.id,
      home: spec.resume?.home,
      final: '',
      text: '',
      usd: 0,
      result: undefined as ReturnType<typeof getRecordedResult>,
    };
    let end: Ended = { ended: 'error' };
    let started = false;
    const key = randomUUID().slice(0, 8);
    const write = (line: Trace) =>
      typeof into === 'string' ? store.trace(into, line) : Effect.sync(() => void into.push(line));
    const ended = (how: Ended) =>
      write({
        at: new Date().toISOString(),
        step,
        key,
        session: {
          ...(seen.id !== undefined && { id: seen.id }),
          resumed: !!spec.resume,
          ...(dropped !== undefined && { dropped }),
          ...(aside && { aside: true as const }),
          ...how,
          usd: seen.usd,
        },
      });
    yield* write({
      at: new Date().toISOString(),
      step,
      prompt: spec,
      key,
      ...(item !== undefined && { item }),
      ...(aside && { aside }),
    });
    const tracker = yield* Effect.serviceOption(Tracker);
    const box = yield* Effect.serviceOption(Sandbox);
    const custom = spec.tools.filter(name => graph.tools?.includes(name));
    const server = custom.length
      ? yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: async () => {
              if (Option.isNone(tracker)) throw new Error('custom tools need a tracker');
              const registry = await readPlugins(graph.dir, graph.plugins);
              const tools = Object.fromEntries(custom.map(name => [name, registry.tools[name]!]));
              const route =
                Option.isSome(box) && box.value.tools ? await Effect.runPromise(box.value.tools(spec.dir)) : undefined;
              return startTools(
                tools,
                {
                  repo: graph.repo,
                  tracker: { searchIssues: (...args) => Effect.runPromise(tracker.value.searchIssues(...args)) },
                },
                event => Effect.runPromise(write({ at: new Date().toISOString(), step, event, key })),
                { save: (bytes, signal) => Effect.runPromise(store.putFile(bytes, signal)), session: key },
                route
              );
            },
            catch: error =>
              new SessionStop({ reason: 'sandbox', detail: formatRedactedText(String(error)).slice(0, 2048) }),
          }),
          server => Effect.promise(() => server.close())
        )
      : undefined;
    const talked = session
      .open(server ? { ...spec, tools: spec.tools.filter(name => !custom.includes(name)), mcp: server } : spec)
      .pipe(
        Stream.runForEach(event => {
          if (event.type === 'start') {
            started = true;
            Object.assign(seen, { id: event.session, home: event.home });
          }
          if (event.type === 'text') seen.text = event.text;
          if (event.type === 'usage') seen.usd += event.usd ?? 0;
          if (event.type === 'tool' && spec.returns)
            seen.result = getRecordedResult(spec.returns, event) ?? seen.result;
          if (event.type === 'end') {
            seen.final = event.final;
            end = {
              ended: event.exit === 0 ? event.ended : 'error',
              exit: event.exit,
              ...pickUsed(event),
            };
          }
          return write({ at: new Date().toISOString(), step, event, key });
        }),
        Effect.scoped,
        withSessionPermit(graph),
        Effect.catchTag('SessionStop', e =>
          droppable && !started && e.reason !== 'human' && e.reason !== 'login'
            ? Effect.sync(() => {
                seen.final = e.detail ?? e.reason;
                end = { ended: e.reason };
              })
            : Effect.fail(e)
        ),
        Effect.tapError(e => (e._tag === 'SessionStop' ? ended({ ended: e.reason }) : Effect.void)),
        Effect.as(undefined)
      );
    const cut = until
      ? yield* Effect.raceFirst(
          talked,
          Effect.map(until, a => ({ a }))
        )
      : yield* talked;
    if (cut) end = { ended: 'human' };
    const final = seen.final || seen.text;
    if (!cut && end.ended !== 'stop' && /Failed to authenticate|Invalid API key|\b401\b/.test(final))
      end = { ...end, ended: 'login' };
    yield* ended(end);
    const unstarted = droppable && !started && !cut && end.ended !== 'stop' && end.ended !== 'login';
    return {
      id: seen.id,
      home: seen.home ?? spec.dir,
      final,
      usd: seen.usd,
      result: seen.result,
      ...end,
      ...(cut && { cut: cut.a }),
      ...(unstarted && { lost: formatSqueezed(final || end.ended, 200) }),
    };
  }).pipe(Effect.scoped);

/**
 * A judging session that must record its result with the result tool. A session that fails is tried once more; one that
 * stops cleanly without a valid result is resumed once and told to record it. Without a result after that the check
 * could not be judged.
 */
export const runJudge = (graph: Graph, into: Trace[], step: string, spec: SessionSpec, item?: string) => {
  const judge = (s: SessionSpec) =>
    runSession(graph, into, step, s, { item }).pipe(
      Effect.flatMap(j =>
        j.ended === 'stop'
          ? Effect.succeed(j)
          : new SessionStop({
              reason: j.ended === 'human' ? 'human' : 'provider',
              detail: `session ${j.ended} (exit ${j.exit ?? 0}), final: ${formatSqueezed(j.final, 200)}`,
            })
      ),
      Effect.retry({
        times: 1,
        while: e => e._tag === 'SessionStop' && e.reason !== 'human',
      })
    );
  return judge(spec).pipe(
    Effect.flatMap(j =>
      j.result || !j.id
        ? Effect.succeed(j)
        : Effect.map(
            judge({
              ...spec,
              prompt: nudge,
              resume: { id: j.id, home: j.home },
            }),
            k => ({
              ...k,
              usd: j.usd + k.usd,
            })
          )
    ),
    Effect.flatMap(({ result, usd, final }) =>
      result
        ? Effect.succeed({ ...result, usd })
        : new SessionStop({
            reason: 'provider',
            detail: `session gave no result, final: ${formatSqueezed(final, 200)}`,
          })
    ),
    Effect.catchTag('SessionStop', e =>
      Effect.fail(
        new SessionStop({
          reason: e.reason,
          detail: `check ${spec.agent} could not be judged: ${e.detail ?? e.reason}`,
        })
      )
    )
  );
};

const nudge = 'You ended without calling the result tool. Call it now with your value, and why with your findings.';

export const formatFailure = (e: SandboxError | SessionStop | TrackerError) =>
  `${e._tag}: ${'detail' in e ? (e.detail ?? e.reason) : e.message}`;
