import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Chunk, Effect, Either, Schema, Stream } from 'effect';
import { answerWith, context, news, shown, type Issues } from './context.ts';
import { Forge, withheld, type Applied, type ForgeError, type Event, type Proposal, type Issue } from './forge.ts';
import type { Check, Hub } from './hub.ts';
import { hostGit, Sandbox, SandboxError, type Checkout } from './sandbox.ts';
import type { Services } from './services.ts';
import { Session, type SessionSpec, type SessionStop } from './session.ts';
import { Store, type StoreError, type Trace } from './store.ts';
import {
  begin,
  reenter,
  transition,
  type CheckResult,
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
    size: Schema.Literal('XS', 'S', 'M', 'L', 'XL'),
    priority: Schema.Literal('high', 'medium', 'low'),
    stacks_on: Schema.optionalWith(Schema.Int, { exact: true }),
    depends_on: Schema.optionalWith(Schema.mutable(Schema.Array(Schema.Int)), { exact: true }),
  }),
  Schema.Struct({ kind: Schema.Literal('ask'), question: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('back'), why: Schema.String })
);
const decodeProposal = Schema.decodeUnknownEither(ProposalSchema, { onExcessProperty: 'error' });
/** A proposal as an agent writes it. */
type Said = typeof ProposalSchema.Type;
/** An issue an agent proposes; `stacks_on` and `depends_on` name earlier issues in the same block by position, from 1. */
type Child = Extract<Said, { kind: 'issue' }>;
const shapes: Record<Exclude<Proposal['kind'], 'react' | 'rebase'>, string> = {
  comment: '{"kind":"comment","body":"..."}',
  label: '{"kind":"label","add":["..."],"remove":["..."]}',
  push: '{"kind":"push","branch":"...","message":"..."}',
  pull_request: '{"kind":"pull_request","branch":"...","base":"...","title":"...","body":"..."}',
  merge: '{"kind":"merge","number":1,"head":"<sha>"}',
  issue:
    '{"kind":"issue","title":"...","body":"...\\n\\n## Done when\\n...","size":"XS|S|M|L|XL","priority":"high|medium|low","stacks_on":1,"depends_on":[1]}',
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
const proposalsOf = (reply: string, required: boolean): { proposals: Said[]; problems: string[] } => {
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
  const proposals: Said[] = [];
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

/** Whether a new run may start on an issue: always without a hub milestone, else only in it. */
const inScope = (hub: Hub, issue?: Issue) => hub.milestone === undefined || issue?.milestone === hub.milestone;

/** The open pull request on the branch a run of `w` on `issue` works on. */
const pullOf = (w: Workflow, issue: number, open: Issue[]) =>
  w.branch === undefined
    ? undefined
    : open.find(t => t.pull?.branch === expand(w.branch!, open.find(t => t.number === issue) ?? { number: issue }))
        ?.number;

/** The open pull request a run on `issue` stacks on, from a "Stacks on #n" line naming it or its issue. */
const stackOf = (w: Workflow, issue: Issue, open: Issue[]): Run['base'] => {
  const n = Number(/^\s*stacks on #(\d+)\s*$/im.exec(issue.body)?.[1]);
  const on = open.find(t => t.number === n);
  const pull = on?.pull ? on : open.find(t => t.number === pullOf(w, n, open));
  return pull?.pull && { pull: pull.number, branch: pull.pull.branch, sha: pull.pull.head };
};

/** What a run still waits for: a "Stacks on" issue without a pull request, or a "Depends on" issue not yet closed. */
const pending = (w: Workflow, issue: number, open: Issue[]) =>
  w.branch === undefined
    ? []
    : [...(open.find(t => t.number === issue)?.body ?? '').matchAll(/^\s*(stacks|depends) on #(\d+)\s*$/gim)]
        .filter(
          ([, how, n]) =>
            open.some(t => t.number === Number(n) && (how!.toLowerCase() === 'depends' || !t.pull)) &&
            (how!.toLowerCase() === 'depends' || pullOf(w, Number(n), open) === undefined)
        )
        .map(([, , n]) => Number(n));

/** How deep a run's issue may sit and still file children. */
const deepest = 3;

/** How many parents sit above issue `n`, counted up to `deepest`. */
const depthOf = (n: number, above = 0): Effect.Effect<number, ForgeError, Forge> =>
  Effect.flatMap(Forge, f => f.issue(n)).pipe(
    Effect.flatMap(t =>
      t.parent === undefined || above >= deepest ? Effect.succeed(above) : depthOf(t.parent, above + 1)
    )
  );

/**
 * Files children in order under the run's issue, with their size and priority labels and their "Stacks on" and
 * "Depends on" lines, lists them on the issue and begins the workflow again on each XL child. One refusal files none.
 */
const file = (w: Workflow, run: Run, children: Child[]) =>
  Effect.gen(function* () {
    if (children.length === 0) return [];
    const forge = yield* Forge;
    const issue = yield* forge.issue(run.issue);
    const depth = yield* depthOf(run.issue);
    const refusal = (p: Child, i: number) => {
      if (issue.body === withheld(issue.author, 'issue text')) return `#${run.issue} is withheld text from an outsider`;
      if (depth >= deepest) return `#${run.issue} sits ${depth} issues deep; split it by hand`;
      if (!/^#+\s*done when\b/im.test(p.body)) return `${p.title}: say when it is done under a "Done when" heading`;
      const named = [...(p.stacks_on === undefined ? [] : [p.stacks_on]), ...(p.depends_on ?? [])];
      if (named.some(k => k < 1 || k > i))
        return `${p.title}: stacks_on and depends_on name an earlier issue here by position`;
    };
    const refused = children.flatMap((p, i): Applied[] => {
      const reason = refusal(p, i);
      return reason === undefined ? [] : [{ proposal: p, ok: false, reason }];
    });
    if (refused.length > 0) return refused;

    const applied: Applied[] = [];
    const numbers: number[] = [];
    for (const p of children) {
      const lines = [
        ...(p.stacks_on === undefined ? [] : [`Stacks on #${numbers[p.stacks_on - 1]}`]),
        ...(p.depends_on ?? []).map(k => `Depends on #${numbers[k - 1]}`),
      ];
      const a = yield* forge.apply(run.issue, {
        kind: 'issue',
        title: p.title,
        body: [p.body, ...(lines.length > 0 ? [lines.join('\n')] : [])].join('\n\n'),
        parent: run.issue,
        labels: [`size/${p.size}`, `priority/${p.priority}`],
      });
      applied.push(a);
      if (!a.ok) break;
      numbers.push(Number(a.id));
    }
    if (numbers.length === 0) return applied;
    const list = numbers.map(n => `- [ ] #${n}`).join('\n');
    applied.push(yield* forge.apply(run.issue, { kind: 'comment', body: `Split into:\n\n${list}` }));
    const store = yield* Store;
    for (const [i, n] of numbers.entries()) {
      if (children[i]!.size !== 'XL' || depth + 1 >= deepest) continue;
      const at = now();
      yield* store.put(begin(w, { id: `${w.name}-${n}-${at.replace(/\D/g, '')}`, issue: n, started: at }));
    }
    return applied;
  });

/** The run's issue and the pull request on its branch, fetched before every session. */
const issuesOf = (w: Workflow, run: Run): Effect.Effect<Issues, ForgeError, Forge> =>
  Effect.gen(function* () {
    const forge = yield* Forge;
    const issue = yield* forge.issue(run.issue);
    const pull =
      issue.pull || w.branch === undefined ? undefined : pullOf(w, run.issue, yield* forge.issues({ state: 'open' }));
    return { issue, ...(pull !== undefined && { pull: yield* forge.issue(pull) }) };
  });

const sh = (
  script: string,
  hub: string,
  dir: string,
  env: Record<string, string>,
  minutes: number,
  network: 'none' | 'proxy' = 'none'
) =>
  Effect.flatMap(Sandbox, s =>
    Effect.scoped(s.exec({ cmd: 'sh', args: ['-c', script], dir, hub, env, network, minutes }))
  );

const index = Effect.unsafeMakeSemaphore(1);

/** What the checkout changed since its base, read by host git from the same index a push commits. */
const changes = (work: Checkout, ...args: string[]) =>
  Effect.gen(function* () {
    const text = (args: string[]) => Effect.map(hostGit(work.git, args), out => out.toString('utf8').trim());
    const tree = yield* index.withPermits(1)(Effect.zipRight(text(['add', '-A']), text(['write-tree'])));
    return yield* text(['diff', '--no-color', '--no-ext-diff', '--no-textconv', ...args, work.base, tree]);
  });

const diffOf = (work: Checkout) => changes(work, '--text');

/** The items a fan-out runs over: changed files, diff hunks, or the lines a command prints. */
const itemsOf = (
  each: string | { run: string },
  hub: string,
  work: Checkout,
  minutes: number,
  env: Record<string, string> = { BOTHUB_BASE: work.base }
) => {
  const lines = (text: string) => text.split('\n').filter(line => line.trim());
  if (each === 'hunks')
    return Effect.map(diffOf(work), diff =>
      diff
        .split(/^(?=diff --git )/m)
        .filter(Boolean)
        .flatMap(file => {
          const [head = '', ...hunks] = file.split(/^(?=@@ )/m);
          return hunks.map(hunk => `${head}${hunk}`.trimEnd());
        })
    );
  if (each === 'files') return Effect.map(changes(work, '--name-only'), lines);
  const script = typeof each === 'string' ? each : each.run;
  return Effect.map(sh(script, hub, work.dir, env, minutes), out => lines(out.output));
};

/** Writes the news since `seen` to the checkout's news file; a failed refresh logs and keeps the old file. */
const refresh = (w: Workflow, run: Run, work: Checkout, seen: Seen, t?: Issues) =>
  (t ? Effect.succeed(t) : issuesOf(w, run)).pipe(
    Effect.flatMap(t => Effect.tryPromise(() => writeFile(work.news, `${news(t, seen).text || 'Nothing new yet.'}\n`))),
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

/** What checks read beside the news file, where they cannot write: the pending proposals, the issue as agents see it and the reply. */
const checkFiles = (work: Checkout) => ({
  BOTHUB_PROPOSALS: join(dirname(work.news), 'proposals.json'),
  BOTHUB_CONTEXT: join(dirname(work.news), 'context.md'),
  BOTHUB_REPLY: join(dirname(work.news), 'reply.md'),
});

/** What a try left for its checks: the checkout, the run and its issue, the issue as agents saw it, the reply and the proposals. */
type Left = Checkout & { run: string; issue: number; context: string; reply: string; proposals: Proposal[] };

type Item = { item: string | undefined; pass: boolean; findings: string; exit?: number };

/** One check over what a try left: its items, the command per item, then the agent that judges. Per-item results are traced; judging sessions' cost comes back as `usd`. */
const resultOf = (step: Step, check: Doc<Check>, work: Left, hub: Hub) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const run = work.run;
    const started = Date.now();
    const minutes = hub.limits.minutes;
    const base = { BOTHUB_BASE: work.base, BOTHUB_ISSUE: String(work.issue), ...checkFiles(work) };
    const items: (string | undefined)[] = check.each
      ? yield* itemsOf(check.each, hub.dir, work, minutes, base)
      : [undefined];
    let usd = 0;
    const one = (item: string | undefined) =>
      Effect.gen(function* () {
        const env = { ...base, ...(item !== undefined && { BOTHUB_ITEM: item }) };
        const out = check.run ? yield* sh(check.run, hub.dir, work.dir, env, minutes) : undefined;
        const exit = out && { exit: out.code };
        if (!check.agent) return { item, pass: (out?.code ?? 0) === 0, findings: out?.output ?? '', ...exit };
        const agent = hub.agents[check.agent]!;
        const input = out?.output ?? item ?? (yield* diffOf(work));
        const judged = yield* converse(
          run,
          step.name,
          {
            harness: agent.harness,
            agent: check.agent,
            minutes: hub.limits.minutes,
            ...(agent.model !== undefined && { model: agent.model }),
            system: agent.body,
            prompt: `${check.body}\n\n${input}\n\nReply PASS or FAIL first, then why.`,
            dir: work.dir,
            tools: agent.tools,
          },
          item
        );
        usd += judged.usd;
        return { item, pass: /^\W*PASS\b/.test(judged.final), findings: judged.final, ...exit };
      });
    const over = check.max !== undefined && items.length > check.max;
    const results: Item[] = over
      ? [{ item: undefined, pass: false, findings: `${items.length} items, more than ${check.max}` }]
      : yield* Effect.forEach(items, one, { concurrency: 'unbounded' });
    const failing = results.filter(r => !r.pass);
    const empty = check.each !== undefined && items.length === 0;
    const result: CheckResult = {
      check: check.name,
      pass: failing.length === 0,
      ...(empty && { empty, findings: 'Judged nothing: each found no items.' }),
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
          check: { check: check.name, pass: r.pass, ...(!r.pass && { findings: squeeze(r.findings) }), ms: 0 },
          item: r.item!,
          ...(r.exit !== undefined && { exit: r.exit }),
        })),
      {
        at,
        step: step.name,
        check: result,
        ...(!check.each && results[0]?.exit !== undefined && { exit: results[0].exit }),
      }
    );
    return { result, usd };
  });

/** One try of the current step: a session, a script or a wait, then its checks, then apply proposals on a pass. */
const attempt = (
  w: Workflow,
  run: Run,
  hub: Hub,
  work: Checkout
): Effect.Effect<{ outcome: Outcome; run: Run }, SandboxError | SessionStop | ForgeError | StoreError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const step = w.steps.find(s => s.name === run.step)!;
    const minutes = hub.limits.minutes;
    const done = (outcome: Outcome, next = run) => ({ outcome, run: next });
    /** The first session of a run a comment started may only answer that comment. */
    const answering =
      'agent' in step.does &&
      !!hub.agents[step.does.agent]?.returns.includes('comment') &&
      run.said !== undefined &&
      Object.keys(run.sessions).length === 0;
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
    const t = yield* issuesOf(w, run);
    if ('run' in step.does) {
      const started = Date.now();
      const out = yield* sh(step.does.run, hub.dir, work.dir, { BOTHUB_BASE: work.base }, minutes);
      const result: CheckResult = {
        check: step.name,
        pass: out.code === 0,
        ...(out.code !== 0 && { findings: squeeze(out.output) }),
        ms: Date.now() - started,
      };
      yield* store.trace(run.id, { at: now(), step: step.name, check: result, exit: out.code });
      if (!result.pass) return done({ kind: 'failed', checks: [result], proposals: [], problems: [] });
      replies.push(out.output);
    } else {
      const agent = hub.agents[step.does.agent]!;
      const issue = t.issue;
      const kept = step.each === undefined ? run.sessions[step.name] : undefined;
      const reads = agent.tools.includes('read');
      const kinds = [...agent.returns.filter(k => k !== 'ask' && k !== 'back'), 'ask', ...(step.back ? ['back'] : [])];
      const prompt = [
        step.does.skill && hub.skills[step.does.skill]?.body,
        w.body,
        context(t),
        w.branch &&
          `Work on the branch ${expand(w.branch, issue)}; pull requests go into ${run.base?.branch ?? issue.pull?.base ?? expand(w.base ?? 'main', issue)}.`,
        step.back?.until && `Propose back with a reason while this does not hold: ${step.back.until}`,
        answering &&
          'A comment started this run. When it does not ask for work, answer it with comment proposals only; that ends the run.',
        reads &&
          `People may comment while you work: ${work.news} holds what is new, refreshed every minute. Read it before you finish.`,
        run.feedback,
        [
          'End your reply with a fenced bothub block holding a JSON array of proposals. The runner commits, pushes,',
          'opens pull requests and posts comments from them, so do not run git or gh yourself. The shape of each kind:',
          ...kinds.map(k => shapes[k as keyof typeof shapes]),
        ].join('\n'),
      ]
        .filter(Boolean)
        .join('\n\n');
      const items: (string | undefined)[] = step.each ? yield* itemsOf(step.each, hub.dir, work, minutes) : [undefined];
      const caught = news(t, kept ? (kept.seen ?? { at: run.started }) : { at: '' });
      for (const item of items) {
        yield* refresh(w, run, work, caught.seen, t);
        const fresher = Effect.forever(Effect.delay(refresh(w, run, work, caught.seen), '1 minute'));
        const talk = converse(
          run.id,
          step.name,
          {
            harness: agent.harness,
            agent: step.does.agent,
            minutes,
            ...(agent.model !== undefined && { model: agent.model }),
            system: agent.body,
            prompt: kept
              ? [run.feedback ?? 'Continue.', caught.text].filter(Boolean).join('\n\n')
              : item === undefined
                ? prompt
                : `${prompt}\n\n## Item\n\n${item}`,
            dir: work.dir,
            tools: agent.tools,
            ...(reads && { read: [dirname(work.news)] }),
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
    const world = proposals
      .filter(p => p.kind !== 'ask' && p.kind !== 'back')
      .map(p => {
        if (p.kind !== 'pull_request') return p;
        const body = p.body.replace(/^Stacks on #\d+\.?[ \t]*/gim, '').trim();
        return run.base
          ? { ...p, base: run.base.branch, body: `${body}\n\nStacks on #${run.base.pull}` }
          : { ...p, body };
      });

    const answered = answering && !back && world.length > 0 && world.every(p => p.kind === 'comment');
    const { outcome: gated, usd } = answered
      ? { outcome: { kind: 'pass' } as const, usd: 0 }
      : yield* gate(
          step,
          {
            run: run.id,
            ...work,
            issue: run.issue,
            context: context(t),
            reply: replies.join('\n\n'),
            proposals: world,
          },
          hub
        );
    tried = { ...tried, usd: tried.usd + usd };
    if (gated.kind === 'failed' || (gated.kind === 'pass' && problems.length > 0))
      return done(
        gated.kind === 'failed'
          ? { ...gated, problems: [...gated.problems, ...problems] }
          : { kind: 'failed', checks: [], proposals: [], problems },
        tried
      );
    if (gated.kind !== 'pass') return done(gated, tried);
    if (back) return done({ kind: 'back', why: back.why }, tried);

    const to =
      world.some(p => p.kind === 'comment') && !run.said
        ? pullOf(w, run.issue, yield* Effect.flatMap(Forge, f => f.issues({ state: 'open' })))
        : undefined;
    const children = world.filter((p): p is Child => p.kind === 'issue');
    const rest = world.filter(p => p.kind !== 'issue');
    const landed = yield* Effect.either(
      Effect.zipWith(land(tried, rest, work, to), file(w, tried, children), (a, b) => [...a, ...b])
    );
    if (Either.isLeft(landed) && landed.left._tag === 'StoreError') return yield* landed.left;
    if (Either.isLeft(landed))
      return done({ kind: 'ask', question: `GitHub failed: ${squeeze(landed.left.message, 200)}` }, tried);
    const applied = landed.right;
    yield* store.trace(run.id, ...applied.map(a => ({ at: now(), step: step.name, applied: a })));
    const failed = applied.filter(a => !a.ok);
    return done(
      failed.length
        ? { kind: 'failed', checks: [], proposals: failed, problems: [] }
        : { kind: 'pass', ...(answered && { answered: true as const }) },
      tried
    );
  });

/** The step's checks over what a try left behind: scripts in one batch, agent checks only when no script failed. `usd` is what the agent checks cost. */
export const gate = (
  step: Step,
  left: Left,
  hub: Hub
): Effect.Effect<
  { outcome: Outcome; usd: number },
  SandboxError | SessionStop | StoreError,
  Sandbox | Session | Store
> =>
  Effect.gen(function* () {
    const checks = step.checks.map(name => ({ ...hub.checks[name]!, name }));
    const files = checkFiles(left);
    yield* Effect.promise(() =>
      Promise.all([
        writeFile(files.BOTHUB_PROPOSALS, JSON.stringify(left.proposals)),
        writeFile(files.BOTHUB_CONTEXT, left.context),
        writeFile(files.BOTHUB_REPLY, left.reply),
      ])
    );
    const holds = (c: Check) => c.mode === 'block' || c.mode === 'stop';
    const results = (list: Doc<Check>[]) =>
      Effect.forEach(list, c => resultOf(step, c, left, hub), { concurrency: 'unbounded' });
    const scripts = checks.filter(c => !c.agent);
    const judged = checks.filter(c => c.agent);
    const first = (yield* results(scripts)).map(r => r.result);
    const blocked = first.some((v, i) => !v.pass && holds(scripts[i]!));
    const agents = blocked ? [] : yield* results(judged);
    const usd = agents.reduce((sum, r) => sum + r.usd, 0);
    const all = [...first, ...agents.map(r => r.result)];
    const failed = (mode: Check['mode']) =>
      all.filter(v => !v.pass && checks.find(c => c.name === v.check)?.mode === mode);

    const stops = failed('stop');
    if (stops.length > 0)
      return {
        outcome: { kind: 'stop', why: stops.map(v => `${v.check}: ${v.findings ?? 'failed'}`).join('\n') },
        usd,
      };
    const returns = 'agent' in step.does ? hub.agents[step.does.agent]?.returns : undefined;
    const proposals: Applied[] = left.proposals
      .filter(p => returns && !returns.some(k => k === p.kind))
      .map(p => ({ proposal: p, ok: false, reason: `${step.name} may not propose ${p.kind}` }));
    const blocking = failed('block');
    const outcome: Outcome =
      blocking.length > 0 || proposals.length > 0
        ? { kind: 'failed', checks: blocking, proposals, problems: [] }
        : { kind: 'pass' };
    return { outcome, usd };
  });

/**
 * Lands the run's status labels and status comment; the run comes back holding its status comment's id, and without
 * its 👀 once that comment is posted.
 */
const slugOf = (forge: Forge['Type']) =>
  forge.slug ? Effect.orElseSucceed(forge.slug, () => undefined) : Effect.succeed(undefined);

const show = (w: Workflow, run: Run): Effect.Effect<Run, StoreError, Forge | Store> =>
  Effect.gen(function* () {
    const forge = yield* Forge;
    const t = yield* issuesOf(w, run);
    const slug = yield* slugOf(forge);
    const status = yield* Effect.forEach(shown(run, w, t, slug), p => forge.apply(run.issue, p));
    const reply = status.find(a => a.proposal.kind === 'comment');
    const undone = reply?.ok && run.eyes ? [yield* forge.apply(run.eyes.issue, run.eyes.undo)] : [];
    yield* Effect.flatMap(Store, s =>
      s.trace(run.id, ...[...status, ...undone].map(a => ({ at: now(), step: run.step, applied: a })))
    );
    if (!reply) return run;
    const { comment: _gone, eyes, ...rest } = run;
    return { ...rest, ...(eyes && !undone.length && { eyes }), ...(reply.ok && reply.id && { comment: reply.id }) };
  }).pipe(Effect.catchTag('ForgeError', e => Effect.as(Effect.logWarning(`status of run ${run.id}`, e), run)));

/** Applies the accepted proposals after a pass, pushes first. Replies go where a human last spoke, else to `to`. */
const land = (
  run: Run,
  proposals: Proposal[],
  work?: Checkout,
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
 * Runs the hub's setup, then tries until the run stops running. An infra failure stops the run with its reason.
 * Files are kept under `refs/bothub/runs/<run id>`.
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
        if (next.status === 'waiting' && next.reason) {
          const elsewhere = next.said && next.said.issue !== next.issue;
          const body = elsewhere ? `${next.reason}\n\n${answerWith(yield* slugOf(forge))}` : next.reason;
          const said = yield* Effect.either(land(next, [{ kind: 'comment', body }]));
          if (Either.isRight(said))
            yield* store.trace(next.id, ...said.right.map(applied => ({ at: now(), step: next.step, applied })));
        }
        current = yield* show(w, next);
        yield* store.put(current);
      });
    const walk = Effect.gen(function* () {
      yield* store.lock(run.id);
      const issue = yield* forge.issue(run.issue);
      current = yield* show(w, { ...current, title: issue.title, body: issue.body });
      yield* store.put(current);
      const stacked = hub.stacks && !current.base && stackOf(w, issue, yield* forge.issues({ state: 'open' }));
      if (stacked) yield* store.put((current = { ...current, base: stacked }));
      const ref = issue.pull?.branch ?? current.base?.branch ?? expand(w.base ?? 'main', issue);
      const work = yield* Effect.flatMap(Sandbox, s =>
        s.checkout(ref, w.branch && expand(w.branch, issue), `refs/bothub/runs/${run.id}`, hub)
      );
      if (hub.setup) {
        const out = yield* sh(hub.setup, hub.dir, work.dir, { BOTHUB_BASE: work.base }, hub.limits.minutes, 'proxy');
        if (out.code !== 0)
          return yield* new SandboxError({
            reason: 'infra',
            detail: `setup exited ${out.code}: ${squeeze(out.output)}`,
          });
      }
      while (current.status === 'running') {
        const tried = yield* attempt(w, current, hub, work);
        yield* settle(tried.outcome, transition(w, tried.run, tried.outcome));
        if (current.status === 'running' && current.usd > hub.limits.usdPerRun) {
          const why = `Spent $${current.usd.toFixed(2)}, over the hub's usd-per-run of ${hub.limits.usdPerRun}.`;
          yield* settle({ kind: 'stop', why }, transition(w, current, { kind: 'stop', why }));
        }
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

/** Rebases a stacked run's branch onto `head`, the new head of the pull request it stacks on; a conflict is said on the issue. */
const follow = (w: Workflow, run: Run, base: NonNullable<Run['base']>, head: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const forge = yield* Forge;
    yield* store.lock(run.id);
    const branch = expand(w.branch!, yield* forge.issue(run.issue));
    const work = yield* Effect.flatMap(Sandbox, s => s.checkout(base.branch, branch, `refs/bothub/runs/${run.id}`));
    const applied = yield* forge.apply(run.issue, { kind: 'rebase', branch, from: base.sha, onto: head }, work);
    const body = `#${base.pull} moved and ${branch} could not follow: ${applied.reason}. Rebase it by hand, or say what to do.`;
    const said = applied.ok ? [] : yield* land(run, [{ kind: 'comment', body }]);
    yield* store.trace(run.id, ...[applied, ...said].map(a => ({ at: now(), step: run.step, applied: a })));
    yield* store.put({ ...run, base: { ...base, sha: head } });
  }).pipe(Effect.scoped);

/**
 * One look at the repo: reenter live runs, begin new ones on a trusted command or label, drive up to `limits.parallel`.
 * With `only`, it looks at that issue alone and begins a run there when none was live; with `marked` too, only on a
 * trusted command or label.
 */
export const tick = (
  hub: Hub,
  only?: number,
  marked = false
): Effect.Effect<Run[], ForgeError | StoreError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const forge = yield* Forge;
    const mine = (r: { issue: number }) => only === undefined || r.issue === only;
    const runs = (yield* store.list()).filter(mine);
    const waiting = yield* Effect.forEach(runs.filter(live), r =>
      Effect.map(Stream.runLast(Stream.filter(store.read(r.id), t => !('saved' in t))), last => ({
        run: r,
        at: last._tag === 'Some' ? last.value.at : r.started,
      }))
    );
    const started = runs
      .map(r => r.started)
      .sort()
      .at(-1);
    const cursor = started === undefined ? '' : [started, ...waiting.map(p => p.at)].sort()[0]!;
    const issues = yield* forge.issues({ state: 'open' });
    const latest = Chunk.toArray(yield* Stream.runCollect(forge.since(cursor)));
    const merged = yield* Effect.forEach(
      latest.filter(m => m.kind === 'merged' && !issues.some(t => t.number === m.issue)),
      m => forge.issue(m.issue)
    );
    const origin = new Map<Event, number>();
    const onRun = (m: Event): Event => {
      const r = runs.find(
        r =>
          r.issue !== m.issue &&
          hub.workflows[r.workflow] &&
          pullOf(hub.workflows[r.workflow]!, r.issue, [...issues, ...merged]) === m.issue
      );
      if (!r) return m;
      const moved = { ...m, issue: r.issue };
      origin.set(moved, m.issue);
      return moved;
    };
    /** Where a human spoke: the issue, and the review comment thread when it was one. */
    const heard = (m: Event): NonNullable<Run['said']> => {
      const c = m.kind === 'comment' ? m.comment : undefined;
      return { issue: origin.get(m) ?? m.issue, ...(c?.path !== undefined && { under: c.under ?? c.id }) };
    };
    /** 👀 on the comment that woke a run, or on its issue for a label; the run comes back holding it. */
    const eyes = (run: Run, m: Event): Effect.Effect<Run, StoreError> => {
      if (m.kind !== 'comment' && m.kind !== 'label') return Effect.succeed(run);
      const issue = origin.get(m) ?? m.issue;
      const react: Extract<Proposal, { kind: 'react' }> = {
        kind: 'react',
        ...(m.kind === 'comment' &&
          m.comment && { comment: m.comment.id, ...(m.comment.path !== undefined && { review: true }) }),
      };
      return forge.apply(issue, react).pipe(
        Effect.tap(applied => store.trace(run.id, { at: now(), step: run.step, applied })),
        Effect.map(a => (a.ok && a.id ? { ...run, eyes: { issue, undo: { ...react, remove: a.id } } } : run)),
        Effect.catchTag('ForgeError', e => Effect.as(Effect.logWarning(`react for run ${run.id}`, e), run))
      );
    };
    const triggered = Object.values(hub.workflows).filter(w => w.on.issue_comment?.command);
    const command = triggered[0]?.on.issue_comment?.command;
    /** A trusted comment on a thread the bot has a run on speaks to the bot, unless it mentions someone else. */
    const addressed = (m: Event): Event => {
      const body = m.comment?.body.trim() ?? '';
      if (m.kind !== 'comment' || !m.trusted || !m.comment || command === undefined || body.startsWith(command))
        return m;
      if (/(^|\s)@[\w-]/.test(body) || !runs.some(r => r.issue === m.issue)) return m;
      const spoken = { ...m, comment: { ...m.comment, body: `${command} ${body}` } };
      if (origin.has(m)) origin.set(spoken, origin.get(m)!);
      return spoken;
    };
    const events = latest.map(onRun).map(addressed).filter(mine);
    const used = new Set<Event>();
    const touched: Run[] = [];
    waiting.sort((a, b) => b.run.started.localeCompare(a.run.started));
    for (const { run, at } of waiting) {
      const w = hub.workflows[run.workflow];
      const answers = w
        ? events.filter(m => m.issue === run.issue && m.at > at && !used.has(m) && reenter(w, run, m, command))
        : [];
      const m = answers.find(m => m.kind === 'merged') ?? answers[0];
      if (!w || !m) continue;
      used.add(m);
      const outcome = reenter(w, run, m, command)!;
      const seen = m.kind === 'comment' ? yield* eyes(run, m) : run;
      const moved = { ...transition(w, seen, outcome), said: heard(m) };
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
    const open = new Set(issues.filter(t => inScope(hub, t)).map(t => t.number));
    const labelled = Object.values(hub.workflows).filter(w => w.on.issues?.label);
    /** The label workflow whose label an issue carries, when a maintainer put it there last. */
    const assigned = (issue: number) =>
      Effect.map(forge.issue(issue), t =>
        labelled.find(w => {
          const last = t.events
            .filter(m => (m.kind === 'label' || m.kind === 'unlabel') && m.label === w.on.issues!.label)
            .at(-1);
          return last?.kind === 'label' && last.trusted;
        })
      );
    const start = (w: Workflow, issue: number, at: string, m?: Event) =>
      Effect.gen(function* () {
        const begun = {
          ...begin(w, { id: `${w.name}-${issue}-${at.replace(/\D/g, '')}`, issue, started: at }),
          ...(m?.kind === 'comment' && { said: heard(m) }),
        };
        const first = begun.status === 'running' ? begun : yield* show(w, begun);
        busy.add(`${w.name}#${issue}`);
        yield* store.put(first);
        const run = m ? yield* eyes(first, m) : first;
        if (run !== first) yield* store.put(run);
        touched.push(run);
      });
    for (const m of events) {
      const relabelled = events.some(
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
      if (m.kind === 'comment' && /^\S+\s+stop(\s|$)/i.test(m.comment?.body.trim() ?? '')) continue;
      const held =
        m.kind === 'comment' ? [...busy].some(k => k.endsWith(`#${m.issue}`)) : busy.has(`${w.name}#${m.issue}`);
      if (!held) yield* start(w, m.issue, m.at, m);
    }
    if (only !== undefined && !marked && !runs.some(live) && !touched.some(r => r.issue === only)) {
      const w = triggered[0] ?? (yield* assigned(only));
      if (
        w &&
        inScope(
          hub,
          issues.find(t => t.number === only)
        )
      )
        yield* start(w, only, now());
    }

    for (const r of runs.map(r => touched.find(t => t.id === r.id) ?? r).filter(live)) {
      const w = hub.workflows[r.workflow];
      const head = r.base && issues.find(t => t.number === r.base!.pull)?.pull?.head;
      if (!w || !r.base || !head || head === r.base.sha || pullOf(w, r.issue, issues) === undefined) continue;
      yield* follow(w, r, r.base, head).pipe(Effect.catchAll(e => Effect.logError(`follow run ${r.id}`, e)));
    }

    const rank = (r: Run) => {
      const labels = issues.find(t => t.number === r.issue)?.labels ?? [];
      return labels.includes('priority/high') ? 0 : labels.includes('priority/low') ? 2 : 1;
    };
    const running = (yield* store.list({ status: 'running' }))
      .filter(mine)
      .filter(r => hub.workflows[r.workflow] && pending(hub.workflows[r.workflow]!, r.issue, issues).length === 0)
      .sort((a, b) => rank(a) - rank(b) || a.started.localeCompare(b.started));
    const driven = yield* Effect.forEach(
      running,
      r =>
        drive(hub.workflows[r.workflow]!, r, hub).pipe(
          Effect.catchAll(e => Effect.as(Effect.logError(`run ${r.id}`, e), r))
        ),
      { concurrency: hub.limits.parallel }
    );
    return [...touched.filter(r => !driven.some(d => d.id === r.id)), ...driven];
  });

/**
 * One pass over the open issues and the issues of live runs, one after another: each gets one look, and a new run only
 * on a trusted mark.
 */
export const sweep = (hub: Hub): Effect.Effect<Run[], ForgeError | StoreError, Services> =>
  Effect.gen(function* () {
    const open = (yield* Effect.flatMap(Forge, f => f.issues({ state: 'open' }))).filter(
      t => !t.pull && inScope(hub, t)
    );
    const runs = (yield* Effect.flatMap(Store, s => s.list())).filter(live);
    const issues = [...new Set([...open.map(t => t.number), ...runs.map(r => r.issue)])];
    return (yield* Effect.forEach(issues, n => tick(hub, n, true))).flat();
  });
