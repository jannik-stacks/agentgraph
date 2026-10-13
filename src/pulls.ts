import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { GitHub, GitHubError } from './github-app.ts';
import { toEvent } from './github.ts';
import type { Proposal } from './outputs.ts';
import type { BotEvent } from './types.ts';
import { botEnv } from './workspace.ts';

const exec = promisify(execFile);

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

export type PullFilter = { branch?: string; into?: string; state?: Pull['state'] | 'all' };

export type NewPull = Omit<Extract<Proposal, { kind: 'merge-request' }>, 'kind' | 'into'> &
  Pick<Pull, 'into' | 'origin'>;

/**
 * Merge requests behind one interface. `list` returns open requests unless `state` says otherwise; `get` adds whether
 * the request merges cleanly. `open` creates `into` from the default branch when it does not exist yet. `merge` lands
 * a request only while `into` and the branch are still at the commits in `expected`, and throws otherwise.
 */
export type Pulls = {
  defaultBranch: () => Promise<string>;
  list: (filter?: PullFilter) => Promise<Pull[]>;
  get: (number: number) => Promise<(Pull & { mergeable?: boolean }) | undefined>;
  open: (request: NewPull) => Promise<Pull>;
  merge: (number: number, expected: { head: string; into: string }) => Promise<{ sha: string }>;
};

const matches = (pull: Pull, { branch, into, state = 'open' }: PullFilter) =>
  (state === 'all' || pull.state === state) &&
  (branch === undefined || pull.branch === branch) &&
  (into === undefined || pull.into === into);

const originMarker = /<!-- bothub:request (\S+) (\S+) -->/;

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
  const get = async (number: number) => {
    const found = await gh<RestPull>('GET', `/repos/${repo}/pulls/${number}`).catch(notFound);
    return found && toPull(found);
  };
  return {
    defaultBranch,
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
    open: async ({ branch, into, title, body, draft, origin }) => {
      if (!(await ref(into))) {
        const from = await ref(await defaultBranch());
        if (!from) throw new Error('the default branch has no commit to start from');
        await gh('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${into}`, sha: from.object.sha });
      }
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
type Op =
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
  | { number: number; op: 'merge'; sha: string; 'into-sha': string };

/** A local request with every commit its branch was at, in order. */
type Folded = Pull & { head: string; shas: string[] };

const fold = (ops: Op[], url: (number: number) => string) => {
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
 * events (opened, synchronize, closed) of every request in `repo`, with ids that stay the same each time.
 */
export const localPulls = ({ origin, file, repo }: { origin: string; file: string; repo: string }) => {
  const git = async (args: string[], env: Record<string, string> = {}) => {
    try {
      const { stdout } = await exec('git', ['-C', origin, ...args], { env: { ...process.env, ...env } });
      return { code: 0, stdout: stdout.trim() };
    } catch (e) {
      const { code, stdout, stderr } = e as { code?: number; stdout?: string; stderr?: string };
      if (typeof code === 'number' && code === 1) return { code, stdout: stdout?.trim() ?? '', stderr };
      throw new Error(`git ${args.join(' ')} failed: ${stderr?.trim() || (e as Error).message}`);
    }
  };
  const tip = async (branch: string) => {
    const { code, stdout } = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    return code === 0 && stdout ? stdout : undefined;
  };
  const url = (number: number) => `${origin}#pull/${number}`;
  const ops = async () =>
    (await readFile(file, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Op);
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

  const pulls: Pulls = {
    defaultBranch,
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
        if (!(await tip(request.into))) {
          const from = await tip(await defaultBranch());
          if (!from) throw new Error('the default branch has no commit to start from');
          await git(['update-ref', `refs/heads/${request.into}`, from, '']);
        }
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

  const events = () =>
    serial(async () => {
      for (const pull of fold(await ops(), url)) {
        const head = pull.state === 'open' ? await tip(pull.branch) : undefined;
        if (!head || head === pull.head) continue;
        await record({ number: pull.number, op: 'update', sha: head });
        await git(['update-ref', `refs/pull/${pull.number}/head`, head]);
      }
      return fold(await ops(), url).flatMap(pull => {
        const id = `local-pull-${pull.number}`;
        const found = [
          event(pull, 'opened', `${id}-opened`),
          ...pull.shas.slice(1).map(sha => event(pull, 'synchronize', `${id}-synchronize-${sha.slice(0, 12)}`)),
          pull.state === 'merged' ? event(pull, 'closed', `${id}-closed`) : undefined,
        ];
        return found.filter(e => e !== undefined).map(e => ({ ...e, source: 'local' as const }));
      });
    });

  return { ...pulls, events };
};

export type LocalPulls = ReturnType<typeof localPulls>;
