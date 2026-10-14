import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { botEnv, gitStatus } from './git.ts';
import type { GitHub, GitHubError } from './github-app.ts';
import { toEvent } from './github.ts';
import type { Comment } from './issues.ts';
import type { Proposal } from './outputs.ts';
import type { BotEvent } from './types.ts';

/**
 * A request to merge `branch` into `into`: a pull request on GitHub, a `pulls.jsonl` record locally. `head` is the
 * branch's commit and `origin` the job and event that opened it.
 */
export type Pull = {
  number: number;
  url: string;
  title: string;
  body: string;
  branch: string;
  into: string;
  state: 'open' | 'closed' | 'merged';
  head?: string;
  origin?: { job: string; event: string };
};

/** A comment on a merge request; one on a line of its diff names the file, the line and its side of the diff. */
export type PullComment = Comment & { path?: string; line?: number; side?: 'old' | 'new' };

/** The local merge requests' op log in data directory `data`. */
export const pullsFile = (data: string) => join(data, 'pulls.jsonl');

/** What was asked for does not exist. */
export class Missing extends Error {}

export type PullFilter = { branch?: string; into?: string; state?: Pull['state'] | 'all' };

export type NewPull = Omit<Extract<Proposal, { kind: 'merge-request' }>, 'kind' | 'into'> &
  Pick<Pull, 'into' | 'origin'>;

/**
 * Merge requests behind one interface. `list` returns open requests unless `state` says otherwise; `get` adds whether
 * the request merges cleanly. `ensureBranch` creates a branch from the default branch when it does not exist yet, and
 * `open` does so for `into`. `refresh` merges a request's `into` into its branch when the branch is behind and the
 * merge is clean, and resolves to whether the branch moved. `merge` lands
 * a request only while `into` and the branch are still at the commits in `expected`, and throws otherwise. `comments`
 * lists what was said on a request, oldest first.
 */
export type Pulls = {
  defaultBranch: () => Promise<string>;
  list: (filter?: PullFilter) => Promise<Pull[]>;
  get: (number: number) => Promise<(Pull & { mergeable?: boolean }) | undefined>;
  comments: (number: number) => Promise<PullComment[]>;
  ensureBranch: (branch: string) => Promise<void>;
  refresh: (number: number) => Promise<boolean>;
  open: (request: NewPull) => Promise<Pull>;
  merge: (number: number, expected: { head: string; into: string }) => Promise<{ sha: string }>;
};

const matches = (pull: Pull, { branch, into, state = 'open' }: PullFilter) =>
  (state === 'all' || pull.state === state) &&
  (branch === undefined || pull.branch === branch) &&
  (into === undefined || pull.into === into);

const originMarker = /<!-- bothub:request (\S+) (\S+) -->/;

type RestComment = {
  user: { login: string };
  body: string;
  created_at: string;
  html_url: string;
  path?: string;
  line?: number | null;
  side?: 'LEFT' | 'RIGHT';
};

type RestPull = {
  number: number;
  html_url: string;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  merged_at?: string | null;
  mergeable?: boolean | null;
  head: { ref: string; sha: string; repo?: { full_name: string } | null };
  base: { ref: string; sha: string };
};

const notFound = (e: GitHubError) => {
  if (e.status !== 404) throw e;
  return undefined;
};

/** Pull requests of `repo` on GitHub. A request from a fork names its branch `<owner>/<repo>:<branch>`. */
export const githubPulls = (gh: GitHub, repo: string): Pulls => {
  const toPull = (r: RestPull): Pull & { mergeable?: boolean; base: string } => {
    const body = r.body ?? '';
    const [, job, event] = originMarker.exec(body) ?? [];
    const own = r.head.repo?.full_name === repo;
    return {
      number: r.number,
      url: r.html_url,
      title: r.title,
      body,
      branch: own ? r.head.ref : `${r.head.repo?.full_name ?? 'unknown'}:${r.head.ref}`,
      into: r.base.ref,
      state: r.merged_at ? 'merged' : r.state,
      head: r.head.sha,
      base: r.base.sha,
      ...(typeof r.mergeable === 'boolean' && { mergeable: r.mergeable }),
      ...(job && event && { origin: { job, event } }),
    };
  };
  const defaultBranch = async () => (await gh<{ default_branch: string }>('GET', `/repos/${repo}`)).default_branch;
  const ref = (branch: string) =>
    gh<{ object: { sha: string } }>('GET', `/repos/${repo}/git/ref/heads/${branch}`).catch(notFound);
  const ensureBranch = async (branch: string) => {
    if (await ref(branch)) return;
    const from = await ref(await defaultBranch());
    if (!from) throw new Error('the default branch has no commit to start from');
    await gh('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: from.object.sha }).catch(
      async (e: unknown) => {
        if (!(await ref(branch))) throw e;
      }
    );
  };
  const get = async (number: number) => {
    const found = await gh<RestPull>('GET', `/repos/${repo}/pulls/${number}`).catch(notFound);
    return found && toPull(found);
  };
  const comments = async (number: number) => {
    const [said, reviewed] = await Promise.all([
      gh<RestComment[]>('GET', `/repos/${repo}/issues/${number}/comments?per_page=100`),
      gh<RestComment[]>('GET', `/repos/${repo}/pulls/${number}/comments?per_page=100`),
    ]);
    return [...said, ...reviewed]
      .map((c): PullComment => ({
        author: c.user.login,
        ts: c.created_at,
        body: c.body,
        url: c.html_url,
        ...(c.path && { path: c.path }),
        ...(typeof c.line === 'number' && { line: c.line }),
        ...(c.side && { side: c.side === 'LEFT' ? 'old' : 'new' }),
      }))
      .sort((a, b) => a.ts.localeCompare(b.ts));
  };
  return {
    defaultBranch,
    comments,
    list: async (filter = {}) => {
      const state =
        filter.state === 'open' || filter.state === undefined ? 'open' : filter.state === 'all' ? 'all' : 'closed';
      const query = new URLSearchParams({
        state,
        per_page: '100',
        ...(filter.into && { base: filter.into }),
        ...(filter.branch && { head: `${repo.split('/')[0]}:${filter.branch}` }),
      });
      const pulls = await gh<RestPull[]>('GET', `/repos/${repo}/pulls?${query}`);
      return pulls.map(toPull).filter(pull => matches(pull, filter));
    },
    get,
    ensureBranch,
    refresh: async number => {
      const pull = await get(number);
      if (pull?.state !== 'open') return false;
      return gh('PUT', `/repos/${repo}/pulls/${number}/update-branch`, { expected_head_sha: pull.head }).then(
        () => true,
        () => false
      );
    },
    open: async ({ branch, into, title, body, draft, origin }) => {
      await ensureBranch(into);
      const marked = origin ? `${body}\n\n<!-- bothub:request ${origin.job} ${origin.event} -->` : body;
      const created = await gh<RestPull>('POST', `/repos/${repo}/pulls`, {
        title,
        body: marked,
        head: branch,
        base: into,
        ...(draft !== undefined && { draft }),
      });
      return toPull(created);
    },
    merge: async (number, expected) => {
      const pull = await get(number);
      if (!pull) throw new Error(`no pull request #${number}`);
      if (pull.base !== expected.into) throw new Error(`"${pull.into}" moved since the merge was checked`);
      return gh<{ sha: string }>('PUT', `/repos/${repo}/pulls/${number}/merge`, {
        sha: expected.head,
        merge_method: 'merge',
      });
    },
  };
};

/** One line of the log, besides its `ts`. */
export type Op =
  | {
      number: number;
      op: 'open';
      branch: string;
      into: string;
      title: string;
      body: string;
      draft?: boolean;
      job?: string;
      event?: string;
      sha: string;
    }
  | { number: number; op: 'update'; sha: string }
  | { number: number; op: 'merge'; sha: string; 'into-sha': string }
  | ({ number: number; op: 'comment' } & Omit<PullComment, 'ts' | 'url'>);

/** The comments in an op log on request `number`, each with the time it was recorded. */
export const commentsIn = (ops: (Op & { ts?: string })[], number: number, url: (number: number) => string) =>
  ops.flatMap((op): PullComment[] =>
    op.op === 'comment' && op.number === number
      ? [
          {
            author: op.author,
            ts: op.ts ?? '',
            body: op.body,
            url: `${url(number)}/comments`,
            ...(op.path && { path: op.path }),
            ...(op.line !== undefined && { line: op.line }),
            ...(op.side && { side: op.side }),
          },
        ]
      : []
  );

const readLog = async (file: string) =>
  (await readFile(file, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Op & { ts?: string });

/** Local merge request `number` in the op log `file`; throws {@link Missing} when there is no such request. */
export const localPull = async (file: string, number: number) => {
  const pull = fold(await readLog(file), String).find(pull => pull.number === number);
  if (!pull) throw new Missing(`no merge request #${number}`);
  return pull;
};

/**
 * Records comments on local merge request `number` in the op log `file`, in order and in one write; throws
 * {@link Missing} when there is no such request.
 */
export const commentOn = async (file: string, number: number, ...comments: Omit<PullComment, 'ts' | 'url'>[]) => {
  await localPull(file, number);
  const ts = new Date().toISOString();
  const ops = comments.map((comment): Op & { ts: string } => ({ ts, number, op: 'comment', ...comment }));
  await appendFile(file, ops.map(op => `${JSON.stringify(op)}\n`).join(''));
};

/** A local request with every commit its branch was at, in order. */
type Folded = Pull & { head: string; shas: string[] };

/** The requests an op log describes, each at its latest state. */
export const fold = (ops: Op[], url: (number: number) => string) => {
  const pulls = new Map<number, Folded>();
  for (const op of ops) {
    const pull = pulls.get(op.number);
    if (op.op === 'open')
      pulls.set(op.number, {
        number: op.number,
        url: url(op.number),
        title: op.title,
        body: op.body,
        branch: op.branch,
        into: op.into,
        state: 'open',
        head: op.sha,
        shas: [op.sha],
        ...(op.job && op.event && { origin: { job: op.job, event: op.event } }),
      });
    else if (pull && op.op === 'update') pulls.set(op.number, { ...pull, head: op.sha, shas: [...pull.shas, op.sha] });
    else if (pull && op.op === 'merge') pulls.set(op.number, { ...pull, state: 'merged' });
  }
  return [...pulls.values()];
};

/**
 * Merge requests on a local bare `origin`, as an append-only log in `file` folded on read: `open`, `update` when a
 * branch moved, `merge` when it landed. The default branch is the origin's `HEAD`, a request's head is its branch's
 * live commit, mirrored to `refs/pull/<n>/head` like GitHub, and a merge is `merge-tree`, `commit-tree` and a
 * compare-and-swap `update-ref` on the origin. `events` records branches that moved and returns the `pull_request`
 * events (opened, synchronize, closed) of every request in `repo` and an event per comment, with ids that stay the same
 * each time. `comment` records a comment on a request.
 */
export const localPulls = ({ origin, file, repo }: { origin: string; file: string; repo: string }) => {
  const git = (args: string[], env?: Record<string, string>) => gitStatus(origin, args, env);
  const tip = async (branch: string) => {
    const { code, stdout } = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    return code === 0 && stdout ? stdout : undefined;
  };
  const url = (number: number) => `${origin}#pull/${number}`;
  const ops = () => readLog(file);
  const record = (op: Op) => appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), ...op })}\n`);
  const all = async () =>
    Promise.all(
      fold(await ops(), url).map(async pull => ({
        ...pull,
        head: (pull.state === 'open' && (await tip(pull.branch))) || pull.head,
      }))
    );
  const plain = ({ shas: _, ...pull }: Folded): Pull => pull;

  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>) => {
    const next = queue.catch(() => {}).then(task);
    queue = next;
    return next;
  };

  const defaultBranch = async () => (await git(['symbolic-ref', '--short', 'HEAD'])).stdout;
  const mergeTree = (into: string, head: string) =>
    git(['merge-tree', '--write-tree', '--name-only', '--no-messages', into, head]);
  const ensureBranch = async (branch: string) => {
    if (await tip(branch)) return;
    const from = await tip(await defaultBranch());
    if (!from) throw new Error('the default branch has no commit to start from');
    const created = await git(['update-ref', `refs/heads/${branch}`, from, '']);
    if (created.code !== 0 && !(await tip(branch))) throw new Error(`branch "${branch}" could not be created`);
  };

  const pulls: Pulls = {
    defaultBranch,
    ensureBranch,
    comments: async number => commentsIn(await ops(), number, url),
    list: async (filter = {}) => (await all()).filter(pull => matches(pull, filter)).map(plain),
    get: async number => {
      const pull = (await all()).find(p => p.number === number);
      if (!pull) return;
      const into = await tip(pull.into);
      if (pull.state !== 'open' || !into || !pull.head) return plain(pull);
      return { ...plain(pull), mergeable: (await mergeTree(into, pull.head)).code === 0 };
    },
    open: request =>
      serial(async () => {
        const sha = await tip(request.branch);
        if (!sha) throw new Error(`branch "${request.branch}" does not exist`);
        await ensureBranch(request.into);
        const number = Math.max(0, ...(await ops()).map(op => op.number)) + 1;
        const { origin: from, draft, ...rest } = request;
        await record({
          number,
          op: 'open',
          ...rest,
          ...(draft !== undefined && { draft }),
          ...(from && { job: from.job, event: from.event }),
          sha,
        });
        await git(['update-ref', `refs/pull/${number}/head`, sha]);
        return { number, url: url(number), ...rest, state: 'open', head: sha, ...(from && { origin: from }) };
      }),
    refresh: number =>
      serial(async () => {
        const pull = (await all()).find(p => p.number === number);
        const into = pull?.state === 'open' ? await tip(pull.into) : undefined;
        if (!pull?.head || !into) return false;
        if ((await git(['merge-base', '--is-ancestor', into, pull.head])).code === 0) return false;
        const merged = await mergeTree(pull.head, into);
        if (merged.code !== 0) return false;
        const tree = merged.stdout.split('\n')[0] ?? '';
        const message = `Merge ${pull.into} into ${pull.branch}`;
        const { stdout: sha } = await git(['commit-tree', tree, '-p', pull.head, '-p', into, '-m', message], botEnv);
        return (await git(['update-ref', `refs/heads/${pull.branch}`, sha, pull.head])).code === 0;
      }),
    merge: (number, expected) =>
      serial(async () => {
        const pull = (await all()).find(p => p.number === number);
        if (!pull) throw new Error(`no merge request #${number}`);
        if (pull.state !== 'open') throw new Error(`merge request #${number} is ${pull.state}`);
        if ((await tip(pull.into)) !== expected.into)
          throw new Error(`"${pull.into}" moved since the merge was checked`);
        if (pull.head !== expected.head) throw new Error(`"${pull.branch}" moved since the merge was checked`);
        const merged = await mergeTree(expected.into, expected.head);
        if (merged.code !== 0)
          throw new Error(`merge request #${number} conflicts: ${merged.stdout.split('\n').slice(1).join(', ')}`);
        const tree = merged.stdout.split('\n')[0] ?? '';
        const message = `Merge request #${number} from ${pull.branch}\n\n${pull.title}`;
        const { stdout: sha } = await git(
          ['commit-tree', tree, '-p', expected.into, '-p', expected.head, '-m', message],
          botEnv
        );
        await git(['update-ref', `refs/heads/${pull.into}`, sha, expected.into]);
        await record({ number, op: 'merge', sha, 'into-sha': expected.into });
        return { sha };
      }),
  };

  const event = (pull: Pull, action: string, id: string): BotEvent | undefined => {
    const user = { login: 'bothub[bot]' };
    return toEvent('pull_request', id, {
      action,
      repository: { full_name: repo },
      sender: user,
      pull_request: {
        number: pull.number,
        html_url: pull.url,
        body: pull.body,
        user,
        author_association: 'NONE',
        base: { ref: pull.into },
      },
    });
  };

  /** A comment as GitHub would deliver it: `issue_comment` on the request, or `pull_request_review_comment` on a line. */
  const commentEvent = (pull: Pull, comment: PullComment, id: string): BotEvent | undefined => {
    const user = { login: comment.author };
    const association = comment.author.endsWith('[bot]') ? 'NONE' : 'OWNER';
    const item = { number: pull.number, html_url: pull.url, body: pull.body, user, author_association: association };
    const said = { body: comment.body, html_url: comment.url ?? pull.url, author_association: association };
    const common = { action: 'created', repository: { full_name: repo }, sender: user, comment: said };
    return comment.path
      ? toEvent('pull_request_review_comment', id, {
          ...common,
          pull_request: { ...item, base: { ref: pull.into } },
        })
      : toEvent('issue_comment', id, { ...common, issue: { ...item, pull_request: {} } });
  };

  const events = () =>
    serial(async () => {
      for (const pull of fold(await ops(), url)) {
        const head = pull.state === 'open' ? await tip(pull.branch) : undefined;
        if (!head || head === pull.head) continue;
        await record({ number: pull.number, op: 'update', sha: head });
        await git(['update-ref', `refs/pull/${pull.number}/head`, head]);
      }
      const log = await ops();
      return fold(log, url).flatMap(pull => {
        const id = `local-pull-${pull.number}`;
        const found = [
          event(pull, 'opened', `${id}-opened`),
          ...pull.shas.slice(1).map(sha => event(pull, 'synchronize', `${id}-synchronize-${sha.slice(0, 12)}`)),
          pull.state === 'merged' ? event(pull, 'closed', `${id}-closed`) : undefined,
          ...commentsIn(log, pull.number, url).map((comment, i) =>
            commentEvent(pull, comment, `${id}-comment-${i + 1}`)
          ),
        ];
        return found.filter(e => e !== undefined).map(e => ({ ...e, source: 'local' as const }));
      });
    });

  const comment = (number: number, said: Omit<PullComment, 'ts' | 'url'>) =>
    serial(() => commentOn(file, number, said));

  return { ...pulls, events, comment };
};
