import { Chunk, Effect, Either, Schema, Stream } from 'effect';
import type { Check, Verdict } from './check.ts';
import { Forge, type Applied, type ForgeError, type Message, type Proposal, type Thread } from './forge.ts';
import type { Hub } from './hub.ts';
import { Sandbox, type SandboxError, type Work } from './sandbox.ts';
import type { Services } from './services.ts';
import { Session, type SessionSpec, type SessionStop } from './session.ts';
import { Store, type StoreError, type Trace } from './store.ts';
import { begin, reenter, transition, type Doc, type Outcome, type Run, type Step, type Workflow } from './workflow.ts';

const now = () => new Date().toISOString();

const Names = Schema.optionalWith(Schema.mutable(Schema.Array(Schema.String)), { exact: true });
const ProposalSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('reply'), body: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('label'), add: Names, remove: Names }),
  Schema.Struct({ kind: Schema.Literal('push'), branch: Schema.String, message: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('pull'),
    branch: Schema.String,
    into: Schema.String,
    title: Schema.String,
    body: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal('merge'), number: Schema.Int, head: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('issue'),
    title: Schema.String,
    body: Schema.String,
    parent: Schema.optionalWith(Schema.Int, { exact: true }),
  }),
  Schema.Struct({ kind: Schema.Literal('ask'), question: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('back'), why: Schema.String })
);
const decodeProposal = Schema.decodeUnknownEither(ProposalSchema, { onExcessProperty: 'error' });
const shapes: Record<Proposal['kind'], string> = {
  reply: '{"kind":"reply","body":"..."}',
  label: '{"kind":"label","add":["..."],"remove":["..."]}',
  push: '{"kind":"push","branch":"...","message":"..."}',
  pull: '{"kind":"pull","branch":"...","into":"...","title":"...","body":"..."}',
  merge: '{"kind":"merge","number":1,"head":"<sha>"}',
  issue: '{"kind":"issue","title":"...","body":"...","parent":1}',
  ask: '{"kind":"ask","question":"..."}',
  back: '{"kind":"back","why":"..."}',
};
const shapeOf = (item: unknown) => {
  const kind = (item as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' && kind in shapes
    ? `write it as ${shapes[kind as Proposal['kind']]}`
    : `kind must be one of ${Object.keys(shapes).join(', ')}`;
};
const block = /^(`{3,}|~{3,})[ \t]*bothub[ \t]*\r?\n([\s\S]*?)^\1[ \t]*$/gm;

/** The proposals in the last fenced `bothub` block of a reply: a JSON array. */
const proposalsOf = (reply: string, required: boolean): { proposals: Proposal[]; problems: string[] } => {
  const source = [...reply.matchAll(block)].at(-1)?.[2]?.trim();
  if (source === undefined)
    return { proposals: [], problems: required ? ['end the reply with a fenced bothub block: a JSON array'] : [] };
  let items: unknown;
  try {
    items = JSON.parse(source);
  } catch (e) {
    try {
      items = source
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
    } catch {
      return { proposals: [], problems: [`bothub block: ${(e as Error).message}`] };
    }
  }
  if (items !== null && typeof items === 'object' && !Array.isArray(items)) items = [items];
  if (!Array.isArray(items)) return { proposals: [], problems: ['bothub block: a JSON array of proposals'] };
  const proposals: Proposal[] = [];
  const problems: string[] = [];
  items.forEach((item, i) =>
    Either.match(decodeProposal(item), {
      onLeft: () => problems.push(`proposal ${i + 1}: ${shapeOf(item)}`),
      onRight: p => proposals.push(p),
    })
  );
  return { proposals, problems };
};

/** Keeps the first and last part of a long text. */
const squeeze = (text: string, max = 1500) =>
  text.length <= max ? text.trim() : `${text.slice(0, max / 2).trim()}\n...\n${text.slice(-max / 2).trim()}`;

const expand = (template: string, t: Thread) =>
  template.replaceAll('{issue}', String(t.number)).replaceAll('{parent}', String(t.parent ?? ''));

const sh = (script: string, dir: string, env: Record<string, string>, minutes: number) =>
  Effect.flatMap(Sandbox, s =>
    Effect.scoped(s.exec({ cmd: 'sh', args: ['-c', script], dir, env, network: 'none', minutes }))
  );

const diffOf = (work: Work, minutes: number) =>
  Effect.map(sh(`git add -N . && git diff ${work.base}`, work.dir, {}, minutes), out => out.output);

/** The items a fan-out runs over: changed files, diff hunks, or the lines a command prints. */
const itemsOf = (each: string | { run: string }, work: Work, minutes: number) => {
  const lines = (text: string) => text.split('\n').filter(line => line.trim());
  if (each === 'hunks')
    return Effect.map(diffOf(work, minutes), diff =>
      diff
        .split(/^(?=diff --git )/m)
        .filter(Boolean)
        .flatMap(file => {
          const [head = '', ...hunks] = file.split(/^(?=@@ )/m);
          return hunks.map(hunk => `${head}${hunk}`.trimEnd());
        })
    );
  const script =
    each === 'files' ? `git add -N . && git diff --name-only ${work.base}` : typeof each === 'string' ? each : each.run;
  return Effect.map(sh(script, work.dir, { BOTHUB_BASE: work.base }, minutes), out => lines(out.output));
};

type Ended = Pick<Extract<Trace, { session: unknown }>['session'], 'ended' | 'exit'>;

/** One harness session: every event and how the session ended become trace lines. */
const converse = (run: string, step: string, spec: SessionSpec) =>
  Effect.gen(function* () {
    const session = yield* Session;
    const store = yield* Store;
    const seen = { id: spec.resume?.id, home: spec.resume?.home, final: '', text: '', usd: 0 };
    let end: Ended = { ended: 'stop' };
    const ended = (how: Ended) =>
      store.trace(run, {
        at: now(),
        step,
        session: { ...(seen.id !== undefined && { id: seen.id }), resumed: !!spec.resume, ...how, usd: seen.usd },
      });
    yield* session.open(spec).pipe(
      Stream.runForEach(event => {
        if (event.type === 'start') Object.assign(seen, { id: event.session, home: event.home });
        if (event.type === 'text') seen.text = event.text;
        if (event.type === 'usage') seen.usd += event.usd ?? 0;
        if (event.type === 'end') {
          seen.final = event.final;
          end = { ended: event.ended, exit: event.exit };
        }
        return store.trace(run, { at: now(), step, event });
      }),
      Effect.scoped,
      Effect.tapError(e => (e._tag === 'SessionStop' ? ended({ ended: e.reason }) : Effect.void))
    );
    yield* ended(end);
    return { id: seen.id, home: seen.home ?? spec.dir, final: seen.final || seen.text, usd: seen.usd };
  });

type Result = { item: string | undefined; pass: boolean; findings: string; exit?: number };

/** One check over what a try left: its items, the command per item, then the judge. Per-item verdicts are traced; judge sessions' cost comes back as `usd`. */
const verdictOf = (run: string, step: Step, check: Doc<Check>, work: Work, hub: Hub) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const started = Date.now();
    const minutes = hub.limits.minutes;
    const items: (string | undefined)[] = check.each ? yield* itemsOf(check.each, work, minutes) : [undefined];
    let usd = 0;
    const one = (item: string | undefined) =>
      Effect.gen(function* () {
        const env = { BOTHUB_BASE: work.base, ...(item !== undefined && { BOTHUB_ITEM: item }) };
        const out = check.run ? yield* sh(check.run, work.dir, env, minutes) : undefined;
        const exit = out && { exit: out.code };
        if (!check.judge) return { item, pass: (out?.code ?? 0) === 0, findings: out?.output ?? '', ...exit };
        const bot = hub.bots[check.judge]!;
        const input = out?.output ?? item ?? (yield* diffOf(work, minutes));
        const judged = yield* converse(run, step.name, {
          harness: bot.harness,
          bot: check.judge,
          minutes: hub.limits.minutes,
          ...(bot.model !== undefined && { model: bot.model }),
          system: bot.body,
          prompt: `${check.body}\n\n${input}\n\nReply PASS or FAIL first, then why.`,
          dir: work.dir,
          tools: bot.tools,
        });
        usd += judged.usd;
        return { item, pass: /^\W*PASS\b/.test(judged.final), findings: judged.final, ...exit };
      });
    const over = check.max !== undefined && items.length > check.max;
    const results: Result[] = over
      ? [{ item: undefined, pass: false, findings: `${items.length} items, more than ${check.max}` }]
      : yield* Effect.forEach(items, one, { concurrency: 'unbounded' });
    const failing = results.filter(r => !r.pass);
    const verdict: Verdict = {
      check: check.name,
      pass: failing.length === 0,
      ...(failing.length > 0 && {
        findings: squeeze(
          failing.map(r => (r.item ? `${r.item.split('\n')[0]}\n${r.findings}` : r.findings)).join('\n')
        ),
      }),
      ms: Date.now() - started,
    };
    const at = now();
    yield* store.trace(
      run,
      ...results
        .filter(r => r.item !== undefined)
        .map(r => ({
          at,
          step: step.name,
          verdict: { check: check.name, pass: r.pass, ...(!r.pass && { findings: squeeze(r.findings) }), ms: 0 },
          item: r.item!,
          ...(r.exit !== undefined && { exit: r.exit }),
        })),
      { at, step: step.name, verdict, ...(!check.each && results[0]?.exit !== undefined && { exit: results[0].exit }) }
    );
    return { verdict, usd };
  });

/** One try of the current step: a session, a script or a wait, then the gate, then land on a pass. */
export const attempt = (
  w: Workflow,
  run: Run,
  hub: Hub,
  work: Work
): Effect.Effect<{ outcome: Outcome; run: Run }, SandboxError | SessionStop | ForgeError | StoreError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const step = w.steps.find(s => s.name === run.step)!;
    const minutes = hub.limits.minutes;
    const done = (outcome: Outcome, next = run) => ({ outcome, run: next });
    if ('wait' in step.does) return done({ kind: 'ask', question: `${step.name} waits for a human` });

    const replies: string[] = [];
    let tried = run;
    if ('run' in step.does) {
      const started = Date.now();
      const out = yield* sh(step.does.run, work.dir, { BOTHUB_BASE: work.base }, minutes);
      const verdict: Verdict = {
        check: step.name,
        pass: out.code === 0,
        ...(out.code !== 0 && { findings: squeeze(out.output) }),
        ms: Date.now() - started,
      };
      yield* store.trace(run.id, { at: now(), step: step.name, verdict, exit: out.code });
      if (!verdict.pass) return done({ kind: 'refused', failing: [verdict], rejected: [], problems: [] });
      replies.push(out.output);
    } else {
      const bot = hub.bots[step.does.bot]!;
      const thread = yield* Effect.flatMap(Forge, f => f.thread(run.thread));
      const kept = step.each === undefined ? run.sessions[step.name] : undefined;
      const kinds = [...bot.returns.filter(k => k !== 'ask' && k !== 'back'), 'ask', ...(step.back ? ['back'] : [])];
      const brief = [
        step.does.skill && hub.skills[step.does.skill]?.body,
        w.body,
        `## #${thread.number} ${thread.title}\n\n${thread.body}`,
        ...thread.comments.map(c => `@${c.author}: ${c.body}`),
        w.branch && `Work on the branch ${expand(w.branch, thread)}.`,
        step.back?.until && `Propose back with a reason while this does not hold: ${step.back.until}`,
        run.carry,
        [
          'End your reply with a fenced bothub block holding a JSON array of proposals. The runner commits, pushes,',
          'opens pull requests and posts comments from them, so do not run git or gh yourself. The shape of each kind:',
          ...kinds.map(k => shapes[k as Proposal['kind']]),
        ].join('\n'),
      ]
        .filter(Boolean)
        .join('\n\n');
      const items: (string | undefined)[] = step.each ? yield* itemsOf(step.each, work, minutes) : [undefined];
      for (const item of items) {
        const r = yield* converse(run.id, step.name, {
          harness: bot.harness,
          bot: step.does.bot,
          minutes,
          ...(bot.model !== undefined && { model: bot.model }),
          system: bot.body,
          prompt: kept ? (run.carry ?? 'Continue.') : item === undefined ? brief : `${brief}\n\n## Item\n\n${item}`,
          dir: work.dir,
          tools: bot.tools,
          ...(kept && { resume: kept }),
        });
        replies.push(r.final);
        tried = {
          ...tried,
          usd: tried.usd + r.usd,
          ...(step.each === undefined &&
            r.id !== undefined && { sessions: { ...tried.sessions, [step.name]: { id: r.id, home: r.home } } }),
        };
      }
    }

    const parsed = replies.map(reply => proposalsOf(reply, !('run' in step.does)));
    const proposals = parsed.flatMap(p => p.proposals);
    const problems = parsed.flatMap(p => p.problems);
    const ask = proposals.find(p => p.kind === 'ask');
    if (ask) return done({ kind: 'ask', question: ask.question }, tried);
    const back = proposals.find(p => p.kind === 'back');
    const world = proposals.filter(p => p.kind !== 'ask' && p.kind !== 'back');

    const { outcome: gated, usd } = yield* gate(step, { run: run.id, ...work, proposals: world }, hub);
    tried = { ...tried, usd: tried.usd + usd };
    if (gated.kind === 'refused' || (gated.kind === 'pass' && problems.length > 0))
      return done(
        gated.kind === 'refused'
          ? { ...gated, problems: [...gated.problems, ...problems] }
          : { kind: 'refused', failing: [], rejected: [], problems },
        tried
      );
    if (gated.kind !== 'pass') return done(gated, tried);
    if (back) return done({ kind: 'back', why: back.why }, tried);

    const applied = yield* land(tried, world, work);
    yield* store.trace(run.id, ...applied.map(a => ({ at: now(), step: step.name, applied: a })));
    const failed = applied.filter(a => !a.ok);
    return done(
      failed.length ? { kind: 'refused', failing: [], rejected: failed, problems: [] } : { kind: 'pass' },
      tried
    );
  });

/** The step's checks over what a try left behind: scripts in one batch, bot checks only when no script failed. `usd` is what the bot checks cost. */
export const gate = (
  step: Step,
  left: Work & { run: string; proposals: Proposal[] },
  hub: Hub
): Effect.Effect<
  { outcome: Outcome; usd: number },
  SandboxError | SessionStop | StoreError,
  Sandbox | Session | Store
> =>
  Effect.gen(function* () {
    const checks = step.checks.map(name => ({ ...hub.checks[name]!, name }));
    const holds = (c: Check) => c.mode === 'block' || c.mode === 'stop';
    const verdicts = (list: Doc<Check>[]) =>
      Effect.forEach(list, c => verdictOf(left.run, step, c, left, hub), { concurrency: 'unbounded' });
    const scripts = checks.filter(c => !c.judge);
    const judged = checks.filter(c => c.judge);
    const first = (yield* verdicts(scripts)).map(r => r.verdict);
    const blocked = first.some((v, i) => !v.pass && holds(scripts[i]!));
    const bots = blocked ? [] : yield* verdicts(judged);
    const usd = bots.reduce((sum, r) => sum + r.usd, 0);
    const all = [...first, ...bots.map(r => r.verdict)];
    const failed = (mode: Check['mode']) =>
      all.filter(v => !v.pass && checks.find(c => c.name === v.check)?.mode === mode);

    const stops = failed('stop');
    if (stops.length > 0)
      return {
        outcome: { kind: 'stop', why: stops.map(v => `${v.check}: ${v.findings ?? 'failed'}`).join('\n') },
        usd,
      };
    const returns = 'bot' in step.does ? hub.bots[step.does.bot]?.returns : undefined;
    const rejected: Applied[] = left.proposals
      .filter(p => returns && !returns.includes(p.kind))
      .map(p => ({ proposal: p, ok: false, reason: `${step.name} may not propose ${p.kind}` }));
    const failing = failed('block');
    const outcome: Outcome =
      failing.length > 0 || rejected.length > 0
        ? { kind: 'refused', failing, rejected, problems: [] }
        : { kind: 'pass' };
    return { outcome, usd };
  });

/** Applies the accepted proposals after a pass, pushes first. */
export const land = (run: Run, proposals: Proposal[], work?: Work): Effect.Effect<Applied[], ForgeError, Forge> =>
  Effect.flatMap(Forge, forge =>
    Effect.forEach(
      [...proposals].sort((a, b) => Number(b.kind === 'push') - Number(a.kind === 'push')),
      p => forge.apply(run.thread, p, work)
    )
  );

/**
 * attempt, transition and persist until the run is no longer running. An infra failure stops the run with its reason.
 * The worktree's files are kept under `refs/bothub/runs/<run id>`, so a parked run picks up where it left off.
 */
export const drive = (w: Workflow, run: Run, hub: Hub): Effect.Effect<Run, StoreError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const forge = yield* Forge;
    let current = run;
    const settle = (outcome: Outcome, next: Run) =>
      Effect.gen(function* () {
        yield* store.trace(next.id, {
          at: now(),
          step: current.step,
          outcome,
          run: { step: next.step, status: next.status, tries: next.tries, rounds: next.rounds },
        });
        if ((next.status === 'asking' || next.status === 'stopped') && next.reason) {
          const body =
            next.status === 'asking'
              ? `${next.reason}\n\nAnswer with \`/bothub <your answer>\`, or \`/bothub stop\` to end the run.`
              : next.reason;
          const said = yield* Effect.either(land(next, [{ kind: 'reply', body }]));
          if (Either.isRight(said))
            yield* store.trace(next.id, ...said.right.map(applied => ({ at: now(), step: next.step, applied })));
        }
        yield* store.put(next);
        current = next;
      });
    const walk = Effect.gen(function* () {
      yield* store.lock(run.id);
      yield* store.put(current);
      const thread = yield* forge.thread(run.thread);
      const ref = thread.pull?.branch ?? expand(w.into ?? 'main', thread);
      const work = yield* Effect.flatMap(Sandbox, s =>
        s.checkout(ref, w.branch && expand(w.branch, thread), `refs/bothub/runs/${run.id}`)
      );
      while (current.status === 'running') {
        const tried = yield* attempt(w, current, hub, work);
        yield* settle(tried.outcome, transition(w, tried.run, tried.outcome));
      }
    });
    const halt = (e: SandboxError | SessionStop | ForgeError) => {
      const why = `${e._tag}: ${'detail' in e ? (e.detail ?? e.reason) : e.message}`;
      const said = `Stopped by a runner error (${e._tag}). The details are in the trace of run ${current.id}.`;
      return settle({ kind: 'stop', why }, transition(w, current, { kind: 'stop', why: said }));
    };
    yield* walk.pipe(Effect.scoped, Effect.catchTags({ SandboxError: halt, SessionStop: halt, ForgeError: halt }));
    return current;
  });

const live = (r: Run) => r.status !== 'done' && r.status !== 'stopped';

/**
 * One look at the repo: reenter parked runs, begin new ones, drive up to `limits.working`. With `only`, it looks at
 * that thread alone and begins a run there when none was live, command or not; with `fresh` too, only when the thread
 * never had a run.
 */
export const tick = (hub: Hub, only?: number, fresh = false): Effect.Effect<Run[], ForgeError | StoreError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const forge = yield* Forge;
    const mine = (r: { thread: number }) => only === undefined || r.thread === only;
    const runs = (yield* store.list()).filter(mine);
    const parked = yield* Effect.forEach(
      runs.filter(r => r.status === 'asking' || r.status === 'waiting'),
      r =>
        Effect.map(Stream.runLast(store.read(r.id)), last => ({
          run: r,
          at: last._tag === 'Some' ? last.value.at : r.started,
        }))
    );
    const started = runs
      .map(r => r.started)
      .sort()
      .at(-1);
    const cursor = started === undefined ? '' : [started, ...parked.map(p => p.at)].sort()[0]!;
    const messages = Chunk.toArray(yield* Stream.runCollect(forge.since(cursor))).filter(mine);
    const used = new Set<Message>();
    const touched: Run[] = [];

    for (const { run, at } of parked) {
      const w = hub.workflows[run.workflow];
      const m = w && messages.find(m => m.thread === run.thread && m.at > at && reenter(w, run, m));
      if (!w || !m) continue;
      used.add(m);
      const outcome = reenter(w, run, m)!;
      const next = transition(w, run, outcome);
      yield* store.trace(run.id, {
        at: now(),
        step: run.step,
        outcome,
        run: { step: next.step, status: next.status, tries: next.tries, rounds: next.rounds },
      });
      yield* store.put(next);
      touched.push(next);
    }

    const busy = new Set([...runs, ...touched].filter(live).map(r => `${r.workflow}#${r.thread}`));
    const open = new Set((yield* forge.threads({ state: 'open' })).map(t => t.number));
    const triggered = Object.values(hub.workflows).filter(w => w.on.issue_comment?.command);
    const start = (w: Workflow, thread: number, at: string) =>
      Effect.gen(function* () {
        const run = begin(w, { id: `${w.name}-${thread}-${at.replace(/\D/g, '')}`, thread, started: at });
        busy.add(`${w.name}#${thread}`);
        yield* store.put(run);
        touched.push(run);
      });
    for (const m of messages) {
      const w = triggered.find(w => m.comment?.body.trim().startsWith(w.on.issue_comment!.command!));
      if (!w || used.has(m) || m.kind !== 'comment' || !m.trusted || !open.has(m.thread)) continue;
      if (!busy.has(`${w.name}#${m.thread}`)) yield* start(w, m.thread, m.at);
    }
    if (
      only !== undefined &&
      triggered[0] &&
      (fresh ? runs.length === 0 : !runs.some(live)) &&
      !touched.some(r => r.thread === only)
    )
      yield* start(triggered[0], only, now());

    const running = (yield* store.list({ status: 'running' }))
      .filter(mine)
      .sort((a, b) => a.started.localeCompare(b.started));
    const driven = yield* Effect.forEach(
      running.filter(r => hub.workflows[r.workflow]),
      r =>
        drive(hub.workflows[r.workflow]!, r, hub).pipe(
          Effect.catchAll(e => Effect.as(Effect.logError(`run ${r.id}`, e), r))
        ),
      { concurrency: hub.limits.working }
    );
    return [...touched.filter(r => !driven.some(d => d.id === r.id)), ...driven];
  });

/** One pass over the open issues, one after another: each gets the same single look `tick` gives it. */
export const sweep = (hub: Hub): Effect.Effect<Run[], ForgeError | StoreError, Services> =>
  Effect.gen(function* () {
    const issues = (yield* Effect.flatMap(Forge, f => f.threads({ state: 'open' }))).filter(t => !t.pull);
    const runs = yield* Effect.forEach(issues, t => tick(hub, t.number, true));
    return runs.flat();
  });
