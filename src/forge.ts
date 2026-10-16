import { execFile } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Context, Data, Effect, Layer, Stream } from 'effect';
import { parse, stringify } from 'yaml';
import type { Checkout } from './sandbox.ts';

/** An issue or a pull request, as GitHub returns it. `pull` is set on pull requests. */
export type Issue = {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  labels: string[];
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
 * What a run may change on the repo, and the two proposals that steer the run. `react` and `rebase` are the runner's
 * own; a rebase moves the commits on `branch` after `from` onto `onto`.
 */
export type Proposal =
  | { kind: 'comment'; body: string; edit?: string; under?: string }
  | { kind: 'react'; comment?: string; review?: boolean }
  | { kind: 'label'; add?: string[]; remove?: string[] }
  | { kind: 'push'; branch: string; message: string }
  | { kind: 'rebase'; branch: string; from: string; onto: string }
  | { kind: 'pull_request'; branch: string; base: string; title: string; body: string }
  | { kind: 'merge'; number: number; head: string }
  | { kind: 'issue'; title: string; body: string; parent?: number; labels?: string[] }
  | { kind: 'ask'; question: string }
  | { kind: 'back'; why: string };

/** How a proposal landed; `id` is the comment a reply posted or edited, or the number of an issue opened. */
export type Applied = { proposal: Proposal; ok: boolean; url?: string; id?: string; reason?: string };

export class ForgeError extends Data.TaggedError('ForgeError')<{ status?: number; message: string }> {}

/** The repo as the state: GitHub in production, a JSON file in tests. */
export class Forge extends Context.Tag('bothub/Forge')<
  Forge,
  {
    issues: (filter?: Partial<Pick<Issue, 'state' | 'labels' | 'parent'>>) => Effect.Effect<Issue[], ForgeError>;
    issue: (number: number) => Effect.Effect<Issue & { events: Event[] }, ForgeError>;
    since: (cursor: string) => Stream.Stream<Event, ForgeError>;
    apply: (number: number, proposal: Proposal, work?: Checkout) => Effect.Effect<Applied, ForgeError>;
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
export const withheld = (author: string, what = 'comment') => `(${what} by @${author} withheld: not a collaborator)`;

const execGit = promisify(execFile);
const me = 'bothub[bot]';

/**
 * A forge in a folder, for tests and local runs. `<n>.md` is an issue (frontmatter title, state, author, labels,
 * parent; then the body), `<n>.jsonl` its timeline of events, `<n>.reactions` the 👀 given, and a folder `<n>/` makes
 * it a pull request (`pull.json`, `diff.patch`). Branches live in the git remote of the worktree a push comes from.
 * Authors ending in `[bot]` are not trusted, and their issues' text is withheld. It acts as the bot, or as the
 * trusted person `as`.
 */
export const fileForge = (dir: string, as?: string): Layer.Layer<Forge> =>
  Layer.effect(
    Forge,
    Effect.map(Effect.makeSemaphore(1), lock => {
      const md = (n: number) => join(dir, `${n}.md`);
      const timeline = (n: number) => join(dir, `${n}.jsonl`);
      const pullFile = (n: number) => join(dir, String(n), 'pull.json');
      const optional = <A>(p: Promise<A>) =>
        p.catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? undefined : Promise.reject(e)));
      const who = as ?? me;
      const git = (cwd: string, ...args: string[]) =>
        execGit(
          'git',
          [
            ...['-c', `user.name=${who}`, '-c', 'user.email=bothub@localhost', '-c', 'commit.gpgsign=false'],
            ...['-c', 'remote.origin.mirror=false'],
            ...args,
          ],
          { cwd }
        ).then(r => r.stdout.trim());

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
        !t.author?.endsWith('[bot]') || t.author === me
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
          .map(line => JSON.parse(line) as Event);
      const now = () => new Date().toISOString();
      const say = (m: Omit<Event, 'actor' | 'trusted' | 'at'>) =>
        appendFile(timeline(m.issue), `${JSON.stringify({ ...m, actor: who, trusted: who !== me, at: now() })}\n`);
      /** The tip of `branch` on the checkout's remote, fetched. */
      const tip = (work: string, branch: string) =>
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

      /** Records the checkout's head on the open pull requests of `branch`, with their diffs. */
      const moved = async (work: string, branch: string) => {
        const head = await git(work, 'rev-parse', 'HEAD');
        for (const k of await numbers()) {
          const pr = await read(k);
          if (pr?.pull?.branch !== branch || pr.state !== 'open') continue;
          await write({ ...pr, pull: { ...pr.pull, head } });
          await writeFile(
            join(dir, String(k), 'diff.patch'),
            await git(work, 'diff', `${await tip(work, pr.pull.base)}...HEAD`)
          );
        }
        return head;
      };

      const apply = async (n: number, p: Proposal, work?: string): Promise<Applied> => {
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
            await git(work, 'add', '-A');
            if (await git(work, 'status', '--porcelain')) await git(work, 'commit', '-q', '-m', p.message);
            await git(work, 'push', '-q', 'origin', `HEAD:refs/heads/${p.branch}`);
            return { proposal: p, ok: true, url: `${p.branch}@${await moved(work, p.branch)}` };
          }
          case 'rebase': {
            if (!work) return no('a rebase needs a worktree');
            const was = await tip(work, p.branch);
            await git(work, 'reset', '-q', '--hard', was);
            const clean = await git(work, 'rebase', '-q', '--onto', p.onto, p.from).then(
              () => true,
              () => git(work, 'rebase', '--abort').then(() => false)
            );
            if (!clean) return no(`${p.branch} conflicts with ${p.onto}`);
            const lease = `--force-with-lease=refs/heads/${p.branch}:${was}`;
            await git(work, 'push', '-q', lease, 'origin', `HEAD:refs/heads/${p.branch}`);
            return { proposal: p, ok: true, url: `${p.branch}@${await moved(work, p.branch)}` };
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
            const k = await open({ title: p.title, body: p.body, parent: p.parent ?? n, labels: p.labels ?? [] });
            return { proposal: p, ok: true, url: md(k), id: String(k) };
          }
          case 'react':
            await appendFile(join(dir, `${n}.reactions`), `eyes ${p.comment ?? `#${n}`}\n`);
            return { proposal: p, ok: true };
          case 'ask':
          case 'back':
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
        apply: (n, p, work) => lock.withPermits(1)(io(() => apply(n, p, work?.dir))),
      };
    })
  );
