import { readOrUndefined } from './read.ts';
import { makePlugin, type ToolContext } from './plugin.ts';
import { existsSync, readdirSync } from 'node:fs';
import { appendFile, link, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Context, Data, Effect, Layer, Stream, Semaphore } from 'effect';
import { parse, stringify } from 'yaml';
import {
  issueStatuses,
  makeStudioRunUrl,
  formatFooter,
  splitFooter,
  removeRunLink,
  type Applied,
  type Comment,
  type Event,
  type Issue,
  type IssueStatus,
  type RunLink,
} from './event.ts';
import type { Proposal } from './proposal.ts';
import type { Checkout } from './sandbox.ts';
import { hostGit, mergeTreeOnto, commitPublishedTree } from './git.ts';
import { waitForLock } from './owner.ts';

/** The mark of the run the current fiber writes for; bodies posted under it are stamped with it. */
export const currentRunLinkRef = Context.Reference<RunLink | undefined>('agentgraph/currentRunLink', {
  defaultValue: () => undefined,
});

/** The studio page of a run, opened at the trace line written at or after `at`. */
const makeStudioRunUrlAt = (studio: string, run: string, at: string) => `${makeStudioRunUrl(studio, run)}?at=${at}`;

const formatBodyWithRunLink = (body: string, mark: RunLink, at: string, studio = '') => {
  const fields = Object.entries({ ...mark, at })
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v.replace(/[^\w.:-]/g, '')}`);
  const { text, content } = splitFooter(body);
  return `${removeRunLink(text)}\n\n${formatFooter(removeRunLink(content), studio ? makeStudioRunUrlAt(studio, mark.run, at) : undefined)}\n<!-- agentgraph ${fields.join(' ')} -->`;
};

/** The proposal as posted: its body stamped with `provenance`, and when, if the fiber writes for a run; else unstamped. */
export const makePostableProposal = (p: Proposal, studio?: string) =>
  Effect.map(currentRunLinkRef, (mark): { posted: Proposal; at?: string } => {
    if (!('body' in p)) return { posted: p };
    if (!mark) return { posted: { ...p, body: removeRunLink(p.body) } };
    const at = new Date().toISOString();
    return { posted: { ...p, body: formatBodyWithRunLink(p.body, mark, at, studio) }, at };
  });

export const isPostedBy = (body: string, operation: string) => body.includes(` operation=${operation} `);

export class TrackerError extends Data.TaggedError('TrackerError')<{
  status?: number;
  message: string;
  moved?: true;
}> {}

/** The repo as the state: GitHub in production, a JSON file in tests. */
export class Tracker extends Context.Service<
  Tracker,
  {
    base: Effect.Effect<string, TrackerError>;
    issues: (filter?: Partial<Pick<Issue, 'state' | 'labels' | 'parent'>>) => Effect.Effect<Issue[], TrackerError>;
    searchIssues: (
      ...args: Parameters<ToolContext['tracker']['searchIssues']>
    ) => Effect.Effect<Awaited<ReturnType<ToolContext['tracker']['searchIssues']>>, TrackerError>;
    issue: (number: number) => Effect.Effect<Issue & { events: Event[] }, TrackerError>;
    since: (cursor: string, columns?: boolean) => Stream.Stream<Event, TrackerError>;
    apply: (number: number, proposal: Proposal, work?: Checkout) => Effect.Effect<Applied, TrackerError>;
    findPost: (
      number: number,
      proposal: Proposal,
      operation: string
    ) => Effect.Effect<Applied | undefined, TrackerError>;
    status?: (
      number: number,
      to: IssueStatus,
      names?: Partial<Record<IssueStatus, string>>
    ) => Effect.Effect<void, TrackerError>;
    /** The login people mention to talk to the bot, when the tracker has one. */
    slug?: Effect.Effect<string, TrackerError>;
    moveToColumn?: (number: number, column: NonNullable<Event['column']>) => Effect.Effect<void, TrackerError>;
    /** The studio's URL that bodies link back to, when set. */
    studio?: string;
  }
>()('agentgraph/Tracker') {}

export const makeStatusLabel = (
  to: IssueStatus,
  names: Partial<Record<IssueStatus, string>> = Object.fromEntries(issueStatuses.map(s => [s, `agentgraph:${s}`]))
): Proposal => ({
  kind: 'label',
  add: names[to] === undefined ? [] : [names[to]],
  remove: Object.values(names).filter(name => name !== names[to]),
});

export type TrackerSetup = {
  layer: (trust?: readonly string[]) => Layer.Layer<Tracker>;
  origin: { origin: string; local?: boolean; token?: Effect.Effect<string, TrackerError> };
};

export const parseIssueSearch = (
  query: string,
  { state = 'open', limit = 20 }: NonNullable<Parameters<Tracker['Service']['searchIssues']>[1]> = {}
) =>
  Effect.suspend(() => {
    const terms = (
      query.replace(/-?[\w-]+:(?:"[^"]*"|[^\s)]+)/g, ' ').match(/[\p{L}\p{N}_]+(?:[./-][\p{L}\p{N}_]+)*/gu) ?? []
    ).filter(term => !/^(AND|OR|NOT)$/i.test(term));
    if (!terms.length || query.length > 256)
      return Effect.fail(new TrackerError({ message: 'searchIssues needs keywords up to 256 characters' }));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return Effect.fail(new TrackerError({ message: 'searchIssues limit must be an integer from 1 to 100' }));
    if (!['open', 'closed', 'all'].includes(state))
      return Effect.fail(new TrackerError({ message: 'searchIssues state must be open, closed or all' }));
    return Effect.succeed({ terms, state, limit });
  });

/** The comment with what it asks the bot after its first `/agent` or `@agent` outside quoted lines and fenced code. */
export const makeCommentWithAgentRequest = (c: Comment): Comment => {
  let fenced = false;
  let offset = 0;
  for (const line of c.body.split('\n')) {
    const start = offset;
    offset += line.length + 1;
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || /^\s*>/.test(line)) continue;
    const found = /(?<![\w./-])[/@]agent(?![\w/-])/i.exec(line);
    if (!found) continue;
    const agentRequest = `${c.body.slice(0, start + found.index).trimEnd()} ${c.body
      .slice(start + found.index + found[0].length)
      .replace(/^[,:]/, '')
      .trimStart()}`.trim();
    return { ...c, agentRequest };
  }
  return c;
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

/** The branches a push may move, the files it may change at most, and the largest file it may write. */
export const pushLimits = { prefix: 'agentgraph/', old: 'bothub/', files: 200, bytes: 1 << 20 };
export const isAgentBranch = (branch: string) =>
  branch.startsWith(pushLimits.prefix) || branch.startsWith(pushLimits.old);

/** Why a changed path may not be pushed, if it may not: links, submodules, workflows and git's own files. */
export const unpushable = (path: string, modes: string[]) =>
  modes.some(mode => !['100644', '100755', '000000'].includes(mode))
    ? `${path} has mode ${modes.join(' to ')}; only regular files can be pushed`
    : /^\.github\//i.test(path) || /(^|\/)\.git(\/|$)/i.test(path)
      ? `${path} is under .github/ or .git/`
      : undefined;

export const makePushResult = (
  url: string | undefined,
  held: string[],
  reported: Set<string>
): Omit<Applied, 'proposal'> => {
  const fresh = held.filter(f => !reported.has(f));
  for (const path of held) reported.add(path);
  return {
    ok: fresh.length === 0,
    held,
    ...(url && { url }),
    ...(fresh.length > 0 && {
      reason: `${url ? `Pushed ${url}.` : 'Nothing pushed.'} Not pushed: ${fresh.map(f => `\`${f}\``).join(', ')}. Files under .github/ need a maintainer; do not claim they were added.`,
    }),
  };
};

export const parseIssueFile = (text: string) => {
  const [, head = '', body = text] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text) ?? [];
  return { front: (parse(head) ?? {}) as Partial<Issue>, body };
};

export const formatIssueFile = (front: Partial<Issue>, body: string) => `---\n${stringify(front)}---\n\n${body}\n`;

const publish = async (path: string, text: string) => {
  const draft = `${path}.${randomUUID()}`;
  await writeFile(draft, text);
  try {
    return await link(draft, path).then(
      () => true,
      (e: NodeJS.ErrnoException) => (e.code === 'EEXIST' ? false : Promise.reject(e))
    );
  } finally {
    await unlink(draft);
  }
};

export const runLocked = async <A>(dir: string, f: () => Promise<A>) => {
  const release = await waitForLock('.tracker', dir);
  try {
    return await f();
  } finally {
    await release();
  }
};

type IssueFront = Pick<Issue, 'title' | 'author' | 'labels'> & Partial<Omit<Issue, 'number' | 'body' | 'url' | 'pull'>>;

const isIssueFolder = (name: string) => /^\d+$/.test(name);

const readFolders = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap(f => (f.isDirectory() ? [f.name] : []));
  } catch (e) {
    return readOrUndefined(e) ?? [];
  }
};

const readStatusFolders = (dir: string) =>
  readFolders(dir).filter(f => !isIssueFolder(f) && !f.startsWith('.') && f !== 'origin.git');

export const findIssueNumbers = (dir: string) =>
  [
    ...new Set(
      [...readFolders(dir), ...readStatusFolders(dir).flatMap(s => readFolders(join(dir, s)))]
        .filter(isIssueFolder)
        .map(Number)
    ),
  ].toSorted((a, b) => a - b);

export const findIssueDir = (dir: string, n: number) =>
  [join(dir, String(n)), ...readStatusFolders(dir).map(s => join(dir, s, String(n)))].find(existsSync) ??
  join(dir, String(n));

const fileIssue = async (dir: string, front: IssueFront, body: string): Promise<number> => {
  await mkdir(dir, { recursive: true });
  const number = Math.max(0, ...findIssueNumbers(dir)) + 1;
  const made = await mkdir(join(dir, String(number))).then(
    () => true,
    (e: NodeJS.ErrnoException) => (e.code === 'EEXIST' ? false : Promise.reject(e))
  );
  if (!made) return fileIssue(dir, front, body);
  await writeFile(join(dir, String(number), 'issue.md'), formatIssueFile({ state: 'open', ...front }, body));
  return number;
};

export const writeIssueFile = (dir: string, front: IssueFront, body: string) =>
  runLocked(dir, () => fileIssue(dir, front, body));

const me = 'agentgraph[bot]';

const timelinePath = (dir: string, n: number) => join(findIssueDir(dir, n), 'events.jsonl');

const replaceFile = async (path: string, text: string) => {
  const draft = `${path}.${randomUUID()}`;
  await writeFile(draft, text);
  await rename(draft, path);
};

const isStatusFolder = (name: string) =>
  !isIssueFolder(name) && !/[/\\]/.test(name) && !['', '.', '..', 'origin.git'].includes(name) && !name.startsWith('.');

export const writeTimelineEvent = async (
  dir: string,
  m: Omit<Event, 'at' | 'comment'> & { comment?: Pick<Comment, 'body' | 'path' | 'line' | 'under'> }
) => {
  const at = new Date().toISOString();
  const id = `${m.issue}-${randomUUID().slice(0, 8)}`;
  const comment = m.comment && { comment: { id, author: m.actor, at, ...m.comment } };
  await appendFile(timelinePath(dir, m.issue), `${JSON.stringify({ ...m, at, ...comment })}\n`);
  return id;
};

/**
 * A tracker in a folder, for tests and local runs. Each issue is a folder `<n>/`, or `<status>/<n>/` once it has a
 * status: `issue.md` (frontmatter title, state, author, labels, parent; then the body), `events.jsonl` its timeline,
 * `reactions` the 👀 given, and `pull.json` with `diff.patch` make it a pull request. Branches live in the git remote of
 * the worktree a push comes from.
 * Authors ending in `[bot]` are not trusted, and their issues' text is withheld. It acts as the bot, or as the
 * trusted person `as`.
 */
export const folderTracker = (dir: string, as?: string, trust?: readonly string[]): Layer.Layer<Tracker> =>
  Layer.effect(
    Tracker,
    Effect.map(Semaphore.make(1), lock => {
      const md = (n: number) => join(findIssueDir(dir, n), 'issue.md');
      const readIssueFile = async (n: number, name: string): Promise<string | undefined> => {
        const at = findIssueDir(dir, n);
        const text = await readFile(join(at, name), 'utf8').catch(readOrUndefined);
        return text === undefined && findIssueDir(dir, n) !== at ? readIssueFile(n, name) : text;
      };
      const who = as ?? me;
      const git = (work: Checkout, ...args: string[]) =>
        Effect.runPromise(
          Effect.mapError(
            hostGit(work.git, [
              '-c',
              `user.name=${who}`,
              '-c',
              'user.email=agentgraph@localhost',
              '-c',
              'remote.origin.mirror=false',
              ...args,
            ]),
            e => new TrackerError({ message: e.detail })
          )
        ).then(out => out.toString('utf8').trim());
      const findPushProblem = async (work: Checkout, from: string, to: string) => {
        const fields = (await git(work, 'diff-tree', '-r', '-z', '--no-renames', from, to)).split('\0');
        if ((fields.length - 1) / 2 > pushLimits.files) return `at most ${pushLimits.files} files can be pushed`;
        for (let i = 0; i + 1 < fields.length; i += 2) {
          const [oldMode, newMode, , sha] = fields[i]!.slice(1).split(' ');
          const problem = unpushable(fields[i + 1]!, [oldMode!, newMode!]);
          if (problem) return problem;
          if (newMode !== '000000' && Number(await git(work, 'cat-file', '-s', sha!)) > pushLimits.bytes)
            return `${fields[i + 1]} is over ${pushLimits.bytes} bytes`;
        }
        return undefined;
      };
      /** The last commit pushed from each checkout; the next push from it builds on that commit. */
      const pushed = new Map<string, string>();
      const held = new Map<string, Set<string>>();

      const numbers = async () => findIssueNumbers(dir);
      const read = async (n: number): Promise<Issue | undefined> => {
        const text = await readIssueFile(n, 'issue.md');
        if (text === undefined) return undefined;
        const { front, body } = parseIssueFile(text);
        const [, first = '', rest = ''] = /^#*\s*(.*)\n?([\s\S]*)$/.exec(body.trim()) ?? [];
        const pull = await readIssueFile(n, 'pull.json');
        return {
          number: n,
          state: 'open',
          author: '',
          ...front,
          title: front.title ?? first,
          labels: front.labels ?? [],
          body: (front.title === undefined ? rest : body).trim(),
          ...(pull !== undefined && { pull: JSON.parse(pull) as NonNullable<Issue['pull']> }),
          url: md(n),
        };
      };
      /** The issue as an agent may read it: an outsider's title and text withheld. */
      const shown = (t: Issue): Issue =>
        t.author === me || (trust ? trust.includes(t.author) : !t.author?.endsWith('[bot]'))
          ? { ...t, body: removeRunLink(t.body) }
          : { ...t, title: withheld(t.author, 'title'), body: withheld(t.author, 'issue text') };
      const writePull = async (number: number, pull?: Issue['pull']) => {
        if (pull) await replaceFile(join(findIssueDir(dir, number), 'pull.json'), `${JSON.stringify(pull, null, 2)}\n`);
      };
      const write = async ({ number, body, url: _url, pull, ...front }: Issue) => {
        await replaceFile(md(number), formatIssueFile(front, body));
        await writePull(number, pull);
      };
      const adopt = async (n: number) => {
        if (await stat(timelinePath(dir, n)).catch(readOrUndefined)) return;
        const [t, file] = await Promise.all([read(n), stat(md(n)).catch(readOrUndefined)]);
        if (!t?.author || t.author === me || t.labels.length === 0 || !file) return;
        const at = file.mtime.toISOString();
        const trusted = !t.author.endsWith('[bot]');
        const events = t.labels.map(label => ({ issue: n, kind: 'label', label, actor: t.author, trusted, at }));
        await publish(timelinePath(dir, n), events.map(m => `${JSON.stringify(m)}\n`).join(''));
      };
      const readTimeline = async (n: number) => {
        await adopt(n);
        return ((await readIssueFile(n, 'events.jsonl')) ?? '')
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line) as Event);
      };
      const readIssueEvents = async (n: number) =>
        (await readTimeline(n))
          .map(m =>
            m.comment
              ? { ...m, comment: makeCommentWithAgentRequest({ ...m.comment, body: removeRunLink(m.comment.body) }) }
              : m
          )
          .map(m => (trust && !trust.includes(m.actor) ? { ...m, trusted: false } : m))
          .map(m => {
            if (!m.comment || m.trusted || m.actor === me) return m;
            const { agentRequest: _agentRequest, ...comment } = m.comment;
            return { ...m, comment: { ...comment, body: withheld(m.actor) } };
          });
      const say = (m: Omit<Parameters<typeof writeTimelineEvent>[1], 'actor' | 'trusted'>) =>
        writeTimelineEvent(dir, { ...m, actor: who, trusted: who !== me });
      /** The tip of `branch` on the checkout's remote, fetched when the checkout lacks it. */
      const tip = async (work: Checkout, branch: string) => {
        const ref = `refs/heads/${branch}`;
        const line = (await git(work, 'ls-remote', 'origin', ref)).split('\n').find(l => l.endsWith(`\t${ref}`));
        if (!line) throw new TrackerError({ message: `no branch ${branch}` });
        const head = line.split('\t')[0]!;
        await git(work, 'cat-file', '-e', `${head}^{commit}`).catch(() =>
          git(work, 'fetch', '-q', '--no-write-fetch-head', 'origin', head)
        );
        return head;
      };
      const open = async ({ body, pull, ...front }: Pick<Issue, 'title' | 'body'> & Partial<Issue>) => {
        const number = await fileIssue(dir, { labels: [], author: who, ...front }, body);
        await writePull(number, pull);
        return number;
      };
      const must = async (n: number) => {
        const t = await read(n);
        if (!t) throw new TrackerError({ status: 404, message: `no issue #${n}` });
        return t;
      };

      /** Records `head` on the open pull requests of `branch`, with their diffs. */
      const moved = async (work: Checkout, branch: string, head: string) => {
        for (const k of await numbers()) {
          const pr = await read(k);
          if (pr?.pull?.branch !== branch || pr.state !== 'open') continue;
          await write({ ...pr, pull: { ...pr.pull, head } });
          await writeFile(
            join(findIssueDir(dir, k), 'diff.patch'),
            await git(work, 'diff', `${await tip(work, pr.pull.base)}...${head}`)
          );
        }
        return head;
      };

      const apply = async (n: number, p: Proposal, work?: Checkout): Promise<Applied> => {
        const no = (reason: string, away?: true): Applied => ({
          proposal: p,
          ok: false,
          reason,
          ...(away && { moved: away }),
        });
        const t = await must(n);
        await adopt(n);
        switch (p.kind) {
          case 'comment': {
            const all = await readTimeline(n);
            if (p.edit !== undefined) {
              const at = all.findIndex(m => m.comment?.id === p.edit && m.actor === who);
              if (at < 0) return no(`no comment ${p.edit} of ours on #${n}`);
              all[at] = {
                ...all[at]!,
                comment: { ...all[at]!.comment!, body: p.body, edited: new Date().toISOString() },
              };
              await replaceFile(timelinePath(dir, n), all.map(m => `${JSON.stringify(m)}\n`).join(''));
              return { proposal: p, ok: true, id: p.edit, url: `${md(n)}#${p.edit}` };
            }
            const parent = p.under === undefined ? undefined : all.find(m => m.comment?.id === p.under)?.comment;
            if (p.under !== undefined && !parent) return no(`no review comment ${p.under} on #${n}`);
            const { path, line } = parent ?? {};
            const placed = { ...(path && { path }), ...(line && { line }), ...(p.under && { under: p.under }) };
            const id = await say({ issue: n, kind: 'comment', comment: { body: p.body, ...placed } });
            return { proposal: p, ok: true, id, url: `${md(n)}#${id}` };
          }
          case 'label': {
            const added = (p.add ?? []).filter(l => !t.labels.includes(l));
            await write({ ...t, labels: [...t.labels, ...added].filter(l => !p.remove?.includes(l)) });
            for (const label of added) await say({ issue: n, kind: 'label', label });
            return { proposal: p, ok: true };
          }
          case 'push': {
            if (!isAgentBranch(p.branch)) return no(`a push goes to a ${pushLimits.prefix} branch`);
            if (!work) return no('a push needs a worktree');
            const reported = held.get(p.branch) ?? new Set<string>();
            held.set(p.branch, reported);
            const last = pushed.get(work.dir);
            const was = await tip(work, p.branch).catch(() => undefined);
            const onto = last === undefined ? p.onto : undefined;
            if (onto && was !== (work.head ?? was)) return no(`${p.branch} moved to ${was}`, true);
            const parent = last ?? work.head ?? work.base;
            if (was && was !== parent) return no(`${p.branch} is at ${was}, the checkout builds on ${parent}`, true);
            const parents = onto ? (p.merge ? [parent, onto] : [onto]) : [parent];
            await git(work, 'add', '-A');
            const from = await git(work, 'rev-parse', `${parent}^{tree}`);
            let tree = await git(work, 'write-tree');
            const left = (
              await git(work, 'diff-tree', '-r', '--name-only', '--no-renames', from, tree, '--', '.github')
            )
              .split('\n')
              .filter(Boolean);
            if (left.length) {
              await git(work, 'reset', '-q', from, '--', '.github');
              tree = await git(work, 'write-tree');
              if (tree === from) return { proposal: p, ...makePushResult(undefined, left, reported) };
            }
            const problem = await findPushProblem(work, from, tree);
            if (problem) return no(problem);
            const head =
              !onto && tree === from
                ? parent
                : await git(work, 'commit-tree', tree, ...parents.flatMap(c => ['-p', c]), '-m', p.message);
            const lease = `--force-with-lease=refs/heads/${p.branch}:${was ?? ''}`;
            await git(work, 'push', '-q', lease, 'origin', `${head}:refs/heads/${p.branch}`);
            await Effect.runPromise(commitPublishedTree(work, tree));
            pushed.set(work.dir, head);
            return {
              proposal: p,
              ...makePushResult(`${p.branch}@${await moved(work, p.branch, head)}`, left, reported),
            };
          }
          case 'rebase': {
            if (!isAgentBranch(p.branch)) return no(`a rebase goes to a ${pushLimits.prefix} branch`);
            if (!work) return no('a rebase needs a worktree');
            const was = await tip(work, p.branch);
            if (p.head && was !== p.onto) return no(`${p.branch} moved to ${was}`, true);
            if (p.head) {
              pushed.delete(work.dir);
              work.head = p.onto;
            }
            if (await git(work, 'rev-list', '--merges', `${p.from}..${p.head ?? was}`))
              return no(`${p.branch} contains merge commits; rebase it by hand`);
            let head = p.onto;
            let tree = await git(work, 'rev-parse', `${head}^{tree}`);
            for (const commit of (
              await git(work, 'rev-list', '--reverse', '--no-merges', `${p.from}..${p.head ?? was}`)
            )
              .split('\n')
              .filter(Boolean)) {
              const { tree: next, files } = await Effect.runPromise(
                mergeTreeOnto(work, tree, `${commit}^{tree}`, `${commit}~1^{tree}`)
              );
              if (files.length > 0) {
                if (p.head) await git(work, 'read-tree', '-u', '--reset', next);
                return no(`${p.branch} conflicts with ${p.onto}`);
              }
              if (next === tree) continue;
              if (p.head) {
                tree = next;
                continue;
              }
              const problem = await findPushProblem(work, tree, next);
              if (problem) return no(problem);
              const message = await git(work, 'log', '-1', '--format=%B', commit);
              head = await git(work, 'commit-tree', next, '-p', head, '-m', message);
              tree = next;
            }
            if (p.head) {
              await git(work, 'read-tree', '-u', '--reset', tree);
              return { proposal: p, ok: true };
            }
            const lease = `--force-with-lease=refs/heads/${p.branch}:${was}`;
            await git(work, 'push', '-q', lease, 'origin', `${head}:refs/heads/${p.branch}`);
            await git(work, 'read-tree', '-u', '--reset', tree);
            await Effect.runPromise(commitPublishedTree(work, tree));
            pushed.set(work.dir, head);
            return { proposal: p, ok: true, url: `${p.branch}@${await moved(work, p.branch, head)}` };
          }
          case 'pull_request': {
            const left = [...(held.get(p.branch) ?? [])];
            const body =
              p.body +
              (left.length
                ? `\n\nNot pushed: ${left.map(f => `\`${f}\``).join(', ')}. Files under .github/ need a maintainer.`
                : '');
            if (!isAgentBranch(p.branch)) return no(`a pull request goes from a ${pushLimits.prefix} branch`);
            for (const k of await numbers()) {
              const pr = await read(k);
              if (pr?.pull?.branch !== p.branch || pr.state !== 'open') continue;
              await write({ ...pr, title: p.title, body });
              return { proposal: p, ok: true, url: pr.url };
            }
            const head = work ? await tip(work, p.branch).catch(() => '') : '';
            if (!head) return no(`branch ${p.branch} is not pushed`);
            const k = await open({ title: p.title, body, pull: { branch: p.branch, base: p.base, head } });
            if (work)
              await writeFile(
                join(findIssueDir(dir, k), 'diff.patch'),
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
            const file = join(findIssueDir(dir, n), 'reactions');
            const id = p.comment ?? `#${n}`;
            if (p.remove === undefined) {
              await appendFile(file, `eyes ${id}\n`);
              return { proposal: p, ok: true, id };
            }
            const lines = ((await readIssueFile(n, 'reactions')) ?? '').split('\n').filter(Boolean);
            const at = lines.indexOf(`eyes ${p.remove}`);
            if (at < 0) return no(`no reaction ${p.remove} of ours on #${n}`);
            lines.splice(at, 1);
            await replaceFile(file, lines.map(l => `${l}\n`).join(''));
            return { proposal: p, ok: true };
          }
          case 'ask':
          case 'back':
          case 'run':
          case 'tell':
            return no(`${p.kind} steers the run, not the repo`);
        }
      };

      const io = <A>(f: () => Promise<A>) =>
        Effect.tryPromise({
          try: f,
          catch: e => (e instanceof TrackerError ? e : new TrackerError({ message: (e as Error).message })),
        });
      const locked = <A>(f: () => Promise<A>) => lock.withPermits(1)(io(() => runLocked(dir, f)));

      return {
        searchIssues: (query, options) =>
          Effect.flatMap(parseIssueSearch(query, options), ({ terms, state, limit }) =>
            io(async () =>
              (await Promise.all((await numbers()).map(read)))
                .filter((issue): issue is Issue => issue !== undefined && !issue.pull)
                .filter(issue => state === 'all' || issue.state === state)
                .filter(issue =>
                  terms.every(term => `${issue.title}\n${issue.body}`.toLowerCase().includes(term.toLowerCase()))
                )
                .slice(0, limit)
                .map(shown)
            )
          ),
        base: hostGit({ GIT_DIR: join(dir, 'origin.git') }, ['symbolic-ref', 'HEAD']).pipe(
          Effect.map(out =>
            out
              .toString('utf8')
              .trim()
              .replace(/^refs\/heads\//, '')
          ),
          Effect.mapError(e => new TrackerError({ message: e.detail }))
        ),
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
            events: (await readIssueEvents(n)).map(m =>
              m.comment && !m.trusted && m.actor !== me
                ? { ...m, comment: { ...m.comment, body: withheld(m.actor) } }
                : m
            ),
          })),
        since: cursor =>
          Stream.fromIterableEffect(
            io(async () =>
              (await Promise.all((await numbers()).map(readIssueEvents)))
                .flat()
                .filter(m => m.at > cursor)
                .sort((a, b) => a.at.localeCompare(b.at))
            )
          ),
        apply: (n, p, work) =>
          Effect.flatMap(makePostableProposal(p), ({ posted }) => locked(() => apply(n, posted, work))).pipe(
            Effect.map(a => ({ ...a, proposal: p }))
          ),
        status: (n, to, names) =>
          locked(async () => {
            const folder = names ? names[to] : to;
            if (folder !== undefined && !isStatusFolder(folder))
              throw new TrackerError({ message: `status ${to} cannot be the folder name "${folder}"` });
            const from = findIssueDir(dir, n);
            const into = folder === undefined ? join(dir, String(n)) : join(dir, folder, String(n));
            if (!existsSync(join(from, 'issue.md'))) throw new TrackerError({ status: 404, message: `no issue #${n}` });
            if (from === into) return;
            await mkdir(dirname(into), { recursive: true });
            await rename(from, into);
          }),
        findPost: (n, p, operation) =>
          io(async (): Promise<Applied | undefined> => {
            if (p.kind === 'comment' && p.edit === undefined) {
              const c = (await readTimeline(n)).find(m => m.comment && isPostedBy(m.comment.body, operation))?.comment;
              return c && { proposal: p, ok: true, id: c.id, url: `${md(n)}#${c.id}` };
            }
            if (p.kind !== 'issue') return undefined;
            for (const k of await numbers())
              if (isPostedBy((await read(k))?.body ?? '', operation))
                return { proposal: p, ok: true, url: md(k), id: String(k) };
            return undefined;
          }),
      };
    })
  );

export const folder = makePlugin({
  name: 'folder',
  tracker: ({ dir }): TrackerSetup => {
    if (!dir) throw new Error('the folder tracker needs a folder: --tracker <dir>');
    return {
      layer: trust => folderTracker(dir, undefined, trust),
      origin: { origin: join(dir, 'origin.git'), local: true },
    };
  },
});
