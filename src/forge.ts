import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context, Data, Effect, FiberRef, Layer, Stream } from 'effect';
import { parse, stringify } from 'yaml';
import { hostGit, type Checkout } from './sandbox.ts';

/** An issue or a pull request, as GitHub returns it. `pull` is set on pull requests. */
export type Issue = {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  labels: string[];
  milestone?: string;
  author: string;
  parent?: number;
  pull?: { branch: string; base: string; head: string; baseSha?: string };
  url: string;
};

/** A comment; `path` and `line` place a review comment, `under` is the review comment it answers. */
export type Comment = {
  id: string;
  author: string;
  body: string;
  at: string;
  path?: string;
  line?: number;
  under?: string;
};

/** Something a person or a bot said or did on an issue. */
export type Event = {
  issue: number;
  kind: 'comment' | 'approved' | 'changes_requested' | 'merged' | 'closed' | 'label' | 'unlabel' | 'commit' | 'check';
  actor: string;
  trusted: boolean;
  at: string;
  comment?: Comment;
  label?: string;
  commit?: { sha: string; title: string };
  check?: { name: string; conclusion: string };
};

/**
 * What a run may change on the repo, and the three proposals that steer the run. `react` and `rebase` are the runner's
 * own; a rebase moves the commits on `branch` after `from` onto `onto`, and a react with `remove` takes back the
 * reaction of that id. A push with `onto` lands the files as one commit on `onto` and replaces the branch, or with
 * `merge` as a merge of `onto` into it; either refuses when the branch moved past the commit the checkout started from. An issue with a `parent` is filed as its sub-issue.
 */
export type Proposal =
  | { kind: 'comment'; body: string; edit?: string; under?: string }
  | { kind: 'react'; comment?: string; review?: boolean; remove?: string }
  | { kind: 'label'; add?: string[]; remove?: string[] }
  | { kind: 'push'; branch: string; message: string; onto?: string; merge?: true }
  | { kind: 'rebase'; branch: string; from: string; onto: string }
  | { kind: 'pull_request'; branch: string; base: string; title: string; body: string }
  | { kind: 'merge'; number: number; head: string }
  | { kind: 'issue'; title: string; body: string; parent?: number; labels?: string[] }
  | { kind: 'ask'; question: string }
  | { kind: 'back'; why: string }
  | { kind: 'run'; workflow: string; issue: number };

/**
 * How a proposal landed; `id` is the comment a reply posted or edited, the number of an issue opened, or the reaction
 * given. `at` is when its body was stamped with the run it came from.
 */
export type Applied = { proposal: Proposal; ok: boolean; url?: string; id?: string; reason?: string; at?: string };

/** The run, step and session a write to the forge comes from. */
export type Mark = { run: string; step: string; session?: string };

/** The mark of the run the current fiber writes for; bodies posted under it are stamped with it. */
export const provenance = FiberRef.unsafeMake<Mark | undefined>(undefined);

/** The studio page of a run, opened at the trace line written at or after `at`. */
const runLink = (studio: string, run: string, at: string) =>
  `${studio.replace(/\/+$/, '')}/runs/${encodeURIComponent(run)}?at=${at}`;

/** The body without any provenance marker or ⁂ link in it. */
const unstamped = (body: string) => body.replace(/<!--\s*bothub\b[\s\S]*?(?:-->|$)|\[⁂\]\([^)]*\)/g, '').trimEnd();

/**
 * A body ending in a hidden marker of where it came from, after a ⁂ that links to it when the studio has a URL. Any
 * marker or link already in the body is dropped first.
 */
const stamp = (body: string, mark: Mark, at: string, studio = '') => {
  const fields = Object.entries({ ...mark, at })
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v.replace(/[^\w.:-]/g, '')}`);
  const link = studio ? `[⁂](${runLink(studio, mark.run, at)}) ` : '';
  return `${unstamped(body)}\n\n${link}<!-- bothub ${fields.join(' ')} -->`;
};

/** The proposal as posted: its body stamped with `provenance`, and when, if the fiber writes for a run; else unstamped. */
export const marked = (p: Proposal, studio?: string) =>
  Effect.map(FiberRef.get(provenance), (mark): { posted: Proposal; at?: string } => {
    if (!('body' in p)) return { posted: p };
    if (!mark) return { posted: { ...p, body: unstamped(p.body) } };
    const at = new Date().toISOString();
    return { posted: { ...p, body: stamp(p.body, mark, at, studio) }, at };
  });

export class ForgeError extends Data.TaggedError('ForgeError')<{ status?: number; message: string }> {}

/** The repo as the state: GitHub in production, a JSON file in tests. */
export class Forge extends Context.Tag('bothub/Forge')<
  Forge,
  {
    issues: (filter?: Partial<Pick<Issue, 'state' | 'labels' | 'parent'>>) => Effect.Effect<Issue[], ForgeError>;
    issue: (number: number) => Effect.Effect<Issue & { events: Event[] }, ForgeError>;
    since: (cursor: string) => Stream.Stream<Event, ForgeError>;
    apply: (number: number, proposal: Proposal, work?: Checkout) => Effect.Effect<Applied, ForgeError>;
    /** The login people mention to talk to the bot, when the forge has one. */
    slug?: Effect.Effect<string, ForgeError>;
  }
>() {}

/** A body that says `/bothub` or `@<slug>` as a word outside quoted lines and fenced code, as `/bothub <the rest>`. */
export const commanded = (body: string, slug: string): string => {
  const word = new RegExp(`(^|\\s)(?:/bothub|@${slug.replace(/[^\w-]/g, '')})(?=$|[\\s,:])`, 'i');
  let fenced = false;
  let offset = 0;
  for (const line of body.split('\n')) {
    const start = offset;
    offset += line.length + 1;
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || /^\s*>/.test(line)) continue;
    const found = word.exec(line);
    if (found)
      return `/bothub ${body
        .slice(start + found.index + found[0].length)
        .replace(/^[,:]/, '')
        .trim()}`.trim();
  }
  return body;
};

/** Whether an issue passes the `issues` filter. */
export const matches =
  (filter: Partial<Pick<Issue, 'state' | 'labels' | 'parent'>> = {}) =>
  (t: Issue) =>
    (filter.state === undefined || t.state === filter.state) &&
    (filter.parent === undefined || t.parent === filter.parent) &&
    (filter.labels ?? []).every(l => t.labels.includes(l));

/** The text shown in place of a comment, or another `what`, from someone who is not a collaborator. */
export const withheld = (author: string, what = 'comment', why = 'not a collaborator') =>
  `(${what} by @${author} withheld: ${why})`;

const me = 'bothub[bot]';

/**
 * A forge in a folder, for tests and local runs. `<n>.md` is an issue (frontmatter title, state, author, labels,
 * parent; then the body), `<n>.jsonl` its timeline of events, `<n>.reactions` the 👀 given, and a folder `<n>/` makes
 * it a pull request (`pull.json`, `diff.patch`). Branches live in the git remote of the worktree a push comes from.
 * Authors ending in `[bot]` are not trusted, and their issues' text is withheld. It acts as the bot, or as the
 * trusted person `as`.
 */
export const fileForge = (dir: string, as?: string, trust?: readonly string[]): Layer.Layer<Forge> =>
  Layer.effect(
    Forge,
    Effect.map(Effect.makeSemaphore(1), lock => {
      const md = (n: number) => join(dir, `${n}.md`);
      const timeline = (n: number) => join(dir, `${n}.jsonl`);
      const pullFile = (n: number) => join(dir, String(n), 'pull.json');
      const optional = <A>(p: Promise<A>) =>
        p.catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? undefined : Promise.reject(e)));
      const who = as ?? me;
      const git = (work: Checkout, ...args: string[]) =>
        Effect.runPromise(
          Effect.mapError(
            hostGit(work.git, [
              ...['-c', `user.name=${who}`, '-c', 'user.email=bothub@localhost'],
              ...['-c', 'remote.origin.mirror=false'],
              ...args,
            ]),
            e => new ForgeError({ message: e.detail })
          )
        ).then(out => out.toString('utf8').trim());
      /** The last commit pushed from each checkout; the next push from it builds on that commit. */
      const pushed = new Map<string, string>();

      const numbers = async () =>
        ((await optional(readdir(dir))) ?? []).flatMap(f => (/^\d+(?=\.md$)/.exec(f) ?? []).map(Number));
      const read = async (n: number): Promise<Issue | undefined> => {
        const text = await optional(readFile(md(n), 'utf8'));
        if (text === undefined) return undefined;
        const [, head = '', body = ''] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text) ?? [];
        const front = parse(head) as Omit<Issue, 'number' | 'body' | 'url' | 'pull'>;
        const pull = await optional(readFile(pullFile(n), 'utf8'));
        return {
          number: n,
          ...front,
          labels: front.labels ?? [],
          body: body.trim(),
          ...(pull !== undefined && { pull: JSON.parse(pull) as NonNullable<Issue['pull']> }),
          url: md(n),
        };
      };
      /** The issue as an agent may read it: an outsider's title and text withheld. */
      const shown = (t: Issue): Issue =>
        t.author === me || (trust ? trust.includes(t.author) : !t.author?.endsWith('[bot]'))
          ? t
          : { ...t, title: withheld(t.author, 'title'), body: withheld(t.author, 'issue text') };
      const write = async ({ number, body, url: _url, pull, ...front }: Issue) => {
        await mkdir(dir, { recursive: true });
        await writeFile(md(number), `---\n${stringify(front)}---\n\n${body}\n`);
        if (pull) {
          await mkdir(join(dir, String(number)), { recursive: true });
          await writeFile(pullFile(number), `${JSON.stringify(pull, null, 2)}\n`);
        }
      };
      const eventsOf = async (n: number) =>
        ((await optional(readFile(timeline(n), 'utf8'))) ?? '')
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line) as Event)
          .map(m => (trust && !trust.includes(m.actor) ? { ...m, trusted: false } : m));
      const now = () => new Date().toISOString();
      const say = (m: Omit<Event, 'actor' | 'trusted' | 'at'>) =>
        appendFile(timeline(m.issue), `${JSON.stringify({ ...m, actor: who, trusted: who !== me, at: now() })}\n`);
      /** The tip of `branch` on the checkout's remote, fetched. */
      const tip = (work: Checkout, branch: string) =>
        git(work, 'fetch', '-q', 'origin', `refs/heads/${branch}`).then(() => git(work, 'rev-parse', 'FETCH_HEAD'));
      const open = async (fields: Pick<Issue, 'title' | 'body'> & Partial<Issue>) => {
        const number = Math.max(0, ...(await numbers())) + 1;
        await write({ number, state: 'open', labels: [], author: who, url: '', ...fields });
        return number;
      };
      const must = async (n: number) => {
        const t = await read(n);
        if (!t) throw new ForgeError({ status: 404, message: `no issue #${n}` });
        return t;
      };

      /** Records `head` on the open pull requests of `branch`, with their diffs. */
      const moved = async (work: Checkout, branch: string, head: string) => {
        for (const k of await numbers()) {
          const pr = await read(k);
          if (pr?.pull?.branch !== branch || pr.state !== 'open') continue;
          await write({ ...pr, pull: { ...pr.pull, head } });
          await writeFile(
            join(dir, String(k), 'diff.patch'),
            await git(work, 'diff', `${await tip(work, pr.pull.base)}...${head}`)
          );
        }
        return head;
      };

      const apply = async (n: number, p: Proposal, work?: Checkout): Promise<Applied> => {
        const no = (reason: string): Applied => ({ proposal: p, ok: false, reason });
        const t = await must(n);
        switch (p.kind) {
          case 'comment': {
            const all = await eventsOf(n);
            if (p.edit !== undefined) {
              const at = all.findIndex(m => m.comment?.id === p.edit && m.actor === who);
              if (at < 0) return no(`no comment ${p.edit} of ours on #${n}`);
              all[at] = { ...all[at]!, comment: { ...all[at]!.comment!, body: p.body } };
              await writeFile(timeline(n), all.map(m => `${JSON.stringify(m)}\n`).join(''));
              return { proposal: p, ok: true, id: p.edit, url: `${md(n)}#${p.edit}` };
            }
            const id = `${n}-${all.length + 1}`;
            const parent = p.under === undefined ? undefined : all.find(m => m.comment?.id === p.under)?.comment;
            if (p.under !== undefined && !parent) return no(`no review comment ${p.under} on #${n}`);
            const { path, line } = parent ?? {};
            const placed = { ...(path && { path }), ...(line && { line }), ...(p.under && { under: p.under }) };
            await say({ issue: n, kind: 'comment', comment: { id, author: who, body: p.body, at: now(), ...placed } });
            return { proposal: p, ok: true, id, url: `${md(n)}#${id}` };
          }
          case 'label': {
            const added = (p.add ?? []).filter(l => !t.labels.includes(l));
            await write({ ...t, labels: [...t.labels, ...added].filter(l => !p.remove?.includes(l)) });
            for (const label of added) await say({ issue: n, kind: 'label', label });
            return { proposal: p, ok: true };
          }
          case 'push': {
            if (!work) return no('a push needs a worktree');
            const last = pushed.get(work.dir);
            const was = await tip(work, p.branch).catch(() => undefined);
            const onto = last === undefined ? p.onto : undefined;
            if (onto && was !== (work.head ?? was)) return no(`${p.branch} moved to ${was}`);
            const parent = last ?? was ?? work.head ?? work.base;
            const parents = onto ? (p.merge ? [parent, onto] : [onto]) : [parent];
            await git(work, 'add', '-A');
            const tree = await git(work, 'write-tree');
            const head =
              !onto && tree === (await git(work, 'rev-parse', `${parent}^{tree}`))
                ? parent
                : await git(work, 'commit-tree', tree, ...parents.flatMap(c => ['-p', c]), '-m', p.message);
            const force = onto && !p.merge ? '+' : '';
            await git(work, 'push', '-q', 'origin', `${force}${head}:refs/heads/${p.branch}`);
            pushed.set(work.dir, head);
            return { proposal: p, ok: true, url: `${p.branch}@${await moved(work, p.branch, head)}` };
          }
          case 'rebase': {
            if (!work) return no('a rebase needs a worktree');
            const was = await tip(work, p.branch);
            let head = p.onto;
            let tree = await git(work, 'rev-parse', `${head}^{tree}`);
            for (const commit of (await git(work, 'rev-list', '--reverse', '--no-merges', `${p.from}..${was}`))
              .split('\n')
              .filter(Boolean)) {
              const next = await git(
                work,
                ...['merge-tree', '--write-tree', '--no-messages', `--merge-base=${commit}~1^{tree}`, tree],
                `${commit}^{tree}`
              ).catch(() => undefined);
              if (next === undefined) return no(`${p.branch} conflicts with ${p.onto}`);
              if (next === tree) continue;
              const message = await git(work, 'log', '-1', '--format=%B', commit);
              head = await git(work, 'commit-tree', next, '-p', head, '-m', message);
              tree = next;
            }
            const lease = `--force-with-lease=refs/heads/${p.branch}:${was}`;
            await git(work, 'push', '-q', lease, 'origin', `${head}:refs/heads/${p.branch}`);
            await git(work, 'read-tree', '-u', '--reset', tree);
            pushed.set(work.dir, head);
            return { proposal: p, ok: true, url: `${p.branch}@${await moved(work, p.branch, head)}` };
          }
          case 'pull_request': {
            for (const k of await numbers()) {
              const pr = await read(k);
              if (pr?.pull?.branch === p.branch && pr.state === 'open') return { proposal: p, ok: true, url: pr.url };
            }
            const head = work ? await tip(work, p.branch).catch(() => '') : '';
            if (!head) return no(`branch ${p.branch} is not pushed`);
            const k = await open({ title: p.title, body: p.body, pull: { branch: p.branch, base: p.base, head } });
            if (work)
              await writeFile(
                join(dir, String(k), 'diff.patch'),
                await git(work, 'diff', `${await tip(work, p.base)}...${head}`)
              );
            return { proposal: p, ok: true, url: md(k) };
          }
          case 'merge': {
            const pr = await must(p.number);
            if (!pr.pull || pr.state !== 'open') return no(`#${p.number} is not an open pull request`);
            if (pr.pull.head !== p.head) return no(`#${p.number} moved to ${pr.pull.head}`);
            await write({ ...pr, state: 'merged' });
            await say({ issue: p.number, kind: 'merged' });
            return { proposal: p, ok: true, url: pr.url };
          }
          case 'issue': {
            const k = await open({
              title: p.title,
              body: p.body,
              ...(p.parent !== undefined && { parent: p.parent }),
              labels: p.labels ?? [],
            });
            return { proposal: p, ok: true, url: md(k), id: String(k) };
          }
          case 'react': {
            const file = join(dir, `${n}.reactions`);
            const id = p.comment ?? `#${n}`;
            if (p.remove === undefined) {
              await appendFile(file, `eyes ${id}\n`);
              return { proposal: p, ok: true, id };
            }
            const lines = ((await optional(readFile(file, 'utf8'))) ?? '').split('\n').filter(Boolean);
            const at = lines.indexOf(`eyes ${p.remove}`);
            if (at < 0) return no(`no reaction ${p.remove} of ours on #${n}`);
            lines.splice(at, 1);
            await writeFile(file, lines.map(l => `${l}\n`).join(''));
            return { proposal: p, ok: true };
          }
          case 'ask':
          case 'back':
          case 'run':
            return no(`${p.kind} steers the run, not the repo`);
        }
      };

      const io = <A>(f: () => Promise<A>) =>
        Effect.tryPromise({
          try: f,
          catch: e => (e instanceof ForgeError ? e : new ForgeError({ message: (e as Error).message })),
        });

      return {
        issues: filter =>
          io(async () => {
            const all = await Promise.all((await numbers()).map(read));
            return all
              .filter((t): t is Issue => t !== undefined)
              .filter(matches(filter))
              .map(shown);
          }),
        issue: n =>
          io(async () => ({
            ...shown(await must(n)),
            events: (await eventsOf(n)).map(m =>
              m.comment && !m.trusted && m.actor !== me
                ? { ...m, comment: { ...m.comment, body: withheld(m.actor) } }
                : m
            ),
          })),
        since: cursor =>
          Stream.fromIterableEffect(
            io(async () =>
              (await Promise.all((await numbers()).map(eventsOf)))
                .flat()
                .filter(m => m.at > cursor)
                .map(m =>
                  m.trusted && m.comment
                    ? { ...m, comment: { ...m.comment, body: commanded(m.comment.body, 'bothub') } }
                    : m
                )
                .sort((a, b) => a.at.localeCompare(b.at))
            )
          ),
        apply: (n, p, work) => lock.withPermits(1)(io(() => apply(n, p, work))),
      };
    })
  );
