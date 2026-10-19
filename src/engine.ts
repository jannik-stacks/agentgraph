import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Chunk, Data, Effect, Either, Option, Schema, Stream } from 'effect';
import { answerWith, context, footer, line, news, shown, transcript, type Issues } from './context.ts';
import { Forge, withheld, type Applied, type ForgeError, type Event, type Proposal, type Issue } from './forge.ts';
import type { Check, Hub } from './hub.ts';
import { hostGit, Sandbox, SandboxError, type Checkout } from './sandbox.ts';
import type { Services } from './services.ts';
import { Session, SessionStop, type SessionSpec } from './session.ts';
import { type Aside, Store, type StoreError, type Trace } from './store.ts';
import {
  begin,
  failure,
  fold,
  reenter,
  transition,
  type CheckResult,
  type Doc,
  type Outcome,
  type Run,
  type Seen,
  type Step,
  type Workflow,
  waits,
  afterCommand,
} from './workflow.ts';

const now = () => new Date().toISOString();

const Names = Schema.optionalWith(Schema.mutable(Schema.Array(Schema.String)), {
  exact: true,
});
const ProposalSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('comment'),
    body: Schema.String,
    under: Schema.optionalWith(Schema.String, { exact: true }),
  }),
  Schema.Struct({ kind: Schema.Literal('label'), add: Names, remove: Names }),
  Schema.Struct({
    kind: Schema.Literal('push'),
    branch: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('pull_request'),
    branch: Schema.String,
    base: Schema.String,
    title: Schema.String,
    body: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('merge'),
    number: Schema.Int,
    head: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('issue'),
    relation: Schema.Literal('part'),
    title: Schema.String,
    body: Schema.String,
    size: Schema.Literal('XS', 'S', 'M', 'L', 'XL'),
    priority: Schema.Literal('high', 'medium', 'low'),
    stacks_on: Schema.optionalWith(Schema.Int, { exact: true }),
    depends_on: Schema.optionalWith(Schema.mutable(Schema.Array(Schema.Int)), {
      exact: true,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal('issue'),
    relation: Schema.Literal('follow-up', 'hub'),
    title: Schema.String,
    body: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal('ask'), question: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('back'), why: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('run'),
    workflow: Schema.String,
    issue: Schema.Int,
  })
);
const decodeProposal = Schema.decodeUnknownEither(ProposalSchema, {
  onExcessProperty: 'error',
});
/** A proposal as an agent writes it. */
type Said = typeof ProposalSchema.Type;
/**
 * An issue an agent proposes: a `part` of the run's issue, a `follow-up` found while working on it, or a `hub` change
 * to the bot's own workflows, agents or checks. A part's `stacks_on` and `depends_on` name earlier issues in the same
 * block by position, from 1.
 */
type Child = Extract<Said, { kind: 'issue' }>;
const isPart = (p: Child): p is Extract<Child, { relation: 'part' }> => p.relation === 'part';
const shapes: Record<Exclude<Proposal['kind'], 'react' | 'rebase'>, string> = {
  comment: [
    '{"kind":"comment","body":"..."}',
    '{"kind":"comment","body":"...","under":"<id of the review comment you answer>"}',
  ].join('\n'),
  label: '{"kind":"label","add":["..."],"remove":["..."]}',
  push: '{"kind":"push","branch":"...","message":"..."}',
  pull_request: '{"kind":"pull_request","branch":"...","base":"...","title":"...","body":"..."}',
  merge: '{"kind":"merge","number":1,"head":"<sha>"}',
  issue: [
    '{"kind":"issue","relation":"part","title":"...","body":"...\\n\\n## Done when\\n...","size":"XS|S|M|L|XL","priority":"high|medium|low","stacks_on":1,"depends_on":[1]}',
    '{"kind":"issue","relation":"follow-up","title":"...","body":"...\\n\\n## Done when\\n..."}',
    '{"kind":"issue","relation":"hub","title":"...","body":"<the class of miss and the check that would catch it>\\n\\n## Done when\\n..."}',
  ].join('\n'),
  ask: '{"kind":"ask","question":"..."}',
  back: '{"kind":"back","why":"..."}',
  run: '{"kind":"run","workflow":"<name of a bothub workflow to start; run a command with your shell tool instead>","issue":1}',
};
const shapeOf = (item: unknown) => {
  const kind = (item as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' && kind in shapes
    ? `write it as ${shapes[kind as keyof typeof shapes]}`
    : `kind must be one of ${Object.keys(shapes).join(', ')}${kind === 'reply' ? '; to answer, use comment, it is posted under the thread you are answering' : ''}`;
};
const block = /^(`{3,}|~{3,})[ \t]*bothub[ \t]*\r?\n([\s\S]*?)^\1[ \t]*$/gm;

/** The proposals in the last fenced `bothub` block of a reply: a JSON array. */
const proposalsOf = (reply: string, required: boolean): { proposals: Said[]; problems: string[] } => {
  const source = [...reply.matchAll(block)].at(-1)?.[2]?.trim();
  if (source === undefined)
    return {
      proposals: [],
      problems: required ? ['end the reply with a fenced bothub block: a JSON array'] : [],
    };
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
      return {
        proposals: [],
        problems: [`bothub block: ${(e as Error).message}`],
      };
    }
  }
  if (items !== null && typeof items === 'object' && !Array.isArray(items)) items = [items];
  if (!Array.isArray(items))
    return {
      proposals: [],
      problems: ['bothub block: a JSON array of proposals'],
    };
  const proposals: Said[] = [];
  const problems: string[] = [];
  items.forEach((item, i) =>
    Either.match(decodeProposal(item), {
      onLeft: () => problems.push(`proposal ${i + 1}: ${shapeOf(item)}`),
      onRight: p => proposals.push(p),
    })
  );
  if (problems.length > 0 && proposals.length > 0)
    problems.push('nothing from this reply was applied: send every proposal again, not only the fixed ones');
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
  return (
    pull?.pull && {
      pull: pull.number,
      branch: pull.pull.branch,
      sha: pull.pull.head,
    }
  );
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
 * Files proposed issues in order. A part becomes a sub-issue of the run's issue with its size and priority labels and
 * its "Stacks on" and "Depends on" lines; the parts are listed on the issue and each XL part begins the workflow
 * again. A follow-up or a hub change becomes a plain issue labelled with its relation that names the run's issue and
 * starts nothing; one with the title of an open issue is added there as a comment. One refusal files none.
 */
const file = (w: Workflow, run: Run, children: Child[]) =>
  Effect.gen(function* () {
    if (children.length === 0) return [];
    const forge = yield* Forge;
    const issue = yield* forge.issue(run.issue);
    const depth = yield* depthOf(run.issue);
    const open = new Map((yield* forge.issues({ state: 'open' })).map(t => [t.title.trim().toLowerCase(), t.number]));
    const refusal = (p: Child, i: number) => {
      if (issue.body === withheld(issue.author, 'issue text')) return `#${run.issue} is withheld text from an outsider`;
      if (isPart(p) && open.has(p.title.trim().toLowerCase())) return `${p.title}: an open issue has this title`;
      if (!/^#+\s*done when\b/im.test(p.body)) return `${p.title}: say when it is done under a "Done when" heading`;
      if (!isPart(p)) return;
      if (depth >= deepest) return `#${run.issue} sits ${depth} issues deep; split it by hand`;
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
      const lines = isPart(p)
        ? [
            ...(p.stacks_on === undefined ? [] : [`Stacks on #${numbers[p.stacks_on - 1]}`]),
            ...(p.depends_on ?? []).map(k => `Depends on #${numbers[k - 1]}`),
          ]
        : [`Found while working on #${run.issue}`];
      const same = isPart(p) ? undefined : open.get(p.title.trim().toLowerCase());
      if (same !== undefined) {
        applied.push(yield* forge.apply(same, { kind: 'comment', body: [p.body, ...lines].join('\n\n') }));
        numbers.push(same);
        continue;
      }
      const a = yield* forge.apply(run.issue, {
        kind: 'issue',
        title: p.title,
        body: [p.body, ...(lines.length > 0 ? [lines.join('\n')] : [])].join('\n\n'),
        ...(isPart(p)
          ? {
              parent: run.issue,
              labels: [`size/${p.size}`, `priority/${p.priority}`],
            }
          : { labels: [p.relation] }),
      });
      applied.push(a);
      if (!a.ok) break;
      numbers.push(Number(a.id));
    }
    const parts = numbers.filter((_, i) => isPart(children[i]!));
    if (parts.length === 0) return applied;
    const list = parts.map(n => `- [ ] #${n}`).join('\n');
    applied.push(
      yield* forge.apply(run.issue, {
        kind: 'comment',
        body: `Split into:\n\n${list}`,
      })
    );
    const store = yield* Store;
    for (const [i, n] of numbers.entries()) {
      const p = children[i]!;
      if (!isPart(p) || p.size !== 'XL' || depth + 1 >= deepest) continue;
      const at = now();
      yield* store.put(
        begin(w, {
          id: `${w.name}-${n}-${at.replace(/\D/g, '')}`,
          issue: n,
          started: at,
        })
      );
    }
    return applied;
  });

/** The open follow-up and hub issues, so an agent adds to one by its title instead of filing it again. */
const filed = () =>
  Effect.map(
    Effect.flatMap(Forge, f => f.issues({ state: 'open' })),
    open => {
      const listed = open.filter(t => t.labels.some(l => l === 'follow-up' || l === 'hub'));
      return (
        listed.length > 0 &&
        `Open follow-up and hub issues. To add to one, propose an issue with its exact title:\n${listed.map(t => `- #${t.number} ${t.title}`).join('\n')}`
      );
    }
  );

const live = (r: Run) => r.status !== 'done' && r.status !== 'stopped';

/** The reason a run waits while a run it started works. */
const waitingOn = (child: Run) => `waiting on ${child.id}`;

/** Why the run's `run` proposals may not start: one at a time, of a dispatch workflow, on an open issue in scope that no other live run holds. */
const undispatchable = (hub: Hub, run: Run, asked: Extract<Proposal, { kind: 'run' }>[]) =>
  Effect.gen(function* () {
    const [p] = asked;
    if (!p) return [];
    const w = hub.workflows[p.workflow];
    const issue = (yield* Effect.flatMap(Forge, f => f.issues({ state: 'open' }))).find(t => t.number === p.issue);
    const held = (yield* Effect.flatMap(Store, s => s.list({ issue: p.issue }))).some(r => live(r) && r.id !== run.id);
    const reason =
      asked.length > 1
        ? 'propose one run at a time'
        : !w?.on.dispatch
          ? `${p.workflow} is not a workflow with on: dispatch`
          : !issue || issue.pull
            ? `#${p.issue} is not an open issue`
            : !inScope(hub, issue)
              ? `#${p.issue} is outside the hub milestone`
              : held
                ? `a live run holds #${p.issue}`
                : undefined;
    return reason === undefined ? [] : asked.map((proposal): Applied => ({ proposal, ok: false, reason }));
  });

/** Begins the workflow a `run` proposal names, as a run `by` the run that proposed it. */
const dispatch = (hub: Hub, run: Run, p: Extract<Proposal, { kind: 'run' }>) =>
  Effect.gen(function* () {
    const at = now();
    const w = hub.workflows[p.workflow]!;
    const child: Run = {
      ...begin(w, {
        id: `${w.name}-${p.issue}-${at.replace(/\D/g, '')}`,
        issue: p.issue,
        started: at,
      }),
      by: run.id,
    };
    yield* Effect.flatMap(Store, s => s.put(child));
    return child;
  });

/** What a parent hears when the run it started settles. */
const settled = (child: Run) =>
  `${child.workflow} on #${child.issue} ${
    child.status === 'done'
      ? 'is done'
      : child.status === 'stopped'
        ? `stopped: ${child.reason}`
        : `asks: ${child.reason}`
  }`;

/** The run's issue and the pull request on its branch, fetched before every session. */
const issuesOf = (w: Workflow, run: Run): Effect.Effect<Issues, ForgeError, Forge> =>
  Effect.gen(function* () {
    const forge = yield* Forge;
    const issue = yield* forge.issue(run.issue);
    const pull =
      issue.pull || w.branch === undefined ? undefined : pullOf(w, run.issue, yield* forge.issues({ state: 'open' }));
    return {
      issue,
      ...(pull !== undefined && { pull: yield* forge.issue(pull) }),
    };
  });

const newest = (...times: (string | undefined)[]) =>
  times
    .filter(t => t !== undefined)
    .sort()
    .at(-1);

/** The command a comment starts with to speak to the bot. */
const commandOf = (hub: Hub) =>
  Object.values(hub.workflows).find(w => w.on.issue_comment?.command)?.on.issue_comment?.command;

/** A trusted comment that mentions no one else speaks to the bot, read as the command followed by the comment. */
const addressed = (m: Event, command?: string): Event => {
  const body = m.comment?.body.trim() ?? '';
  if (m.kind !== 'comment' || !m.trusted || !m.comment || command === undefined || body.startsWith(command)) return m;
  if (/(^|\s)@[\w-]/.test(body)) return m;
  return { ...m, comment: { ...m.comment, body: `${command} ${body}` } };
};

/** What people said to a live run on its issue and pull request since it last looked, as one outcome, and when the newest of it was said. */
const told = (w: Workflow, run: Run, t: Issues, command?: string) => {
  if (w.on.feedback) return undefined;
  const since = run.seen ?? run.started;
  const said = [...t.issue.events, ...(t.pull?.events ?? [])]
    .filter(m => m.at > since)
    .map(m => addressed({ ...m, issue: run.issue }, command))
    .flatMap(m => {
      const o = reenter(w, run, m, command);
      return o ? [{ o, at: m.at }] : [];
    });
  const outcome = fold(said.map(s => s.o));
  return outcome && { outcome, at: newest(...said.map(s => s.at))! };
};

/** A trusted person's comment, review or pushed commit; a bare stop, cancel or restart is a command, not feedback. */
const feedback = (m: Event, command?: string) =>
  m.trusted &&
  (m.kind === 'comment' ||
    m.kind === 'changes_requested' ||
    m.kind === 'commit' ||
    (m.kind === 'approved' && !!m.comment?.body.trim())) &&
  !/^(stop|cancel|restart(\s+\S+)?)$/i.test(afterCommand(m, command) ?? '');

/** When a trusted person last did something on the issue or its pull request. */
const lastHeard = (t: Issues) =>
  newest(...[t.issue, t.pull].flatMap(x => x?.events ?? []).flatMap(m => (m.trusted ? m.at : [])));

const sh = (
  script: string,
  hub: string,
  dir: string,
  env: Record<string, string>,
  minutes: number,
  network: 'none' | 'proxy' = 'none'
) =>
  Effect.flatMap(Sandbox, s =>
    Effect.scoped(
      s.exec({
        cmd: 'sh',
        args: ['-c', script],
        dir,
        hub,
        env,
        network,
        minutes,
      })
    )
  );

/** Runs the hub's setup in a checkout, so its checks find what it installs. */
const setUp = (hub: Hub, work: Checkout) =>
  Effect.gen(function* () {
    if (!hub.setup) return;
    const out = yield* sh(hub.setup, hub.dir, work.dir, { BOTHUB_BASE: work.base }, hub.limits.minutes, 'proxy');
    if (out.code !== 0)
      return yield* new SandboxError({ reason: 'infra', detail: `setup exited ${out.code}: ${squeeze(out.output)}` });
  });

const index = Effect.unsafeMakeSemaphore(1);

const text = (work: Checkout, args: string[]) =>
  Effect.map(hostGit(work.git, args), out => out.toString('utf8').trim());

/** The checkout's files as a tree id, written by host git from the same index a push commits. */
const treeOf = (work: Checkout) =>
  index.withPermits(1)(Effect.zipRight(text(work, ['add', '-A']), text(work, ['write-tree'])));

/** What the checkout changed since its base. */
const changes = (work: Checkout, ...args: string[]) =>
  Effect.flatMap(treeOf(work), tree =>
    text(work, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', ...args, work.base, tree])
  );

const diffOf = (work: Checkout) => changes(work, '--text');

/** The files whose lines added in `diff` are conflict markers. */
const markedIn = (diff: string) => {
  const files = new Set<string>();
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line.replace(/^\+\+\+ (b\/)?/, '');
    else if (/^\+(<{7}|>{7})( |$)/.test(line)) files.add(file);
  }
  return [...files];
};

/** `head` merged onto `onto` as a tree, conflict markers left in the files that clash, which come back in `files`. */
const mergeOf = (work: Checkout, onto: string, head: string) =>
  Effect.map(
    hostGit(work.git, ['merge-tree', '--write-tree', '--name-only', '--no-messages', onto, head], { codes: [1] }),
    out => {
      const [tree = '', ...files] = out.toString('utf8').trim().split('\n');
      return { tree, files: files.filter(Boolean) };
    }
  );

/** The most items a fan-out takes when its check sets no `max`; a step fans out over at most this many. */
const most = 20;

class EachFailed extends Data.TaggedError('EachFailed')<{ detail: string }> {}

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
  return Effect.flatMap(sh(script, hub, work.dir, env, minutes), out =>
    out.code === 0 ? Effect.succeed(lines(out.output)) : Effect.fail(new EachFailed({ detail: out.output.trim() }))
  );
};

/** Writes the news since `seen` to the checkout's news file; a failed write logs and keeps the old file. */
const refresh = (run: Run, work: Checkout, seen: Seen, t: Issues) =>
  Effect.tryPromise(() => writeFile(work.news, `${news(t, seen).text || 'Nothing new yet.'}\n`)).pipe(
    Effect.catchAll(e => Effect.logWarning(`news for run ${run.id}`, e))
  );

type Ended = Pick<Extract<Trace, { session: unknown }>['session'], 'ended' | 'exit'>;

const gates = new Map<string, { size: number; gate: Effect.Semaphore }>();

/** The one semaphore every session on a repo starts behind, so containers never exceed `limits.sessions`. */
const gateOf = (hub: Hub) => {
  const size = hub.limits.sessions;
  const kept = gates.get(hub.repo);
  if (kept?.size === size) return kept.gate;
  const gate = Effect.unsafeMakeSemaphore(size);
  gates.set(hub.repo, { size, gate });
  return gate;
};

/**
 * One harness session: what it was opened with, every event and how it ended become trace lines. It holds a session
 * permit only while the harness runs. When `until` ends first, the session is cut short and its result comes back as `cut`.
 */
const converse = <A = never, R = never>(
  hub: Hub,
  run: string,
  step: string,
  spec: SessionSpec,
  item?: string,
  until?: Effect.Effect<A, never, R>,
  aside?: Aside
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
    };
    let end: Ended = { ended: 'stop' };
    const ended = (how: Ended) =>
      store.trace(run, {
        at: now(),
        step,
        session: {
          ...(seen.id !== undefined && { id: seen.id }),
          resumed: !!spec.resume,
          ...(aside && { aside: true as const }),
          ...how,
          usd: seen.usd,
        },
      });
    yield* store.trace(run, {
      at: now(),
      step,
      prompt: spec,
      ...(item !== undefined && { item }),
      ...(aside && { aside }),
    });
    const talked = session.open(spec).pipe(
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
      gateOf(hub).withPermits(1),
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
    yield* ended(end);
    return {
      id: seen.id,
      home: seen.home ?? spec.dir,
      final: seen.final || seen.text,
      usd: seen.usd,
      ...end,
      ...(cut && { cut: cut.a }),
    };
  });

/** A judging session that ends any way but a clean stop with a PASS or FAIL verdict is an infra error, tried once more. */
const verdictOf = (...args: Parameters<typeof converse<never>>) =>
  converse(...args).pipe(
    Effect.filterOrFail(
      j => j.ended === 'stop' && (j.exit ?? 0) === 0 && /^\W*(PASS|FAIL)\b/.test(j.final),
      j =>
        new SessionStop({
          reason: 'provider',
          detail: `session ${j.ended === 'stop' ? 'gave no verdict' : j.ended} (exit ${j.exit ?? 0}), final: ${squeeze(j.final, 200)}`,
        })
    ),
    Effect.retry({ times: 1, while: e => e._tag === 'SessionStop' }),
    Effect.catchTag('SessionStop', e =>
      Effect.fail(
        new SessionStop({
          reason: e.reason,
          detail: `check ${args[3].agent} could not be judged: ${e.detail ?? e.reason}`,
        })
      )
    )
  );

/**
 * What checks read beside the news file, where they cannot write: the pending proposals, the issue as agents see it,
 * the reply and the traces of the runs on the issue.
 */
const checkFiles = (work: Checkout) => ({
  BOTHUB_PROPOSALS: join(dirname(work.news), 'proposals.json'),
  BOTHUB_CONTEXT: join(dirname(work.news), 'context.md'),
  BOTHUB_REPLY: join(dirname(work.news), 'reply.md'),
  BOTHUB_TRACES: join(dirname(work.news), 'traces.md'),
});

/** Whether a run is a retro, a run of a workflow that feedback starts. */
const retro = (hub: Hub, r: Pick<Run, 'workflow'>) => !!hub.workflows[r.workflow]?.on.feedback;

/** Writes the traces of the runs on `issue` that are not retros, oldest first, beside the news file. */
const traced = (hub: Hub, issue: number, work: Checkout) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const runs = (yield* store.list({ issue }))
      .filter(r => !retro(hub, r))
      .sort((a, b) => a.started.localeCompare(b.started));
    const read = yield* Effect.forEach(runs, run =>
      Effect.map(Stream.runCollect(store.read(run.id)), lines => ({ run, lines: Chunk.toArray(lines) }))
    );
    yield* Effect.promise(() => writeFile(checkFiles(work).BOTHUB_TRACES, transcript(issue, read)));
  });

/** The prompt line that points an agent that reads traces at them. */
const tracesAt = (work: Checkout) =>
  `${checkFiles(work).BOTHUB_TRACES} holds the traces of the runs on this issue: per session the prompt, thinking, tool calls and replies, then checks, proposals and moves. Read it in pages and grep it; cite entries by run and line.`;

/** What a try left for its checks: the checkout, the run and its issue, the issue as agents saw it, the reply, the proposals and the human answers so far. */
type Left = Checkout & {
  run: string;
  issue: number;
  context: string;
  reply: string;
  proposals: Proposal[];
  answers?: Run['answers'];
};

/** The human answers of a run as a section every check reads, so a judge does not raise again what an answer settled. */
const heard = (answers: Run['answers'] = []) =>
  answers.length === 0
    ? ''
    : [
        '## What a human answered during this run',
        'A point an answer settles is not a finding.',
        ...answers.map(a => (a.asked ? `Asked: ${squeeze(a.asked, 600)}\n\nAnswered: ${a.said}` : `Said: ${a.said}`)),
      ].join('\n\n');

type Item = {
  item: string | undefined;
  pass: boolean;
  findings: string;
  exit?: number;
};

/** The judge prompts that passed per data dir, run, check and diff; the same prompt on the same diff is not judged again. */
const passes = new WeakMap<object, Set<string>>();

/** One check over what a try left: its items, the command per item, then the agent that judges. Per-item results are traced; judging sessions' cost comes back as `usd`. */
const resultOf = (step: Step, check: Doc<Check>, work: Left, hub: Hub) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const passed = passes.get(store) ?? new Set<string>();
    passes.set(store, passed);
    const run = work.run;
    const started = Date.now();
    const minutes = hub.limits.minutes;
    const base = {
      BOTHUB_BASE: work.base,
      BOTHUB_ISSUE: String(work.issue),
      ...checkFiles(work),
    };
    const all: Effect.Effect<(string | undefined)[], EachFailed | SandboxError, Sandbox> = check.each
      ? itemsOf(check.each, hub.dir, work, minutes, base)
      : Effect.succeed([undefined]);
    const listed = yield* all.pipe(Effect.catchTag('EachFailed', e => Effect.succeed(e)));
    const items: (string | undefined)[] = listed instanceof EachFailed ? [] : listed;
    const diff = check.agent ? yield* diffOf(work) : '';
    let usd = 0;
    const one = (item: string | undefined) =>
      Effect.gen(function* () {
        const env = {
          ...base,
          ...(item !== undefined && { BOTHUB_ITEM: item }),
        };
        const out = check.run ? yield* sh(check.run, hub.dir, work.dir, env, minutes) : undefined;
        if (out?.code === 127)
          return yield* new SandboxError({
            reason: 'infra',
            detail: `${check.name}: command not found: ${squeeze(out.output, 400)}`,
          });
        const exit = out && { exit: out.code };
        if (!check.agent)
          return {
            item,
            pass: (out?.code ?? 0) === 0,
            findings: out?.output ?? '',
            ...exit,
          };
        const agent = hub.agents[check.agent]!;
        const input = out?.output ?? item ?? diff;
        const prompt = [
          check.body,
          input,
          heard(work.answers),
          agent.reads && tracesAt(work),
          'Reply PASS or FAIL first, then why.',
        ]
          .filter(Boolean)
          .join('\n\n');
        const key = createHash('sha256')
          .update([run, check.name, check.agent, agent.model, prompt, diff].join('\0'))
          .digest('hex');
        if (!agent.reads && passed.has(key)) return { item, pass: true, findings: '', ...exit };
        const judged = yield* verdictOf(
          hub,
          run,
          step.name,
          {
            harness: agent.harness,
            agent: check.agent,
            minutes: hub.limits.minutes,
            ...(agent.model !== undefined && { model: agent.model }),
            system: agent.body,
            prompt,
            dir: work.dir,
            tools: agent.tools,
            ...(agent.reads && { read: [dirname(work.news)] }),
          },
          item
        ).pipe(
          Effect.catchTag('SessionStop', e =>
            check.mode !== 'warn' || e.reason === 'human' ? Effect.fail(e) : Effect.succeed(e)
          )
        );
        if (judged instanceof SessionStop)
          return {
            item,
            pass: false,
            findings: judged.detail ?? judged.reason,
            ...exit,
          };
        usd += judged.usd;
        const pass = /^\W*PASS\b/.test(judged.final);
        if (pass) passed.add(key);
        return { item, pass, findings: judged.final, ...exit };
      });
    const max = check.max ?? most;
    const over = items.length > max;
    const results: Item[] =
      listed instanceof EachFailed
        ? [
            {
              item: undefined,
              pass: false,
              findings: `each failed: ${listed.detail}`,
            },
          ]
        : over
          ? [
              {
                item: undefined,
                pass: false,
                findings: `${items.length} items, more than ${max}`,
              },
            ]
          : yield* Effect.forEach(items, one, { concurrency: 'unbounded' });
    const failing = results.filter(r => !r.pass);
    const empty = check.each !== undefined && items.length === 0 && !(listed instanceof EachFailed);
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
          check: {
            check: check.name,
            pass: r.pass,
            ...(!r.pass && { findings: squeeze(r.findings) }),
            ms: 0,
          },
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
    const returns = 'agent' in step.does ? (hub.agents[step.does.agent]?.returns ?? []) : [];
    /** The first session of a run a comment started, which may answer that comment. */
    const asked = returns.includes('comment') && run.said !== undefined && Object.keys(run.sessions).length === 0;
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
    const command = commandOf(hub);
    /** Refreshes the news file every minute and ends with what a human said that cuts the try short. */
    const watch = (by: Run, seen: Seen) =>
      Effect.gen(function* () {
        for (;;) {
          yield* Effect.sleep('1 minute');
          const now = yield* Effect.either(issuesOf(w, run));
          if (Either.isLeft(now)) {
            yield* Effect.logWarning(`news for run ${run.id}`, now.left);
            continue;
          }
          yield* refresh(run, work, seen, now.right);
          const cut = told(w, by, now.right, command);
          if (cut && (cut.outcome.kind !== 'answer' || w.concurrency === 'cancel')) return cut;
        }
      });
    const t = yield* issuesOf(w, run);
    /** On a retry, the files before it: a retry that changes none cannot pass checks that failed on them. */
    const before = run.tries > 0 && step.checks.length > 0 ? yield* treeOf(work) : undefined;
    /** Whether the work a comment-only reply answers exists: no branch, a pull request, or a finished run. */
    const held =
      w.branch === undefined ||
      t.issue.pull !== undefined ||
      t.pull !== undefined ||
      (yield* store.list({ issue: run.issue })).some(r => r.workflow === w.name && r.status === 'done');
    const answering = asked && held;
    if ('run' in step.does) {
      const started = Date.now();
      const out = yield* sh(step.does.run, hub.dir, work.dir, { BOTHUB_BASE: work.base }, minutes);
      const result: CheckResult = {
        check: step.name,
        pass: out.code === 0,
        ...(out.code !== 0 && { findings: squeeze(out.output) }),
        ms: Date.now() - started,
      };
      yield* store.trace(run.id, {
        at: now(),
        step: step.name,
        check: result,
        exit: out.code,
      });
      if (!result.pass)
        return done({
          kind: 'failed',
          checks: [result],
          proposals: [],
          problems: [],
        });
      replies.push(out.output);
    } else {
      const name = step.does.agent;
      const agent = hub.agents[name]!;
      const issue = t.issue;
      const kept = step.each === undefined ? run.sessions[step.name] : undefined;
      const reads = agent.tools.includes('read');
      const kinds = [...agent.returns.filter(k => k !== 'ask' && k !== 'back'), 'ask', ...(step.back ? ['back'] : [])];
      /** A step that judges the change, and does not fan out over it, opens on the whole of it. */
      const diff = step.back && !step.each && !kept ? yield* diffOf(work) : '';
      if (agent.reads) yield* traced(hub, run.issue, work);
      const prompt = [
        ...[step.does.skill, ...(hub.skills[step.does.skill ?? '']?.uses ?? [])].map(s => s && hub.skills[s]?.body),
        w.body,
        context(t),
        diff && `## The change on the branch\n\n\`\`\`\`diff\n${squeeze(diff, 20_000)}\n\`\`\`\``,
        w.branch &&
          `Work on the branch ${expand(w.branch, issue)}; pull requests go into ${run.base?.branch ?? issue.pull?.base ?? expand(w.base ?? 'main', issue)}.`,
        step.back?.until && `Propose back with a reason while this does not hold: ${step.back.until}`,
        step.checks.length > 0 &&
          `When you stop, the runner checks the change: ${step.checks
            .map(n => (hub.checks[n]?.run ? `${n} runs \`${hub.checks[n].run}\`` : n))
            .join(', ')}.`,
        answering &&
          'A comment started this run. When it does not ask for work, answer it with comment proposals only; that ends the run.',
        reads &&
          `People may comment while you work: ${work.news} holds what is new, refreshed every minute. Read it before you finish.`,
        agent.reads && tracesAt(work),
        agent.returns.includes('issue') && (yield* filed()),
        run.feedback,
        [
          'End your reply with a fenced bothub block holding a JSON array of proposals. The runner commits, pushes,',
          'opens pull requests and posts comments from them, so do not run git or gh yourself. The shape of each kind:',
          ...kinds.map(k => shapes[k as keyof typeof shapes]),
        ].join('\n'),
      ]
        .filter(Boolean)
        .join('\n\n');
      const listed: (string | undefined)[] = step.each
        ? yield* itemsOf(step.each, hub.dir, work, minutes).pipe(
            Effect.catchTag('EachFailed', e =>
              Effect.fail(
                new SandboxError({
                  reason: 'infra',
                  detail: `each failed: ${e.detail}`,
                })
              )
            )
          )
        : [undefined];
      const items = listed.length > most ? [listed.join('\n\n')] : listed;
      const caught = news(t, kept ? (kept.seen ?? { at: run.started }) : { at: '' });
      tried = { ...tried, seen: newest(run.seen, run.started, lastHeard(t))! };
      const talk = (prompt: string, seen: Seen, resume?: Run['sessions'][string], item?: string) =>
        Effect.gen(function* () {
          const r = yield* converse(
            hub,
            run.id,
            step.name,
            {
              harness: agent.harness,
              agent: name,
              minutes,
              ...(agent.model !== undefined && { model: agent.model }),
              system: agent.body,
              prompt,
              dir: work.dir,
              tools: agent.tools,
              ...(reads && { read: [dirname(work.news)] }),
              ...(resume && { resume }),
            },
            item,
            watch(tried, seen)
          );
          tried = {
            ...tried,
            usd: tried.usd + r.usd,
            ...(step.each === undefined &&
              r.id !== undefined && {
                sessions: { ...tried.sessions, [step.name]: { id: r.id, home: r.home, seen } },
              }),
          };
          return r;
        });
      for (const item of items) {
        yield* refresh(run, work, caught.seen, t);
        const r = yield* talk(
          kept
            ? [run.feedback ?? 'Continue.', caught.text].filter(Boolean).join('\n\n')
            : item === undefined
              ? prompt
              : `${prompt}\n\n## Item\n\n${item}`,
          caught.seen,
          kept,
          item
        );
        if (r.cut) return done(r.cut.outcome, { ...tried, seen: r.cut.at });
        replies.push(r.final);
      }
      const session = step.each === undefined ? tried.sessions[step.name] : undefined;
      const now = session && Option.getOrUndefined(yield* Effect.option(issuesOf(w, run)));
      const late = now && told(w, tried, now, command);
      if (late && late.outcome.kind !== 'answer') return done(late.outcome, { ...tried, seen: late.at });
      if (now && late && w.concurrency === 'steer') {
        const since = news(now, caught.seen);
        const r = yield* talk(
          `${since.text}\n\nTake this into account, then end your reply with the whole bothub block again.`,
          since.seen,
          session
        );
        if (r.cut) return done(r.cut.outcome, { ...tried, seen: r.cut.at });
        replies.splice(0, replies.length, r.final);
        tried = { ...tried, seen: newest(tried.seen, late.at, lastHeard(now))! };
      }
    }

    const parsed = replies.map(reply => proposalsOf(reply, !('run' in step.does)));
    const proposals = parsed.flatMap(p => p.proposals);
    const problems = parsed.flatMap(p => p.problems);
    const marked = proposals.some(p => p.kind === 'push') ? markedIn(yield* diffOf(work)) : [];
    if (marked.length > 0) problems.push(`conflict markers left in ${marked.join(', ')}`);
    const ask = proposals.find(p => p.kind === 'ask');
    if (ask) return done({ kind: 'ask', question: ask.question }, tried);
    const back = proposals.find(p => p.kind === 'back');
    const world = proposals
      .filter(p => p.kind !== 'ask' && p.kind !== 'back')
      .map((p): Proposal => {
        if (p.kind === 'push' && run.onto) return { ...p, onto: run.onto.sha, ...(run.onto.merge && { merge: true }) };
        if (p.kind !== 'pull_request') return p;
        const body = p.body.replace(/^Stacks on #\d+\.?[ \t]*/gim, '').trim();
        return run.base
          ? {
              ...p,
              base: run.base.branch,
              body: `${body}\n\nStacks on #${run.base.pull}`,
            }
          : { ...p, body };
      });

    const commented = !back && world.length > 0 && world.every(p => p.kind === 'comment');
    const edited = commented && asked && (yield* hostGit(work.git, ['status', '--porcelain'])).length > 0;
    const answered = commented && answering && !edited;
    if (asked && commented && (edited || !held) && (returns.includes('push') || returns.includes('pull_request')))
      return done(
        {
          kind: 'failed',
          checks: [],
          proposals: [],
          problems: [
            edited
              ? 'files changed but nothing was pushed: push them with a pull request, or ask'
              : 'a pass needs a pull request or an ask',
          ],
        },
        tried
      );
    const checked = answered
      ? { outcome: { kind: 'pass' } as const, usd: 0 }
      : yield* Effect.raceFirst(
          gate(
            step,
            {
              run: run.id,
              ...work,
              issue: run.issue,
              context: context(t),
              reply: replies.join('\n\n'),
              proposals: world,
              ...(run.answers && { answers: run.answers }),
            },
            hub
          ),
          Effect.map(watch(tried, { at: tried.seen ?? run.started }), cut => ({ cut }))
        );
    if ('cut' in checked) return done(checked.cut.outcome, { ...tried, seen: checked.cut.at });
    const { outcome: gated, usd } = checked;
    tried = { ...tried, usd: tried.usd + usd };
    if (
      gated.kind === 'failed' &&
      gated.checks.length > 0 &&
      before !== undefined &&
      before === (yield* treeOf(work))
    ) {
      const said = world.flatMap(p => (p.kind === 'comment' ? [p.body] : []));
      return done({ kind: 'ask', question: [...said, failure(gated)].join('\n\n') }, tried);
    }
    if (gated.kind === 'failed' || (gated.kind === 'pass' && problems.length > 0))
      return done(
        gated.kind === 'failed'
          ? { ...gated, problems: [...gated.problems, ...problems] }
          : { kind: 'failed', checks: [], proposals: [], problems },
        tried
      );
    if (gated.kind !== 'pass') return done(gated, tried);
    if (back) return done({ kind: 'back', why: back.why }, tried);

    const to = world.some(p => p.kind === 'comment' && (!run.said || p.under !== undefined))
      ? pullOf(w, run.issue, yield* Effect.flatMap(Forge, f => f.issues({ state: 'open' })))
      : undefined;
    const runs = world.filter(p => p.kind === 'run');
    const refused = yield* undispatchable(hub, run, runs);
    if (refused.length > 0) return done({ kind: 'failed', checks: [], proposals: refused, problems: [] }, tried);
    const children = world.filter((p): p is Child => p.kind === 'issue');
    const rest = world.filter(p => p.kind !== 'issue' && p.kind !== 'run');
    const landed = yield* Effect.either(
      Effect.zipWith(land(tried, rest, work, to), file(w, tried, children), (a, b) => [...a, ...b])
    );
    if (Either.isLeft(landed) && landed.left._tag === 'StoreError') return yield* landed.left;
    if (Either.isLeft(landed))
      return done(
        {
          kind: 'ask',
          question: `GitHub failed: ${squeeze(landed.left.message, 200)}`,
        },
        tried
      );
    const failed = landed.right.filter(a => !a.ok);
    if (tried.onto && landed.right.some(a => a.ok && a.proposal.kind === 'push')) {
      const { onto: _landed, ...rest } = tried;
      tried = rest;
    }
    const child = runs[0] && !failed.length ? yield* dispatch(hub, tried, runs[0]) : undefined;
    const applied = [...landed.right, ...(child ? [{ proposal: runs[0]!, ok: true, id: child.id }] : [])];
    yield* store.trace(run.id, ...applied.map(a => ({ at: now(), step: step.name, applied: a })));
    return done(
      failed.length
        ? { kind: 'failed', checks: [], proposals: failed, problems: [] }
        : child
          ? { kind: 'ask', question: waitingOn(child) }
          : { kind: 'pass', ...(answered && { answered: true as const }) },
      tried
    );
  });

/** The step's checks over what a try left behind, all at once, so every finding of a try comes back together. `usd` is what the agent checks cost. */
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
        writeFile(files.BOTHUB_CONTEXT, [left.context, heard(left.answers)].filter(Boolean).join('\n\n')),
        writeFile(files.BOTHUB_REPLY, left.reply),
      ])
    );
    if (checks.length > 0) yield* traced(hub, left.issue, left);
    const settled = yield* Effect.forEach(checks, c => Effect.either(resultOf(step, c, left, hub)), {
      concurrency: 'unbounded',
    });
    const results = settled.flatMap(r => (Either.isRight(r) ? [r.right] : []));
    const usd = results.reduce((sum, r) => sum + r.usd, 0);
    const all = results.map(r => r.result);
    const failed = (mode: Check['mode']) =>
      all.filter(v => !v.pass && checks.find(c => c.name === v.check)?.mode === mode);

    const stops = failed('stop');
    if (stops.length > 0)
      return {
        outcome: {
          kind: 'stop',
          why: stops.map(v => `${v.check}: ${v.findings ?? 'failed'}`).join('\n'),
        },
        usd,
      };
    const error = settled.find(Either.isLeft);
    if (error) return yield* error.left;
    const returns = 'agent' in step.does ? hub.agents[step.does.agent]?.returns : undefined;
    const marks = Object.values(hub.workflows).flatMap(w => w.on.issues?.label ?? []);
    const refusal = (p: Proposal) =>
      returns && !returns.some(k => k === p.kind)
        ? `${step.name} may not propose ${p.kind}`
        : p.kind === 'label' && p.add?.some(l => marks.includes(l))
          ? `only a human adds ${p.add.filter(l => marks.includes(l)).join(', ')}`
          : undefined;
    const proposals: Applied[] = left.proposals.flatMap(p => {
      const reason = refusal(p);
      return reason === undefined ? [] : [{ proposal: p, ok: false, reason }];
    });
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
const show = (w: Workflow, run: Run): Effect.Effect<Run, StoreError, Forge | Store> =>
  Effect.gen(function* () {
    if (w.on.feedback) return run;
    const forge = yield* Forge;
    const t = yield* issuesOf(w, run);
    const status = yield* Effect.forEach(shown(run, w, t), p => forge.apply(run.issue, p));
    const reply = status.find(a => a.proposal.kind === 'comment');
    const undone = reply?.ok && run.eyes ? [yield* forge.apply(run.eyes.issue, run.eyes.undo)] : [];
    yield* Effect.flatMap(Store, s =>
      s.trace(
        run.id,
        ...[...status, ...undone].map(a => ({
          at: now(),
          step: run.step,
          applied: a,
        }))
      )
    );
    if (!reply) return run;
    const { comment: _gone, eyes, ...rest } = run;
    return {
      ...rest,
      ...(eyes && !undone.length && { eyes }),
      ...(reply.ok && reply.id && { comment: reply.id }),
    };
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
          ? forge.apply(p.under === undefined ? (run.said?.issue ?? to ?? run.issue) : (to ?? run.issue), {
              ...p,
              ...(p.under === undefined && run.said?.under && { under: run.said.under }),
            })
          : forge.apply(run.issue, p, work)
    )
  );

/**
 * Runs the hub's setup, then tries until the run stops running. A runner error is retried once on the next tick, then parks the run at its step, so an
 * answer tries that step again with the feedback it had. Files are kept under `refs/bothub/runs/<run id>`.
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
          run: {
            step: next.step,
            status: next.status,
            tries: next.tries,
            rounds: next.rounds,
          },
        });
        const child = (yield* store.list()).some(r => r.by === next.id && next.reason === waitingOn(r));
        if (next.status === 'waiting' && next.reason && !child) {
          const elsewhere = next.said && next.said.issue !== next.issue;
          const body = elsewhere ? `${next.reason}\n\n${footer(answerWith)}` : next.reason;
          const said = yield* Effect.either(land(next, [{ kind: 'comment', body }]));
          if (Either.isRight(said))
            yield* store.trace(
              next.id,
              ...said.right.map(applied => ({
                at: now(),
                step: next.step,
                applied,
              }))
            );
        }
        current = yield* show(w, next);
        yield* store.put(current);
      });
    const walk = Effect.gen(function* () {
      yield* store.lock(run.id);
      const issue = yield* forge.issue(run.issue);
      current = yield* show(w, {
        ...current,
        title: issue.title,
        body: issue.body,
        hub: hub.sha,
      });
      yield* store.put(current);
      const stacked = hub.stacks && !current.base && stackOf(w, issue, yield* forge.issues({ state: 'open' }));
      if (stacked) yield* store.put((current = { ...current, base: stacked }));
      const own = w.branch && expand(w.branch, issue);
      const ref =
        (own && issue.pull?.branch === own && issue.pull.base) ||
        (issue.pull?.branch ?? current.base?.branch ?? expand(w.base ?? 'main', issue));
      const made = yield* Effect.flatMap(Sandbox, s => s.checkout(ref, own, `refs/bothub/runs/${run.id}`, hub));
      const work = current.onto ? yield* following(made, current.onto.sha, current.tries === 0) : made;
      if (!w.on.feedback) yield* setUp(hub, work);
      while (current.status === 'running') {
        const tried = yield* attempt(w, current, hub, work);
        yield* settle(tried.outcome, transition(w, tried.run, tried.outcome));
        if (current.status === 'running' && current.usd > hub.limits.usdPerRun) {
          const why = `Spent $${current.usd.toFixed(2)}, over the hub's usd-per-run of ${hub.limits.usdPerRun}.`;
          yield* settle({ kind: 'stop', why }, transition(w, current, { kind: 'stop', why }));
        }
        const t = live(current) ? yield* Effect.option(issuesOf(w, current)) : Option.none();
        const queued = Option.isSome(t) ? told(w, current, t.value, commandOf(hub)) : undefined;
        if (queued) yield* settle(queued.outcome, { ...transition(w, current, queued.outcome), seen: queued.at });
      }
    });
    const halt = (e: SandboxError | SessionStop | ForgeError) => {
      const why = `${e._tag}: ${'detail' in e ? (e.detail ?? e.reason) : e.message}`;
      const said = `Stopped by a runner error (${e._tag}). The details are in the trace of run ${current.id}.`;
      if (e._tag === 'SessionStop' && e.reason === 'human')
        return settle({ kind: 'stop', why }, transition(w, current, { kind: 'stop', why: said }));
      if (!current.retried) return settle({ kind: 'ask', question: why }, { ...current, retried: true });
      const question = `${said} Reply to try ${current.step} again from where it was.`;
      const { said: heard, ...kept } = current;
      return settle(
        { kind: 'ask', question: why },
        { ...kept, status: 'waiting', reason: question, retried: true, ...(heard && { said: { issue: heard.issue } }) }
      );
    };
    yield* walk.pipe(
      Effect.scoped,
      Effect.catchTags({
        SandboxError: halt,
        SessionStop: halt,
        ForgeError: halt,
      })
    );
    return current;
  });

/** A checkout measured from `onto`; on a first try its files become the branch merged onto it, conflicts marked. */
const following = (work: Checkout, onto: string, first: boolean) =>
  Effect.gen(function* () {
    if (first && work.head)
      yield* hostGit(work.git, ['read-tree', '-u', '--reset', (yield* mergeOf(work, onto, work.head)).tree]);
    return { ...work, base: onto };
  });

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
    yield* store.trace(
      run.id,
      ...[applied, ...said].map(a => ({
        at: now(),
        step: run.step,
        applied: a,
      }))
    );
    yield* store.put({ ...run, base: { ...base, sha: head } });
  }).pipe(Effect.scoped);

/**
 * Brings a run waiting on a human up to what is current: the head of its pull request's base, and the hub. A branch
 * behind its base follows it with no model, by a merge or a rebase as the step's `follow` says. When the change stays
 * the same, the step's own checks run again, scripts first and judged ones only once those pass; a changed change or a
 * new hub runs every check of the step it goes back to. A failed check sends the run back as a request for changes
 * would. A conflict sends it back too, to start on the new base with markers left; when that already happened for
 * this base head, it is said on the issue once. Undefined when nothing moved.
 */
const catchUp = (w: Workflow, run: Run, hub: Hub, pull: NonNullable<Issue['pull']>) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const forge = yield* Forge;
    const step = w.steps.find(s => s.name === run.step)!;
    const to = w.steps.find(s => s.name === step.back?.to);
    yield* store.lock(run.id);
    const made = yield* Effect.flatMap(Sandbox, s => s.checkout(pull.base, undefined, undefined, hub));
    const work = { ...made, head: pull.head };
    const onto = work.base;
    const from = yield* text(work, ['merge-base', pull.head, onto]);
    const moved = !run.base && from !== onto;
    const renewed = (run.hub ?? hub.sha) !== hub.sha;
    const current = { ...run, hub: hub.sha };
    if (!moved && !renewed) return run.hub ? undefined : { run: current };
    let same = false;
    if (moved) {
      const merge = step.follow !== 'rebase';
      const branch = pull.branch;
      const verb = merge ? 'merges with' : 'rebases onto';
      const proposal: Proposal = merge
        ? { kind: 'push', branch, message: `Merge ${pull.base} into ${branch}`, onto, merge: true }
        : { kind: 'rebase', branch, from, onto };
      const tried = Chunk.size(
        Chunk.filter(
          yield* Stream.runCollect(store.read(run.id)),
          t => 'applied' in t && !t.applied.ok && 'onto' in t.applied.proposal && t.applied.proposal.onto === onto
        )
      );
      if (tried >= (to ? 2 : 1)) return { run: current };
      const { tree, files } = yield* mergeOf(work, onto, pull.head);
      if (merge && files.length === 0) yield* hostGit(work.git, ['read-tree', '-u', '--reset', tree]);
      const applied: Applied =
        files.length > 0
          ? { proposal, ok: false, reason: `conflicts in ${files.join(', ')}` }
          : yield* forge.apply(run.issue, proposal, work);
      yield* store.trace(run.id, { at: now(), step: run.step, applied });
      if (!applied.ok && tried === 0 && to) {
        const why = [
          `${branch} no longer ${verb} ${pull.base} at ${onto.slice(0, 7)}: ${applied.reason}.`,
          `The work tree now starts on ${pull.base} with this change applied and conflict markers left where they clash.`,
          'Resolve each conflict so both sides keep working, remove every marker, and push.',
        ].join(' ');
        const following = { ...current, onto: { sha: onto, ...(merge && { merge: true as const }) } };
        return { run: following, outcome: { kind: 'back', why } as const };
      }
      if (!applied.ok) {
        const body = `${branch} no longer ${verb} ${pull.base}: ${applied.reason}. Update it by hand.`;
        const said = yield* land(run, [{ kind: 'comment', body }]);
        yield* store.trace(run.id, ...said.map(a => ({ at: now(), step: run.step, applied: a })));
        return { run: current };
      }
      const patch = (diff: Buffer) =>
        Effect.map(
          hostGit(work.git, ['patch-id', '--stable'], { input: diff.toString('utf8') }),
          out => out.toString('utf8').split(' ')[0]
        );
      const before = yield* patch(yield* hostGit(work.git, ['diff', from, pull.head]));
      const after = yield* patch(yield* hostGit(work.git, ['diff', onto, yield* treeOf(work)]));
      same = before === after;
    } else yield* hostGit(work.git, ['read-tree', '-u', '--reset', pull.head]);
    if (!to) return { run: current };
    yield* setUp(hub, work);
    const t = yield* issuesOf(w, run);
    const left = {
      run: run.id,
      ...work,
      issue: run.issue,
      context: context(t),
      reply: '',
      proposals: [],
      answers: run.answers,
    };
    const own = same && !renewed;
    const judged = (name: string) => hub.checks[name]?.agent !== undefined;
    const scripts = step.checks.filter(c => !judged(c));
    const later = own ? step.checks.filter(judged) : [];
    let { outcome, usd } = yield* gate(own ? { ...step, checks: scripts } : to, left, hub);
    if (outcome.kind === 'pass' && later.length > 0) {
      const log = yield* text(work, ['log', '--oneline', '--no-decorate', `${from}..${onto}`]);
      const stat = yield* text(work, ['diff', '--stat', from, onto]);
      const reply = [
        `The base ${pull.base} moved from ${from.slice(0, 7)} to ${onto.slice(0, 7)}; the change stays the same.`,
        log,
        stat,
        scripts.length > 0 && `These checks passed on the updated branch: ${scripts.join(', ')}.`,
      ]
        .filter(Boolean)
        .join('\n\n');
      const second = yield* gate({ ...step, checks: later }, { ...left, reply }, hub);
      outcome = second.outcome;
      usd += second.usd;
    }
    const checked = { ...current, usd: run.usd + usd };
    return outcome.kind === 'failed'
      ? { run: checked, outcome: { kind: 'back', why: failure(outcome) } as const }
      : outcome.kind === 'pass'
        ? { run: checked }
        : { run: checked, outcome };
  }).pipe(Effect.scoped);

/**
 * Answers what a human said to a run waiting at a human step: a fork of the session of the step it goes back to, in a
 * throwaway checkout of the pull request head. Its comments land under the thread and the run keeps waiting; a `back`
 * comes back as the outcome, with the fork as that step's session.
 */
const aside = (w: Workflow, run: Run, hub: Hub, said: string, pull: NonNullable<Issue['pull']>) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const forge = yield* Forge;
    const step = w.steps.find(s => s.name === run.step)!;
    const to = w.steps.find(s => s.name === step.back?.to);
    if (!to || !('agent' in to.does)) return { run };
    yield* store.lock(run.id);
    const agent = hub.agents[to.does.agent]!;
    const kept = run.sessions[to.name];
    const work = yield* Effect.flatMap(Sandbox, s => s.checkout(pull.branch, undefined, undefined, hub));
    const prompt = [
      !kept && [w.body, context(yield* issuesOf(w, run))].join('\n\n'),
      `A human said this on the pull request while it waits at ${step.name}:\n\n${said}`,
      'This checkout is the pull request head; anything you change here is thrown away.',
      'Answer with a comment. When it asks for a change, or you find one is needed, also propose back with why.',
      `End your reply with a fenced bothub block holding a JSON array of proposals:\n${shapes.comment}\n${shapes.back}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const r = yield* converse(
      hub,
      run.id,
      step.name,
      {
        harness: agent.harness,
        agent: to.does.agent,
        minutes: hub.limits.minutes,
        ...(agent.model !== undefined && { model: agent.model }),
        system: agent.body,
        prompt,
        dir: work.dir,
        tools: agent.tools,
        ...(kept && { resume: kept, fork: true as const }),
      },
      undefined,
      undefined,
      {
        ...(run.eyes && { issue: run.eyes.issue }),
        ...(run.eyes?.undo.comment !== undefined && { comment: run.eyes.undo.comment }),
        ...(run.eyes?.undo.review && { review: true as const }),
      }
    );
    const { proposals } = proposalsOf(r.final, false);
    const back = proposals.find(p => p.kind === 'back');
    const landed = yield* land(
      run,
      proposals.filter(p => p.kind === 'comment')
    );
    const undone = landed.some(a => a.ok) && run.eyes ? [yield* forge.apply(run.eyes.issue, run.eyes.undo)] : [];
    yield* store.trace(run.id, ...[...landed, ...undone].map(applied => ({ at: now(), step: step.name, applied })));
    const { eyes, ...rest } = run;
    const answered = { ...rest, ...(eyes && !undone.length && { eyes }), usd: run.usd + r.usd };
    if (!back || r.id === undefined) return { run: answered };
    const sessions = { ...run.sessions, [to.name]: { id: r.id, home: r.home, ...(kept?.seen && { seen: kept.seen }) } };
    return { run: { ...answered, sessions }, outcome: { kind: 'back', why: back.why } as const };
  }).pipe(Effect.scoped);

/** How long an issue must be quiet before what people did there starts or wakes a run, so a burst counts once. */
export const settle = 30_000;

/**
 * One look at the repo: reenter live runs, begin new ones on a trusted command or label, drive up to `limits.parallel`.
 * With `only`, it looks at that issue alone and begins a run there when none was live; with `marked` too, only on a
 * trusted command or label. An issue with a trusted event younger than `quiet` ms is left for a later look.
 */
export const tick = (
  hub: Hub,
  only?: number,
  marked = false,
  quiet = 0
): Effect.Effect<Run[], ForgeError | StoreError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const forge = yield* Forge;
    const mine = (r: { issue: number }) => only === undefined || r.issue === only;
    const all = yield* store.list();
    const runs = all.filter(mine).filter(r => !retro(hub, r));
    const waiting = yield* Effect.forEach(runs.filter(live), r =>
      Effect.map(Stream.runLast(Stream.filter(store.read(r.id), t => 'outcome' in t)), last => ({
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
      return {
        issue: origin.get(m) ?? m.issue,
        ...(c?.path !== undefined && { under: c.under ?? c.id }),
      };
    };
    /** 👀 on the comment that woke a run, or on its issue for a label; the run comes back holding it. */
    const eyes = (run: Run, m: Event): Effect.Effect<Run, StoreError> => {
      if (m.kind !== 'comment' && m.kind !== 'label') return Effect.succeed(run);
      const issue = origin.get(m) ?? m.issue;
      const react: Extract<Proposal, { kind: 'react' }> = {
        kind: 'react',
        ...(m.kind === 'comment' &&
          m.comment && {
            comment: m.comment.id,
            ...(m.comment.path !== undefined && { review: true }),
          }),
      };
      return forge.apply(issue, react).pipe(
        Effect.tap(applied => store.trace(run.id, { at: now(), step: run.step, applied })),
        Effect.map(a => (a.ok && a.id ? { ...run, eyes: { issue, undo: { ...react, remove: a.id } } } : run)),
        Effect.catchTag('ForgeError', e => Effect.as(Effect.logWarning(`react for run ${run.id}`, e), run))
      );
    };
    const triggered = Object.values(hub.workflows).filter(w => w.on.issue_comment?.command);
    const command = commandOf(hub);
    /** A trusted comment on a thread the bot has a run on speaks to the bot, unless it mentions someone else. */
    const spoken = (m: Event): Event => {
      if (!runs.some(r => r.issue === m.issue)) return m;
      const said = addressed(m, command);
      if (origin.has(m)) origin.set(said, origin.get(m)!);
      return said;
    };
    /** Whether a trusted event on the issue is younger than `quiet`, so a burst still coming starts nothing yet. */
    const young = (issue: number) =>
      quiet > 0 && latest.some(m => m.issue === issue && m.trusted && Date.now() - Date.parse(m.at) < quiet);
    const events = latest.map(onRun).map(spoken).filter(mine);
    const used = new Set<Event>();
    const touched: Run[] = [];
    /** Moves a live run outside a session: traces the outcome and saves where it led. */
    const record = (run: Run, outcome: Outcome, next: Run) =>
      Effect.gen(function* () {
        yield* store.trace(run.id, {
          at: now(),
          step: run.step,
          outcome,
          run: {
            step: next.step,
            status: next.status,
            tries: next.tries,
            rounds: next.rounds,
          },
        });
        yield* store.put(next);
        touched.push(next);
      });
    waiting.sort((a, b) => b.run.started.localeCompare(a.run.started));
    for (const { run, at } of waiting) {
      const w = hub.workflows[run.workflow];
      /** A working run takes only a stop here; what else people say reaches it where it works. */
      const taken = (m: Event, lined: Event[] = []) => {
        const o = w && reenter(w, run, m, command, lined);
        return o && (run.status !== 'running' || o.kind === 'stop') ? o : undefined;
      };
      const answers =
        w && !young(run.issue)
          ? events.filter(m => m.issue === run.issue && m.at > at && !used.has(m) && taken(m))
          : [];
      const m = answers.find(m => m.kind === 'merged') ?? answers[0];
      if (!w || !m) continue;
      for (const a of answers) used.add(a);
      const lined = events.filter(
        l => l.issue === run.issue && l.kind === 'comment' && l.comment?.path && l.at > at && l.at <= m.at
      );
      const outcome = fold([m, ...answers.filter(a => a !== m)].map(a => taken(a, a === m ? lined : [])!))!;
      const seen = { ...(m.kind === 'comment' ? yield* eyes(run, m) : run), said: heard(m) };
      const step = w.steps.find(s => s.name === run.step);
      const pull = issues.find(t => t.number === pullOf(w, run.issue, issues))?.pull;
      const asked: { run: Run; outcome?: Outcome; again?: boolean } | undefined =
        outcome.kind !== 'answer' || !step || !waits(step)
          ? undefined
          : !pull
            ? { run: seen, outcome: { kind: 'back', why: outcome.text } }
            : yield* aside(w, seen, hub, outcome.text, pull).pipe(
                Effect.catchAll(e =>
                  Effect.gen(function* () {
                    yield* Effect.logError(`aside of run ${run.id}`, e);
                    if (!run.retried)
                      return { run: { ...run, ...(seen.eyes && { eyes: seen.eyes }), retried: true as const }, again: true };
                    const body = `Could not answer: ${(e as { _tag?: string })._tag ?? 'Error'}. Reply again to retry.`;
                    yield* land(seen, [{ kind: 'comment', body }]).pipe(Effect.catchAll(() => Effect.void));
                    const { retried: _retried, ...rest } = seen;
                    return { run: rest, again: false };
                  })
                )
              );
      if (asked?.again) {
        yield* store.put(asked.run);
        continue;
      }
      const moved = {
        ...transition(w, asked?.run ?? seen, asked?.outcome ?? outcome),
        seen: newest(...answers.map(a => a.at))!,
      };
      const next = moved.status === 'running' ? moved : yield* show(w, moved);
      yield* record(run, outcome, next);
    }
    for (const parent of runs.filter(r => r.status === 'waiting' && !touched.some(t => t.id === r.id))) {
      const w = hub.workflows[parent.workflow];
      const child = all.find(c => c.by === parent.id && parent.reason === waitingOn(c) && c.status !== 'running');
      if (!w || !child) continue;
      const outcome: Outcome = { kind: 'answer', text: settled(child) };
      yield* record(parent, outcome, transition(w, parent, outcome));
    }

    const busy = new Set(
      runs
        .map(r => touched.find(t => t.id === r.id) ?? r)
        .filter(live)
        .map(r => `${r.workflow}#${r.issue}`)
    );
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
    /** Begins `w` on `issue`. A restart begins at the step it names, else the first, with the answers of the last run there. */
    const start = (w: Workflow, issue: number, at: string, m?: Event, restart?: string) =>
      Effect.gen(function* () {
        const last = all
          .filter(r => r.issue === issue && r.workflow === w.name)
          .sort((a, b) => a.started.localeCompare(b.started))
          .at(-1);
        const step = w.steps.find(s => s.name === restart);
        const begun = {
          ...begin(w, { id: `${w.name}-${issue}-${at.replace(/\D/g, '')}`, issue, started: at }, step),
          ...(m?.kind === 'comment' && { said: heard(m) }),
          ...(restart !== undefined && last?.answers && { answers: last.answers }),
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
      const [verb = '', step = ''] = afterCommand(m, w?.on.issue_comment?.command)?.split(/\s+/) ?? [];
      const restart = /^restart$/i.test(verb) ? step : undefined;
      if (!w || (used.has(m) && restart === undefined) || !m.trusted || !open.has(m.issue) || young(m.issue)) continue;
      if (/^(stop|cancel)$/i.test(verb)) continue;
      const old = restart === undefined && runs.some(r => r.issue === m.issue && m.at <= (r.seen ?? r.started));
      const held = [...busy].some(k => k.endsWith(`#${m.issue}`));
      if (!held && !old) yield* start(w, m.issue, m.at, m, restart);
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

    /** The issue a run worked on for what was said there, or on a pull request of its branch that is no longer open; `onRun` maps an open one. */
    const pulls = new Map<number, number | undefined>();
    const workedOn = (m: Event) =>
      Effect.gen(function* () {
        if (all.some(r => r.issue === m.issue && !retro(hub, r))) return m.issue;
        if (issues.some(t => t.number === m.issue)) return undefined;
        if (!pulls.has(m.issue)) {
          const branch = Option.getOrUndefined(yield* Effect.option(forge.issue(m.issue)))?.pull?.branch;
          const by = all.find(r => {
            const w = hub.workflows[r.workflow];
            return !retro(hub, r) && w?.branch !== undefined && branch === expand(w.branch, { number: r.issue });
          });
          pulls.set(m.issue, by?.issue);
        }
        return pulls.get(m.issue);
      });
    for (const w of Object.values(hub.workflows).filter(w => w.on.feedback)) {
      const heardOn = new Map<number, Event[]>();
      for (const m of latest.map(onRun).filter(m => feedback(m, command))) {
        const issue = yield* workedOn(m);
        if (issue !== undefined && mine({ issue })) heardOn.set(issue, [...(heardOn.get(issue) ?? []), m]);
      }
      for (const [issue, said] of heardOn) {
        const before = all.filter(r => r.issue === issue && r.workflow === w.name);
        if (young(issue)) continue;
        const first = all
          .filter(r => r.issue === issue && !retro(hub, r))
          .map(r => r.started)
          .sort()[0];
        const since = newest(first, ...before.map(r => r.started))!;
        const fresh = said.filter(m => m.at > since);
        if (fresh.length === 0) continue;
        const at = newest(...fresh.map(m => m.at))!;
        const begun: Run = {
          ...begin(w, { id: `${w.name}-${issue}-${at.replace(/\D/g, '')}`, issue, started: at }),
          feedback: `## What a person said or pushed\n\n${fresh.map(line).join('\n\n')}`,
        };
        yield* store.put(begun);
        touched.push(begun);
      }
    }

    for (const r of runs.map(r => touched.find(t => t.id === r.id) ?? r).filter(live)) {
      const w = hub.workflows[r.workflow];
      const head = r.base && issues.find(t => t.number === r.base!.pull)?.pull?.head;
      if (!w || !r.base || !head || head === r.base.sha || pullOf(w, r.issue, issues) === undefined) continue;
      yield* follow(w, r, r.base, head).pipe(Effect.catchAll(e => Effect.logError(`follow run ${r.id}`, e)));
    }

    for (const r of runs.map(r => touched.find(t => t.id === r.id) ?? r).filter(r => r.status === 'waiting')) {
      const w = hub.workflows[r.workflow];
      const step = w?.steps.find(s => s.name === r.step);
      const pull = w && issues.find(t => t.number === pullOf(w, r.issue, issues))?.pull;
      if (!w || !step || !waits(step) || !pull) continue;
      const caught = yield* catchUp(w, r, hub, pull).pipe(
        Effect.catchAll(e => Effect.as(Effect.logError(`catch up run ${r.id}`, e), undefined))
      );
      const next = caught?.outcome && transition(w, caught.run, caught.outcome);
      if (caught?.outcome && next)
        yield* record(caught.run, caught.outcome, next.status === 'running' ? next : yield* show(w, next));
      else if (caught) yield* store.put(caught.run);
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
 * One pass over the open issues and the issues of live runs, up to `limits.parallel` at once: each gets one look, and a
 * new run only on a trusted mark.
 */
export const sweep = (hub: Hub): Effect.Effect<Run[], ForgeError | StoreError, Services> =>
  Effect.gen(function* () {
    const open = (yield* Effect.flatMap(Forge, f => f.issues({ state: 'open' }))).filter(
      t => !t.pull && inScope(hub, t)
    );
    const runs = (yield* Effect.flatMap(Store, s => s.list())).filter(live);
    const issues = [...new Set([...open.map(t => t.number), ...runs.map(r => r.issue)])];
    return (yield* Effect.forEach(issues, n => tick(hub, n, true), {
      concurrency: hub.limits.parallel,
    })).flat();
  });
