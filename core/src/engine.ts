import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Chunk, Effect, Either, Schema, Stream } from 'effect';
import type { Check, Verdict } from './check.ts';
import { context, news, shown, type Issues } from './context.ts';
import { Forge, type Applied, type ForgeError, type Message, type Proposal, type Issue } from './forge.ts';
import type { Hub } from './hub.ts';
import { Sandbox, SandboxError, type Work } from './sandbox.ts';
import type { Services } from './services.ts';
import { Session, type SessionSpec, type SessionStop } from './session.ts';
import { Store, type StoreError, type Trace } from './store.ts';
import {
  begin,
  reenter,
  transition,
  type Doc,
  type Outcome,
  type Run,
  type Seen,
  type Step,
  type Workflow,
} from './workflow.ts';

const now = () => new Date().toISOString();

const Names = Schema.optionalWith(Schema.mutable(Schema.Array(Schema.String)), { exact: true });
const ProposalSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('comment'), body: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('label'), add: Names, remove: Names }),
  Schema.Struct({ kind: Schema.Literal('push'), branch: Schema.String, message: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('pull_request'),
    branch: Schema.String,
    base: Schema.String,
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
const shapes: Record<Exclude<Proposal['kind'], 'react'>, string> = {
  comment: '{"kind":"comment","body":"..."}',
  label: '{"kind":"label","add":["..."],"remove":["..."]}',
  push: '{"kind":"push","branch":"...","message":"..."}',
  pull_request: '{"kind":"pull_request","branch":"...","base":"...","title":"...","body":"..."}',
  merge: '{"kind":"merge","number":1,"head":"<sha>"}',
  issue: '{"kind":"issue","title":"...","body":"...","parent":1}',
  ask: '{"kind":"ask","question":"..."}',
  back: '{"kind":"back","why":"..."}',
};
const shapeOf = (item: unknown) => {
  const kind = (item as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' && kind in shapes
    ? `write it as ${shapes[kind as keyof typeof shapes]}`
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

const expand = (template: string, t: Pick<Issue, 'number' | 'parent'>) =>
  template.replaceAll('{issue}', String(t.number)).replaceAll('{parent}', String(t.parent ?? ''));

/** The open pull request on the branch a run of `w` on `issue` works on. */
const pullOf = (w: Workflow, issue: number, open: Issue[]) =>
  w.branch === undefined
    ? undefined
    : open.find(t => t.pull?.branch === expand(w.branch!, open.find(t => t.number === issue) ?? { number: issue }))
        ?.number;

/** The run's issue and the pull request on its branch, fetched before every session. */
export const issuesOf = (w: Workflow, run: Run): Effect.Effect<Issues, ForgeError, Forge> =>
  Effect.gen(function* () {
    const forge = yield* Forge;
    const issue = yield* forge.issue(run.issue);
    const pull =
      issue.pull || w.branch === undefined ? undefined : pullOf(w, run.issue, yield* forge.issues({ state: 'open' }));
    return { issue, ...(pull !== undefined && { pull: yield* forge.issue(pull) }) };
  });

const sh = (
  script: string,
  dir: string,
  env: Record<string, string>,
  minutes: number,
  network: 'none' | 'proxy' = 'none'
) =>
  Effect.flatMap(Sandbox, s => Effect.scoped(s.exec({ cmd: 'sh', args: ['-c', script], dir, env, network, minutes })));

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

/** Where a session finds what is new on its issues, refreshed every minute while it runs. */
const newsFile = '.bothub/news.md';

/** Keeps the news file out of every commit the checkout makes. */
const excluded = (work: Work) =>
  Effect.tryPromise({
    try: async () => {
      const file = join(work.git.GIT_DIR, 'info', 'exclude');
      const text = await readFile(file, 'utf8').catch(() => '');
      if (text.split('\n').includes(`/${newsFile}`)) return;
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, `${text && !text.endsWith('\n') ? '\n' : ''}/${newsFile}\n`);
    },
    catch: e => new SandboxError({ reason: 'infra', detail: `exclude ${newsFile}: ${(e as Error).message}` }),
  });

/** Writes the news since `seen` into the checkout; a failed refresh logs and keeps the old file. */
const refresh = (w: Workflow, run: Run, work: Work, seen: Seen, t?: Issues) =>
  (t ? Effect.succeed(t) : issuesOf(w, run)).pipe(
    Effect.flatMap(t =>
      Effect.tryPromise(async () => {
        const file = join(work.dir, newsFile);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, `${news(t, seen).text || 'Nothing new yet.'}\n`);
      })
    ),
    Effect.catchAll(e => Effect.logWarning(`news for run ${run.id}`, e))
  );

type Ended = Pick<Extract<Trace, { session: unknown }>['session'], 'ended' | 'exit'>;

/** One harness session: what it was opened with, every event and how it ended become trace lines. */
const converse = (run: string, step: string, spec: SessionSpec, item?: string) =>
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
    yield* store.trace(run, { at: now(), step, prompt: spec, ...(item !== undefined && { item }) });
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
        const judged = yield* converse(
          run,
          step.name,
          {
            harness: bot.harness,
            bot: check.judge,
            minutes: hub.limits.minutes,
            ...(bot.model !== undefined && { model: bot.model }),
            system: bot.body,
            prompt: `${check.body}\n\n${input}\n\nReply PASS or FAIL first, then why.`,
            dir: work.dir,
            tools: bot.tools,
          },
          item
        );
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
    if ('wait' in step.does) {
      const { issue, pull } = yield* issuesOf(w, run);
      const open = w.branch === undefined || issue.pull !== undefined || pull !== undefined;
      return done({
        kind: 'ask',
        question: open
          ? `${step.name} waits for a human`
          : `No pull request is open for branch ${expand(w.branch!, issue)}. Open one, or say what to do.`,
      });
    }

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
      const t = yield* issuesOf(w, run);
      const issue = t.issue;
      const kept = step.each === undefined ? run.sessions[step.name] : undefined;
      const kinds = [...bot.returns.filter(k => k !== 'ask' && k !== 'back'), 'ask', ...(step.back ? ['back'] : [])];
      const prompt = [
        step.does.skill && hub.skills[step.does.skill]?.body,
        w.body,
        context(t),
        w.branch &&
          `Work on the branch ${expand(w.branch, issue)}; pull requests go into ${issue.pull?.base ?? expand(w.base ?? 'main', issue)}.`,
        step.back?.until && `Propose back with a reason while this does not hold: ${step.back.until}`,
        `People may comment while you work: ${newsFile} holds what is new, refreshed every minute. Read it before you finish.`,
        run.feedback,
        [
          'End your reply with a fenced bothub block holding a JSON array of proposals. The runner commits, pushes,',
          'opens pull requests and posts comments from them, so do not run git or gh yourself. The shape of each kind:',
          ...kinds.map(k => shapes[k as keyof typeof shapes]),
        ].join('\n'),
      ]
        .filter(Boolean)
        .join('\n\n');
      const items: (string | undefined)[] = step.each ? yield* itemsOf(step.each, work, minutes) : [undefined];
      const caught = news(t, kept ? (kept.seen ?? { at: run.started }) : { at: '' });
      for (const item of items) {
        yield* refresh(w, run, work, caught.seen, t);
        const fresher = Effect.forever(Effect.delay(refresh(w, run, work, caught.seen), '1 minute'));
        const talk = converse(
          run.id,
          step.name,
          {
            harness: bot.harness,
            bot: step.does.bot,
            minutes,
            ...(bot.model !== undefined && { model: bot.model }),
            system: bot.body,
            prompt: kept
              ? [run.feedback ?? 'Continue.', caught.text].filter(Boolean).join('\n\n')
              : item === undefined
                ? prompt
                : `${prompt}\n\n## Item\n\n${item}`,
            dir: work.dir,
            tools: bot.tools,
            ...(kept && { resume: kept }),
          },
          item
        );
        const r = yield* Effect.scoped(Effect.zipRight(Effect.forkScoped(fresher), talk));
        replies.push(r.final);
        tried = {
          ...tried,
          usd: tried.usd + r.usd,
          ...(step.each === undefined &&
            r.id !== undefined && {
              sessions: { ...tried.sessions, [step.name]: { id: r.id, home: r.home, seen: caught.seen } },
            }),
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

    const to =
      world.some(p => p.kind === 'comment') && !run.said
        ? pullOf(w, run.issue, yield* Effect.flatMap(Forge, f => f.issues({ state: 'open' })))
        : undefined;
    const landed = yield* Effect.either(land(tried, world, work, to));
    if (Either.isLeft(landed))
      return done({ kind: 'ask', question: `GitHub failed: ${squeeze(landed.left.message, 200)}` }, tried);
    const applied = landed.right;
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
      .filter(p => returns && !returns.some(k => k === p.kind))
      .map(p => ({ proposal: p, ok: false, reason: `${step.name} may not propose ${p.kind}` }));
    const failing = failed('block');
    const outcome: Outcome =
      failing.length > 0 || rejected.length > 0
        ? { kind: 'refused', failing, rejected, problems: [] }
        : { kind: 'pass' };
    return { outcome, usd };
  });

/** Lands the run's status labels and status comment; the run comes back holding its status comment's id. */
const show = (w: Workflow, run: Run): Effect.Effect<Run, StoreError, Forge | Store> =>
  Effect.gen(function* () {
    const forge = yield* Forge;
    const t = yield* issuesOf(w, run);
    const applied = yield* Effect.forEach(shown(run, w, t), p => forge.apply(run.issue, p));
    yield* Effect.flatMap(Store, s =>
      s.trace(run.id, ...applied.map(a => ({ at: now(), step: run.step, applied: a })))
    );
    const reply = applied.find(a => a.proposal.kind === 'comment');
    if (!reply) return run;
    const { comment: _gone, ...rest } = run;
    return reply.ok && reply.id ? { ...rest, comment: reply.id } : rest;
  }).pipe(Effect.catchTag('ForgeError', e => Effect.as(Effect.logWarning(`status of run ${run.id}`, e), run)));

/** Applies the accepted proposals after a pass, pushes first. Replies go where a human last spoke, else to `to`. */
export const land = (
  run: Run,
  proposals: Proposal[],
  work?: Work,
  to?: number
): Effect.Effect<Applied[], ForgeError, Forge> =>
  Effect.flatMap(Forge, forge =>
    Effect.forEach(
      [...proposals].sort((a, b) => Number(b.kind === 'push') - Number(a.kind === 'push')),
      p =>
        p.kind === 'comment'
          ? forge.apply(run.said?.issue ?? to ?? run.issue, {
              ...p,
              ...(run.said?.under && { under: run.said.under }),
            })
          : forge.apply(run.issue, p, work)
    )
  );

/**
 * Runs the hub's setup in the checkout, then attempt, transition and persist while the run is running. An infra
 * failure, a failed setup included, stops the run with its reason.
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
        if (next.status === 'asking' && next.reason) {
          const body = `${next.reason}\n\nAnswer with \`/bothub <your answer>\`, or \`/bothub stop\` to end the run.`;
          const said = yield* Effect.either(land(next, [{ kind: 'comment', body }]));
          if (Either.isRight(said))
            yield* store.trace(next.id, ...said.right.map(applied => ({ at: now(), step: next.step, applied })));
        }
        current = yield* show(w, next);
        yield* store.put(current);
      });
    const walk = Effect.gen(function* () {
      yield* store.lock(run.id);
      current = yield* show(w, current);
      yield* store.put(current);
      const issue = yield* forge.issue(run.issue);
      const ref = issue.pull?.branch ?? expand(w.base ?? 'main', issue);
      const work = yield* Effect.flatMap(Sandbox, s =>
        s.checkout(ref, w.branch && expand(w.branch, issue), `refs/bothub/runs/${run.id}`)
      );
      yield* excluded(work);
      if (hub.setup) {
        const out = yield* sh(hub.setup, work.dir, { BOTHUB_BASE: work.base }, hub.limits.minutes, 'proxy');
        if (out.code !== 0)
          return yield* new SandboxError({
            reason: 'infra',
            detail: `setup exited ${out.code}: ${squeeze(out.output)}`,
          });
      }
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
 * One look at the repo: reenter live runs, begin new ones on a trusted command or label, drive up to `limits.parallel`. What is said on the pull
 * request a run opened counts as said on the run's issue. With `only`, it looks at
 * that issue alone and begins a run there when none was live, command or not; with `fresh` too, only when the issue
 * never had a run.
 */
export const tick = (hub: Hub, only?: number, fresh = false): Effect.Effect<Run[], ForgeError | StoreError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const forge = yield* Forge;
    const mine = (r: { issue: number }) => only === undefined || r.issue === only;
    const runs = (yield* store.list()).filter(mine);
    const parked = yield* Effect.forEach(runs.filter(live), r =>
      Effect.map(Stream.runLast(Stream.filter(store.read(r.id), t => !('saved' in t))), last => ({
        run: r,
        at: last._tag === 'Some' ? last.value.at : r.started,
      }))
    );
    const started = runs
      .map(r => r.started)
      .sort()
      .at(-1);
    const cursor = started === undefined ? '' : [started, ...parked.map(p => p.at)].sort()[0]!;
    const issues = yield* forge.issues({ state: 'open' });
    const origin = new Map<Message, number>();
    const onRun = (m: Message): Message => {
      const r = runs.find(
        r =>
          r.issue !== m.issue &&
          hub.workflows[r.workflow] &&
          pullOf(hub.workflows[r.workflow]!, r.issue, issues) === m.issue
      );
      if (!r) return m;
      const moved = { ...m, issue: r.issue };
      origin.set(moved, m.issue);
      return moved;
    };
    /** Where a human spoke: the issue, and the review comment thread when it was one. */
    const heard = (m: Message): NonNullable<Run['said']> => {
      const c = m.kind === 'comment' ? m.comment : undefined;
      return { issue: origin.get(m) ?? m.issue, ...(c?.path !== undefined && { under: c.under ?? c.id }) };
    };
    /** 👀 on the comment that woke a run, or on its issue for a label. */
    const eyes = (run: Run, m: Message) =>
      m.kind !== 'comment' && m.kind !== 'label'
        ? Effect.void
        : forge
            .apply(origin.get(m) ?? m.issue, {
              kind: 'react',
              ...(m.kind === 'comment' &&
                m.comment && { comment: m.comment.id, ...(m.comment.path !== undefined && { review: true }) }),
            })
            .pipe(
              Effect.flatMap(applied => store.trace(run.id, { at: now(), step: run.step, applied })),
              Effect.catchTag('ForgeError', e => Effect.logWarning(`react for run ${run.id}`, e))
            );
    const messages = Chunk.toArray(yield* Stream.runCollect(forge.since(cursor)))
      .map(onRun)
      .filter(mine);
    const used = new Set<Message>();
    const touched: Run[] = [];

    for (const { run, at } of parked) {
      const w = hub.workflows[run.workflow];
      const m = w && messages.find(m => m.issue === run.issue && m.at > at && reenter(w, run, m));
      if (!w || !m) continue;
      used.add(m);
      const outcome = reenter(w, run, m)!;
      if (m.kind === 'comment') yield* eyes(run, m);
      const moved = { ...transition(w, run, outcome), said: heard(m) };
      const next = moved.status === 'running' ? moved : yield* show(w, moved);
      yield* store.trace(run.id, {
        at: now(),
        step: run.step,
        outcome,
        run: { step: next.step, status: next.status, tries: next.tries, rounds: next.rounds },
      });
      yield* store.put(next);
      touched.push(next);
    }

    const busy = new Set([...runs, ...touched].filter(live).map(r => `${r.workflow}#${r.issue}`));
    const open = new Set(issues.map(t => t.number));
    const triggered = Object.values(hub.workflows).filter(w => w.on.issue_comment?.command);
    const labelled = Object.values(hub.workflows).filter(w => w.on.issues?.label);
    /** The label workflow whose label an issue carries, when a maintainer put it there last. */
    const assigned = (issue: number) =>
      Effect.map(forge.issue(issue), t =>
        labelled.find(w => {
          const last = t.messages
            .filter(m => (m.kind === 'label' || m.kind === 'unlabel') && m.label === w.on.issues!.label)
            .at(-1);
          return last?.kind === 'label' && last.trusted;
        })
      );
    const start = (w: Workflow, issue: number, at: string, m?: Message) =>
      Effect.gen(function* () {
        const begun = {
          ...begin(w, { id: `${w.name}-${issue}-${at.replace(/\D/g, '')}`, issue, started: at }),
          ...(m?.kind === 'comment' && { said: heard(m) }),
        };
        const run = begun.status === 'running' ? begun : yield* show(w, begun);
        busy.add(`${w.name}#${issue}`);
        yield* store.put(run);
        if (m) yield* eyes(run, m);
        touched.push(run);
      });
    for (const m of messages) {
      const relabelled = messages.some(
        n => n.issue === m.issue && n.label === m.label && n.at > m.at && (n.kind === 'label' || n.kind === 'unlabel')
      );
      const w =
        m.kind === 'label'
          ? relabelled
            ? undefined
            : labelled.find(w => w.on.issues!.label === m.label)
          : m.kind === 'comment'
            ? triggered.find(w => m.comment?.body.trim().startsWith(w.on.issue_comment!.command!))
            : undefined;
      if (!w || used.has(m) || !m.trusted || !open.has(m.issue)) continue;
      if (!busy.has(`${w.name}#${m.issue}`)) yield* start(w, m.issue, m.at, m);
    }
    if (only !== undefined && (fresh ? runs.length === 0 : !runs.some(live)) && !touched.some(r => r.issue === only)) {
      const w = triggered[0] ?? (yield* assigned(only));
      if (w) yield* start(w, only, now());
    }

    const running = (yield* store.list({ status: 'running' }))
      .filter(mine)
      .sort((a, b) => a.started.localeCompare(b.started));
    const driven = yield* Effect.forEach(
      running.filter(r => hub.workflows[r.workflow]),
      r =>
        drive(hub.workflows[r.workflow]!, r, hub).pipe(
          Effect.catchAll(e => Effect.as(Effect.logError(`run ${r.id}`, e), r))
        ),
      { concurrency: hub.limits.parallel }
    );
    return [...touched.filter(r => !driven.some(d => d.id === r.id)), ...driven];
  });

/** One pass over the open issues, one after another: each gets the same single look `tick` gives it. */
export const sweep = (hub: Hub): Effect.Effect<Run[], ForgeError | StoreError, Services> =>
  Effect.gen(function* () {
    const issues = (yield* Effect.flatMap(Forge, f => f.issues({ state: 'open' }))).filter(t => !t.pull);
    const runs = yield* Effect.forEach(issues, t => tick(hub, t.number, true));
    return runs.flat();
  });
