import { createPrivateKey, sign } from 'node:crypto';
import { Effect, Layer, Redacted, Stream } from 'effect';
import {
  commanded,
  Forge,
  ForgeError,
  type Applied,
  type Comment,
  type Message,
  type Proposal,
  type Thread,
} from './forge.ts';
import { hostGit, type Work } from './sandbox.ts';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type User = { login: string; type?: string } | null | undefined;
type RestIssue = {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  labels: (string | { name?: string })[];
  user?: User;
  html_url: string;
  pull_request?: { merged_at?: string | null } | null;
};
type RestPull = {
  number: number;
  merged_at?: string | null;
  head: { ref: string; sha: string; repo?: { full_name: string } | null };
  base: { ref: string; sha?: string };
};
type RestComment = {
  id: number;
  body?: string | null;
  user?: User;
  author_association: string;
  created_at: string;
  html_url: string;
  issue_url?: string;
  pull_request_url?: string;
  path?: string;
  line?: number | null;
  in_reply_to_id?: number;
};
type RestEvent = {
  event: string;
  actor?: User;
  created_at: string;
  issue?: { number: number };
  label?: { name: string };
};
type RestCommit = {
  sha: string;
  author?: User;
  commit: { message: string; author?: { name?: string; date?: string } | null };
};
type RestCheck = {
  name: string;
  status: string;
  conclusion?: string | null;
  completed_at?: string | null;
  started_at?: string | null;
  app?: { slug?: string } | null;
};
type RestStatus = { context: string; state: string; updated_at: string; creator?: User };
type RestReview = {
  id: number;
  state: string;
  body?: string | null;
  user?: User;
  author_association: string;
  submitted_at?: string | null;
};

const api = 'https://api.github.com';
const members = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const writers = new Set(['admin', 'maintain', 'write']);
/** Statuses that mean GitHub refused a proposal, as opposed to failing. */
const refusals = new Set([404, 405, 409, 422]);

const hidden =
  /<!--[\s\S]*?(?:-->|$)|\u034f|[\u{e0100}-\u{e01ef}]|[\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\u{e0000}-\u{e007f}]/gu;

/** Text as a reader sees it on GitHub: no HTML comments (an unclosed one hides the rest), no invisible characters. */
const visible = (text: string | null | undefined) => (text ?? '').replace(hidden, '');

const login = (user: User) => user?.login ?? 'ghost';
const isBot = (user: User) => user?.type === 'Bot' || login(user).endsWith('[bot]');
const numberIn = (url = '') => Number(/\/(\d+)$/.exec(url)?.[1]);

/** An RS256 JWT that authenticates as the App for ten minutes. */
const appJwt = (id: string, pem: string, now: number) => {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'rsa') throw new Error('the GitHub App key must be an RSA private key');
  const iat = Math.floor(now / 1000) - 60;
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat, exp: iat + 600, iss: id })}`;
  return `${input}.${sign('sha256', Buffer.from(input), key).toString('base64url')}`;
};

const git = (work: Work, args: string[]) =>
  Effect.mapError(hostGit(work.git, args), e => new ForgeError({ message: e.detail }));
const gitText = (work: Work, args: string[]) => Effect.map(git(work, args), out => out.toString('utf8').trim());

/** The branches a push may move, the files it may change at most, and the largest file it may write. */
const pushable = { prefix: 'bothub/', files: 200, bytes: 1 << 20 };

/** Why a changed path may not be pushed, if it may not: links, submodules, workflows and git's own files. */
const unpushable = (path: string, modes: string[]) =>
  modes.some(mode => !['100644', '100755', '000000'].includes(mode))
    ? `${path} has mode ${modes.join(' to ')}; only regular files can be pushed`
    : /^\.github\//i.test(path) || /(^|\/)\.git(\/|$)/i.test(path)
      ? `${path} is under .github/ or .git/`
      : path === '.bothub/news.md'
        ? `${path} is the runner's news file`
        : undefined;

const refPath = (branch: string) =>
  branch.split('/').some(part => !part || part === '.' || part === '..')
    ? Effect.fail(new ForgeError({ status: 422, message: `invalid branch "${branch}"` }))
    : Effect.succeed(`heads/${branch.split('/').map(encodeURIComponent).join('/')}`);

/** A GitHub REST call with `auth` as the bearer; GETs are polled with ETags, so an unchanged answer is a free 304. */
const requester = (fetch: Fetch) => {
  const etags = new Map<string, { etag: string; data: unknown; next?: string }>();
  return <T>(method: string, path: string, auth: string, body?: unknown) =>
    Effect.gen(function* () {
      const url = path.startsWith('https://') ? path : api + path;
      const cached = method === 'GET' ? etags.get(url) : undefined;
      const res = yield* Effect.tryPromise({
        try: async () => {
          const res = await fetch(url, {
            method,
            headers: {
              Accept: 'application/vnd.github+json',
              Authorization: `Bearer ${auth}`,
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'bothub',
              ...(cached && { 'If-None-Match': cached.etag }),
              ...(body !== undefined && { 'Content-Type': 'application/json' }),
            },
            ...(body !== undefined && { body: JSON.stringify(body) }),
          });
          return { status: res.status, ok: res.ok, headers: res.headers, text: await res.text() };
        },
        catch: e => new ForgeError({ message: `GitHub ${method} ${path}: ${String(e)}` }),
      });
      if (res.status === 304 && cached) return cached as { data: T; next?: string };
      if (!res.ok) {
        const message = `GitHub ${method} ${path} failed with ${res.status}: ${res.text.slice(0, 200)}`;
        return yield* new ForgeError({ status: res.status, message });
      }
      const data = yield* Effect.try({
        try: () => (res.text ? JSON.parse(res.text) : undefined) as T,
        catch: () => new ForgeError({ message: `GitHub ${method} ${path} answered with invalid JSON` }),
      });
      const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
      const out = { data, ...(next && { next }) };
      const etag = res.headers.get('etag');
      if (method === 'GET' && etag) etags.set(url, { etag, ...out });
      return out;
    });
};

/** The permissions each kind of call needs; every token is also limited to the one repository (`repos` has none). */
const scopes = {
  read: { contents: 'read', issues: 'read', pull_requests: 'read' },
  checks: { checks: 'read', statuses: 'read' },
  comment: { issues: 'write', pull_requests: 'write' },
  push: { contents: 'write' },
  pull: { contents: 'read', pull_requests: 'write' },
  merge: { contents: 'write', pull_requests: 'write' },
  repos: { metadata: 'read' },
} as const;
export type Scope = keyof typeof scopes;

/** Mints installation tokens for the App, one per scope, reusing a token until a minute before it expires. */
export const appToken = (
  app: { repo: string; id: string; key: Redacted.Redacted },
  fetch: Fetch = globalThis.fetch
): ((scope: Scope) => Effect.Effect<string, ForgeError>) => {
  const request = requester(fetch);
  const tokens = new Map<Scope, { value: string; expires: number }>();
  const minting = Effect.unsafeMakeSemaphore(1);
  return scope =>
    minting.withPermits(1)(
      Effect.suspend(() => {
        const token = tokens.get(scope);
        if (token && token.expires - 60_000 > Date.now()) return Effect.succeed(token.value);
        return Effect.gen(function* () {
          const signed = yield* appSigned(app);
          const { data: installation } = yield* request<{ id: number }>(
            'GET',
            `/repos/${app.repo}/installation`,
            signed
          );
          const { data } = yield* request<{ token: string; expires_at: string }>(
            'POST',
            `/app/installations/${installation.id}/access_tokens`,
            signed,
            { permissions: scopes[scope], ...(scope !== 'repos' && { repositories: [app.repo.split('/')[1]] }) }
          );
          tokens.set(scope, { value: data.token, expires: Date.parse(data.expires_at) });
          return data.token;
        });
      })
    );
};

const appSigned = (app: { id: string; key: Redacted.Redacted }) =>
  Effect.try({
    try: () => appJwt(app.id, Redacted.value(app.key), Date.now()),
    catch: e => new ForgeError({ message: (e as Error).message }),
  });

/**
 * The repo of one GitHub App installation. Reads poll fixed URLs with ETags, so an unchanged answer is a free 304.
 * Comments and reviews from anyone but owners, members and collaborators are withheld, and every text is stripped
 * to what a reader sees. Pushes go through the Git data API, so GitHub signs the commits and the branch only moves
 * forward.
 */
export const githubForge = (
  app: { repo: string; id: string; key: Redacted.Redacted },
  fetch: Fetch = globalThis.fetch,
  token: (scope: Scope) => Effect.Effect<string, ForgeError> = appToken(app, fetch)
): Layer.Layer<Forge> =>
  Layer.sync(Forge, () => {
    const repo = `/repos/${app.repo}`;
    let slug: string | undefined;

    const request = requester(fetch);
    const jwt = appSigned(app);

    const me = Effect.suspend(() =>
      slug !== undefined
        ? Effect.succeed(slug)
        : Effect.flatMap(jwt, signed => request<{ slug: string }>('GET', '/app', signed)).pipe(
            Effect.map(({ data }) => (slug = data.slug))
          )
    );

    const gh = <T>(method: string, path: string, body?: unknown, scope: Scope = 'read') =>
      Effect.flatMap(token(scope), t => request<T>(method, path, t, body)).pipe(Effect.map(r => r.data));

    const missing = <A, R>(effect: Effect.Effect<A, ForgeError, R>) =>
      Effect.catchIf(
        effect,
        e => e.status === 404,
        () => Effect.succeed(undefined)
      );

    /** Every page of a list, following `next` while `more` holds for the last page. */
    const all = <T>(path: string, more: (page: T[]) => boolean = () => true) =>
      Effect.gen(function* () {
        const items: T[] = [];
        let url: string | undefined = path;
        while (url) {
          const page: { data: T[]; next?: string } = yield* Effect.flatMap(token('read'), t =>
            request<T[]>('GET', url!, t)
          );
          items.push(...page.data);
          url = more(page.data) ? page.next : undefined;
        }
        return items;
      });

    const toThread = (i: RestIssue, pull?: RestPull, parent?: number): Thread => {
      const own = pull?.head.repo?.full_name === app.repo;
      return {
        number: i.number,
        title: visible(i.title),
        body: visible(i.body),
        state: i.pull_request?.merged_at || pull?.merged_at ? 'merged' : i.state,
        labels: i.labels.map(l => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
        author: login(i.user),
        ...(parent !== undefined && { parent }),
        ...(pull && {
          pull: {
            branch: own ? pull.head.ref : `${pull.head.repo?.full_name ?? 'unknown'}:${pull.head.ref}`,
            into: pull.base.ref,
            head: pull.head.sha,
            ...(pull.base.sha && { base: pull.base.sha }),
          },
        }),
        url: i.html_url,
      };
    };

    const withheld = (author: string) => `(comment by @${author} withheld: not a collaborator)`;

    const toComment = (c: RestComment, self: string): Comment => {
      const author = login(c.user);
      const shown = members.has(c.author_association) || author === `${self}[bot]`;
      return {
        id: String(c.id),
        author,
        body: shown ? visible(c.body) : withheld(author),
        at: c.created_at,
        ...(c.path !== undefined && { path: c.path }),
        ...(typeof c.line === 'number' && { line: c.line }),
        ...(c.in_reply_to_id !== undefined && { under: String(c.in_reply_to_id) }),
      };
    };

    const heard = (thread: number, c: RestComment, self: string, kind: Message['kind'] = 'comment'): Message => {
      const comment = toComment(c, self);
      const trusted = members.has(c.author_association) && !isBot(c.user);
      return { thread, kind, actor: comment.author, trusted, at: c.created_at, comment };
    };

    /** A review as a message: its verdict, or a comment when it only has a body; undefined for an empty comment. */
    const reviewed = (thread: number, r: RestReview, self: string): Message | undefined => {
      const kind = r.state === 'APPROVED' ? 'approved' : r.state === 'CHANGES_REQUESTED' ? 'changes' : 'comment';
      if (!r.submitted_at || (kind === 'comment' && !visible(r.body).trim())) return undefined;
      return heard(thread, { ...r, created_at: r.submitted_at, html_url: '' }, self, kind);
    };

    const kinds: Record<string, Message['kind']> = {
      merged: 'merged',
      closed: 'closed',
      labeled: 'label',
      unlabeled: 'unlabel',
    };
    /** An issue event as a message, trusted when its actor may write; undefined for events that say nothing here. */
    const evented = (thread: number, e: RestEvent, merged: boolean) =>
      Effect.gen(function* () {
        const kind = kinds[e.event];
        if (!kind || (kind === 'closed' && merged) || ((kind === 'label' || kind === 'unlabel') && !e.label))
          return undefined;
        return {
          thread,
          kind,
          actor: login(e.actor),
          trusted: yield* permitted(e.actor),
          at: e.created_at,
          ...(e.label && { label: e.label.name }),
        } satisfies Message;
      });

    const listState = (state?: Thread['state']) => (state === undefined ? 'all' : state === 'open' ? 'open' : 'closed');

    const threads: Forge['Type']['threads'] = (filter = {}) =>
      Effect.gen(function* () {
        const { state, labels = [], parent } = filter;
        const query = new URLSearchParams({
          state: listState(state),
          per_page: '100',
          ...(labels.length > 0 && { labels: labels.join(',') }),
        });
        const issues =
          parent === undefined
            ? yield* all<RestIssue>(`${repo}/issues?${query}`)
            : yield* all<RestIssue>(`${repo}/issues/${parent}/sub_issues?per_page=100`);
        const pulls = issues.some(i => i.pull_request)
          ? yield* all<RestPull>(`${repo}/pulls?state=${listState(state)}&per_page=100`)
          : [];
        const byNumber = new Map(pulls.map(p => [p.number, p]));
        return issues
          .map(i => toThread(i, byNumber.get(i.number), parent))
          .filter(t => (state === undefined || t.state === state) && labels.every(l => t.labels.includes(l)));
      });

    /** The checks and statuses on a commit: name and conclusion only. Without the permission to read them, none. */
    const checked = (thread: number, sha: string) =>
      Effect.all([
        gh<{ check_runs: RestCheck[] }>('GET', `${repo}/commits/${sha}/check-runs?per_page=100`, undefined, 'checks'),
        gh<{ statuses: RestStatus[] }>('GET', `${repo}/commits/${sha}/status`, undefined, 'checks'),
      ]).pipe(
        Effect.map(([runs, status]): Message[] => [
          ...runs.check_runs.map(c => ({
            thread,
            kind: 'check' as const,
            actor: c.app?.slug ?? 'checks',
            trusted: false,
            at: c.completed_at ?? c.started_at ?? '',
            check: { name: visible(c.name), conclusion: c.conclusion ?? c.status },
          })),
          ...status.statuses.map(s => ({
            thread,
            kind: 'check' as const,
            actor: login(s.creator),
            trusted: false,
            at: s.updated_at,
            check: { name: visible(s.context), conclusion: s.state },
          })),
        ]),
        Effect.catchIf(
          e => e.status === 403 || e.status === 404 || e.status === 422,
          () => Effect.succeed([])
        )
      );

    const thread: Forge['Type']['thread'] = number =>
      Effect.gen(function* () {
        const self = yield* me;
        const issue = yield* gh<RestIssue>('GET', `${repo}/issues/${number}`);
        const isPull = !!issue.pull_request;
        const none = Effect.succeed([]);
        const [said, parent, pull, lined, reviews, commits, events] = yield* Effect.all(
          [
            all<RestComment>(`${repo}/issues/${number}/comments?per_page=100`),
            missing(gh<RestIssue>('GET', `${repo}/issues/${number}/parent`)),
            isPull ? gh<RestPull>('GET', `${repo}/pulls/${number}`) : Effect.succeed(undefined),
            isPull ? all<RestComment>(`${repo}/pulls/${number}/comments?per_page=100`) : none,
            isPull ? all<RestReview>(`${repo}/pulls/${number}/reviews?per_page=100`) : none,
            isPull ? all<RestCommit>(`${repo}/pulls/${number}/commits?per_page=100`) : none,
            all<RestEvent>(`${repo}/issues/${number}/events?per_page=100`),
          ],
          { concurrency: 'unbounded' }
        );
        const merged = events.some(e => e.event === 'merged');
        const messages: Message[] = [
          ...[...said, ...lined].map(c => heard(number, c, self)),
          ...reviews.flatMap(r => reviewed(number, r, self) ?? []),
          ...commits.map(c => ({
            thread: number,
            kind: 'commit' as const,
            actor: c.author ? login(c.author) : (c.commit.author?.name ?? 'ghost'),
            trusted: false,
            at: c.commit.author?.date ?? '',
            commit: { sha: c.sha, title: visible(c.commit.message.split('\n')[0]) },
          })),
          ...(yield* Effect.forEach(events, e => evented(number, e, merged))).flatMap(m => m ?? []),
          ...(pull ? yield* checked(number, pull.head.sha) : []),
        ];
        return {
          ...toThread(issue, pull, parent?.number),
          messages: messages.sort((a, b) => a.at.localeCompare(b.at)),
        };
      });

    const permitted = (user: User) =>
      isBot(user)
        ? Effect.succeed(false)
        : missing(
            gh<{ permission?: string; role_name?: string }>(
              'GET',
              `${repo}/collaborators/${encodeURIComponent(login(user))}/permission`
            )
          ).pipe(
            Effect.map(found => [found?.role_name, found?.permission].some(r => r !== undefined && writers.has(r)))
          );

    const since: Forge['Type']['since'] = cursor =>
      Stream.fromIterableEffect(
        Effect.gen(function* () {
          const self = yield* me;
          const after = (at?: string | null): at is string => !!at && at > cursor;
          const from = cursor ? `since=${encodeURIComponent(cursor)}&` : '';
          const window = `${from}sort=updated&direction=asc&per_page=100`;
          const [said, lined, events, open] = yield* Effect.all(
            [
              all<RestComment>(`${repo}/issues/comments?${window}`),
              all<RestComment>(`${repo}/pulls/comments?${window}`),
              all<RestEvent>(`${repo}/issues/events?per_page=100`, page => after(page.at(-1)?.created_at)),
              all<RestPull>(`${repo}/pulls?state=open&per_page=100`),
            ],
            { concurrency: 'unbounded' }
          );
          const reviews = yield* Effect.forEach(
            open,
            p =>
              Effect.map(all<RestReview>(`${repo}/pulls/${p.number}/reviews?per_page=100`), rs =>
                rs.map(r => ({ ...r, thread: p.number }))
              ),
            { concurrency: 4 }
          );

          const messages: Message[] = [];
          for (const c of said) if (after(c.created_at)) messages.push(heard(numberIn(c.issue_url), c, self));
          for (const c of lined) if (after(c.created_at)) messages.push(heard(numberIn(c.pull_request_url), c, self));
          for (const r of reviews.flat()) {
            const m = after(r.submitted_at) ? reviewed(r.thread, r, self) : undefined;
            if (m) messages.push(m);
          }
          const merged = new Set(events.filter(e => e.event === 'merged').map(e => e.issue?.number));
          for (const e of events) {
            const m =
              after(e.created_at) && e.issue
                ? yield* evented(e.issue.number, e, merged.has(e.issue.number))
                : undefined;
            if (m) messages.push(m);
          }
          for (const m of messages)
            if (m.trusted && m.comment) m.comment = { ...m.comment, body: commanded(m.comment.body, self) };
          return messages.sort((a, b) => a.at.localeCompare(b.at));
        })
      );

    /** The last commit pushed from each checkout and its tree; the next push from it builds on that commit. */
    const pushed = new Map<string, { sha: string; tree: string }>();
    const refuse = (message: string) => new ForgeError({ status: 422, message });

    /**
     * Commits the checkout's files on top of its base, or of its last push, through the Git data API, then moves
     * `branch` forward to that commit. Only regular files outside `.github/` and `.git/` are pushed, within the limits.
     */
    const push = (work: Work, branch: string, message: string) =>
      Effect.gen(function* () {
        if (!branch.startsWith(pushable.prefix)) return yield* refuse(`a push goes to a ${pushable.prefix} branch`);
        const ref = yield* refPath(branch);
        const last = pushed.get(work.dir);
        const parent = last?.sha ?? work.base;
        const tip = (yield* missing(gh<{ object: { sha: string } }>('GET', `${repo}/git/ref/${ref}`)))?.object.sha;
        if (tip && tip !== parent) return yield* refuse(`${branch} is at ${tip}, the checkout builds on ${parent}`);
        const from = last?.tree ?? (yield* gitText(work, ['rev-parse', `${parent}^{tree}`]));
        yield* git(work, ['add', '-A']);
        const tree = yield* gitText(work, ['write-tree']);
        let head = parent;
        if (tree !== from) {
          const changed = yield* entries(work, from, tree);
          const made = (yield* gh<{ sha: string }>(
            'POST',
            `${repo}/git/trees`,
            { base_tree: from, tree: changed },
            'push'
          )).sha;
          if (made !== tree) return yield* new ForgeError({ message: `GitHub built tree ${made}, expected ${tree}` });
          const commit = { message, tree, parents: [parent] };
          head = (yield* gh<{ sha: string }>('POST', `${repo}/git/commits`, commit, 'push')).sha;
        }
        if (head === tip) return head;
        if (tip) yield* gh('PATCH', `${repo}/git/refs/${ref}`, { sha: head, force: false }, 'push');
        else yield* gh('POST', `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: head }, 'push');
        pushed.set(work.dir, { sha: head, tree });
        return head;
      });

    /** The tree entries that turn tree `from` into `to`, uploading each changed blob once every change passed. */
    const entries = (work: Work, from: string, to: string) =>
      Effect.gen(function* () {
        const fields = (yield* git(work, ['diff-tree', '-r', '-z', '--no-renames', '--no-abbrev', from, to]))
          .toString('utf8')
          .split('\0');
        const changes: { path: string; mode: string; sha: string | null; content?: Buffer }[] = [];
        const problems: string[] = [];
        for (let i = 0; i + 1 < fields.length; i += 2) {
          const [oldMode, newMode, oldSha, newSha] = fields[i]!.slice(1).split(' ') as [string, string, string, string];
          const path = fields[i + 1]!;
          const problem = unpushable(path, [oldMode, newMode]);
          if (problem) problems.push(problem);
          else if (newMode === '000000') changes.push({ path, mode: oldMode, sha: null });
          else if (oldSha === newSha) changes.push({ path, mode: newMode, sha: newSha });
          else {
            const content = yield* git(work, ['cat-file', 'blob', newSha]);
            if (content.length > pushable.bytes) problems.push(`${path} is over ${pushable.bytes} bytes`);
            else changes.push({ path, mode: newMode, sha: newSha, content });
          }
        }
        if (changes.length + problems.length > pushable.files)
          problems.push(`${changes.length + problems.length} files changed, at most ${pushable.files} can be pushed`);
        if (problems.length) return yield* refuse(`refused to push: ${problems.join('; ')}`);
        for (const { path, sha, content } of changes) {
          if (!content) continue;
          const stored = yield* gh<{ sha: string }>(
            'POST',
            `${repo}/git/blobs`,
            { content: content.toString('base64'), encoding: 'base64' },
            'push'
          );
          if (stored.sha !== sha)
            return yield* new ForgeError({ message: `GitHub stored ${path} as ${stored.sha}, expected ${sha}` });
        }
        return changes.map(({ path, mode, sha }) => ({ path, mode, type: 'blob' as const, sha }));
      });

    const comment = (number: number, body: string, edit?: string) =>
      Effect.map(
        edit === undefined
          ? gh<{ id: number; html_url: string }>('POST', `${repo}/issues/${number}/comments`, { body }, 'comment')
          : gh<{ id: number; html_url: string }>('PATCH', `${repo}/issues/comments/${edit}`, { body }, 'comment'),
        c => ({ url: c.html_url, id: String(c.id) })
      );

    const act = (
      number: number,
      p: Proposal,
      work?: Work
    ): Effect.Effect<{ url?: string; id?: string }, ForgeError> => {
      switch (p.kind) {
        case 'reply':
          return p.under === undefined
            ? comment(number, p.body, p.edit)
            : Effect.map(
                gh<{ id: number; html_url: string }>(
                  'POST',
                  `${repo}/pulls/${number}/comments/${p.under}/replies`,
                  { body: p.body },
                  'comment'
                ),
                c => ({ url: c.html_url, id: String(c.id) })
              );
        case 'ask':
          return comment(number, p.question);
        case 'react': {
          const on =
            p.comment === undefined ? `issues/${number}` : `${p.review ? 'pulls' : 'issues'}/comments/${p.comment}`;
          return Effect.as(gh('POST', `${repo}/${on}/reactions`, { content: 'eyes' }, 'comment'), {});
        }
        case 'back':
          return Effect.succeed({});
        case 'label':
          return Effect.gen(function* () {
            if (p.add?.length) yield* gh('POST', `${repo}/issues/${number}/labels`, { labels: p.add }, 'comment');
            for (const name of p.remove ?? [])
              yield* missing(
                gh('DELETE', `${repo}/issues/${number}/labels/${encodeURIComponent(name)}`, undefined, 'comment')
              );
            return {};
          });
        case 'push':
          if (work === undefined) return Effect.fail(refuse('push needs a checkout'));
          return Effect.map(push(work, p.branch, p.message), head => ({
            url: `https://github.com/${app.repo}/commit/${head}`,
          }));
        case 'pull':
          return Effect.map(
            gh<{ html_url: string }>(
              'POST',
              `${repo}/pulls`,
              {
                title: p.title,
                head: p.branch,
                base: p.into,
                body: p.body,
              },
              'pull'
            ),
            r => ({ url: r.html_url })
          );
        case 'merge':
          return Effect.as(gh('PUT', `${repo}/pulls/${p.number}/merge`, { sha: p.head }, 'merge'), {});
        case 'issue':
          return Effect.gen(function* () {
            const made = yield* gh<{ id: number; html_url: string }>(
              'POST',
              `${repo}/issues`,
              {
                title: p.title,
                body: p.body,
              },
              'comment'
            );
            if (p.parent !== undefined)
              yield* gh('POST', `${repo}/issues/${p.parent}/sub_issues`, { sub_issue_id: made.id }, 'comment');
            return { url: made.html_url };
          });
      }
    };

    const apply: Forge['Type']['apply'] = (number, proposal, work) =>
      act(number, proposal, work).pipe(
        Effect.map((done): Applied => ({ proposal, ok: true, ...done })),
        Effect.catchIf(
          e => e.status !== undefined && refusals.has(e.status),
          e => Effect.succeed<Applied>({ proposal, ok: false, reason: e.message })
        )
      );

    return { threads, thread, since, apply };
  });
