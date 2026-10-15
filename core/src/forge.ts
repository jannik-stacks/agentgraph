import { execFile } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Context, Data, Effect, Layer, Stream } from 'effect';
import { parse, stringify } from 'yaml';

/** An issue or a pull request, as GitHub returns it. `pull` is set on pull requests. */
export type Thread = {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  labels: string[];
  author: string;
  parent?: number;
  pull?: { branch: string; into: string; head: string };
  url: string;
};

export type Comment = { id: string; author: string; body: string; at: string; path?: string; line?: number };

/** Something a person or a bot said or did on a thread. */
export type Message = {
  thread: number;
  kind: 'comment' | 'approved' | 'changes' | 'merged' | 'closed' | 'label';
  actor: string;
  trusted: boolean;
  at: string;
  comment?: Comment;
  label?: string;
};

/** What a run may change on the repo, and the two proposals that steer the run. */
export type Proposal =
  | { kind: 'reply'; body: string }
  | { kind: 'label'; add?: string[]; remove?: string[] }
  | { kind: 'push'; branch: string; message: string }
  | { kind: 'pull'; branch: string; into: string; title: string; body: string }
  | { kind: 'merge'; number: number; head: string }
  | { kind: 'issue'; title: string; body: string; parent?: number }
  | { kind: 'ask'; question: string }
  | { kind: 'back'; why: string };

export type Applied = { proposal: Proposal; ok: boolean; url?: string; reason?: string };

export class ForgeError extends Data.TaggedError('ForgeError')<{ status?: number; message: string }> {}

/** The repo as the state: GitHub in production, a JSON file in tests. */
export class Forge extends Context.Tag('bothub/Forge')<
  Forge,
  {
    threads: (filter?: Partial<Pick<Thread, 'state' | 'labels' | 'parent'>>) => Effect.Effect<Thread[], ForgeError>;
    thread: (number: number) => Effect.Effect<Thread & { comments: Comment[] }, ForgeError>;
    since: (cursor: string) => Stream.Stream<Message, ForgeError>;
    apply: (number: number, proposal: Proposal, dir?: string) => Effect.Effect<Applied, ForgeError>;
  }
>() {}

const execGit = promisify(execFile);
const me = 'bothub[bot]';

/**
 * A forge in a folder, for tests. `<n>.md` is a thread (frontmatter title, state, author, labels, parent; then the
 * body), `<n>.jsonl` its timeline of messages, and a folder `<n>/` makes it a pull request (`pull.json`, `diff.patch`).
 * Branches live in the git remote of the worktree a push comes from. Authors ending in `[bot]` are not trusted.
 */
export const fileForge = (dir: string): Layer.Layer<Forge> =>
  Layer.effect(
    Forge,
    Effect.map(Effect.makeSemaphore(1), lock => {
      const md = (n: number) => join(dir, `${n}.md`);
      const timeline = (n: number) => join(dir, `${n}.jsonl`);
      const pullFile = (n: number) => join(dir, String(n), 'pull.json');
      const optional = <A>(p: Promise<A>) =>
        p.catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? undefined : Promise.reject(e)));
      const git = (cwd: string, ...args: string[]) =>
        execGit(
          'git',
          ['-c', `user.name=${me}`, '-c', 'user.email=bothub@localhost', '-c', 'commit.gpgsign=false', ...args],
          { cwd }
        ).then(r => r.stdout.trim());

      const numbers = async () =>
        ((await optional(readdir(dir))) ?? []).flatMap(f => (/^\d+(?=\.md$)/.exec(f) ?? []).map(Number));
      const read = async (n: number): Promise<Thread | undefined> => {
        const text = await optional(readFile(md(n), 'utf8'));
        if (text === undefined) return undefined;
        const [, head = '', body = ''] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text) ?? [];
        const front = parse(head) as Omit<Thread, 'number' | 'body' | 'url' | 'pull'>;
        const pull = await optional(readFile(pullFile(n), 'utf8'));
        return {
          number: n,
          ...front,
          labels: front.labels ?? [],
          body: body.trim(),
          ...(pull !== undefined && { pull: JSON.parse(pull) as NonNullable<Thread['pull']> }),
          url: md(n),
        };
      };
      const write = async ({ number, body, url: _url, pull, ...front }: Thread) => {
        await mkdir(dir, { recursive: true });
        await writeFile(md(number), `---\n${stringify(front)}---\n\n${body}\n`);
        if (pull) {
          await mkdir(join(dir, String(number)), { recursive: true });
          await writeFile(pullFile(number), `${JSON.stringify(pull, null, 2)}\n`);
        }
      };
      const messages = async (n: number) =>
        ((await optional(readFile(timeline(n), 'utf8'))) ?? '')
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line) as Message);
      const now = () => new Date().toISOString();
      const say = (m: Omit<Message, 'actor' | 'trusted' | 'at'>) =>
        appendFile(timeline(m.thread), `${JSON.stringify({ ...m, actor: me, trusted: false, at: now() })}\n`);
      const open = async (fields: Pick<Thread, 'title' | 'body'> & Partial<Thread>) => {
        const number = Math.max(0, ...(await numbers())) + 1;
        await write({ number, state: 'open', labels: [], author: me, url: '', ...fields });
        return number;
      };
      const must = async (n: number) => {
        const t = await read(n);
        if (!t) throw new ForgeError({ status: 404, message: `no thread #${n}` });
        return t;
      };

      const apply = async (n: number, p: Proposal, work?: string): Promise<Applied> => {
        const no = (reason: string): Applied => ({ proposal: p, ok: false, reason });
        const t = await must(n);
        switch (p.kind) {
          case 'reply': {
            const id = `${n}-${(await messages(n)).length + 1}`;
            await say({ thread: n, kind: 'comment', comment: { id, author: me, body: p.body, at: now() } });
            return { proposal: p, ok: true, url: `${md(n)}#${id}` };
          }
          case 'label': {
            const added = (p.add ?? []).filter(l => !t.labels.includes(l));
            await write({ ...t, labels: [...t.labels, ...added].filter(l => !p.remove?.includes(l)) });
            for (const label of added) await say({ thread: n, kind: 'label', label });
            return { proposal: p, ok: true };
          }
          case 'push': {
            if (!work) return no('a push needs a worktree');
            await git(work, 'add', '-A');
            if (await git(work, 'status', '--porcelain')) await git(work, 'commit', '-q', '-m', p.message);
            await git(work, 'push', '-q', 'origin', `HEAD:refs/heads/${p.branch}`);
            const head = await git(work, 'rev-parse', 'HEAD');
            for (const k of await numbers()) {
              const pr = await read(k);
              if (pr?.pull?.branch !== p.branch || pr.state !== 'open') continue;
              await write({ ...pr, pull: { ...pr.pull, head } });
              await writeFile(
                join(dir, String(k), 'diff.patch'),
                await git(work, 'diff', `origin/${pr.pull.into}...HEAD`)
              );
            }
            return { proposal: p, ok: true, url: `${p.branch}@${head}` };
          }
          case 'pull': {
            for (const k of await numbers()) {
              const pr = await read(k);
              if (pr?.pull?.branch === p.branch && pr.state === 'open') return { proposal: p, ok: true, url: pr.url };
            }
            const head = work ? await git(work, 'rev-parse', `origin/${p.branch}`).catch(() => '') : '';
            if (!head) return no(`branch ${p.branch} is not pushed`);
            const k = await open({ title: p.title, body: p.body, pull: { branch: p.branch, into: p.into, head } });
            if (work)
              await writeFile(
                join(dir, String(k), 'diff.patch'),
                await git(work, 'diff', `origin/${p.into}...${head}`)
              );
            return { proposal: p, ok: true, url: md(k) };
          }
          case 'merge': {
            const pr = await must(p.number);
            if (!pr.pull || pr.state !== 'open') return no(`#${p.number} is not an open pull request`);
            if (pr.pull.head !== p.head) return no(`#${p.number} moved to ${pr.pull.head}`);
            await write({ ...pr, state: 'merged' });
            await say({ thread: p.number, kind: 'merged' });
            return { proposal: p, ok: true, url: pr.url };
          }
          case 'issue':
            return {
              proposal: p,
              ok: true,
              url: md(await open({ title: p.title, body: p.body, parent: p.parent ?? n })),
            };
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
        threads: filter =>
          io(async () => {
            const all = await Promise.all((await numbers()).map(read));
            return all.filter(
              (t): t is Thread =>
                t !== undefined &&
                (filter?.state === undefined || t.state === filter.state) &&
                (filter?.parent === undefined || t.parent === filter.parent) &&
                (filter?.labels ?? []).every(l => t.labels.includes(l))
            );
          }),
        thread: n =>
          io(async () => ({
            ...(await must(n)),
            comments: (await messages(n)).flatMap(m => (m.comment ? [m.comment] : [])),
          })),
        since: cursor =>
          Stream.fromIterableEffect(
            io(async () =>
              (await Promise.all((await numbers()).map(messages)))
                .flat()
                .filter(m => m.at > cursor)
                .sort((a, b) => a.at.localeCompare(b.at))
            )
          ),
        apply: (n, p, work) => lock.withPermits(1)(io(() => apply(n, p, work))),
      };
    })
  );
