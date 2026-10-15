import { execFile } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { Effect, Layer, Redacted, Stream } from 'effect';
import { Forge, ForgeError, type Applied, type Comment, type Message, type Proposal, type Thread } from './forge.ts';

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
  base: { ref: string };
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
};
type RestEvent = {
  event: string;
  actor?: User;
  created_at: string;
  issue: { number: number };
  label?: { name: string };
};
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

/** The text after `/bothub` or `@<slug>` written as a word outside quoted lines and fenced code. */
const commanded = (body: string, slug: string): string | undefined => {
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
      return body
        .slice(start + found.index + found[0].length)
        .replace(/^[,:]/, '')
        .trim();
  }
};

/** An RS256 JWT that authenticates as the App for ten minutes. */
const appJwt = (id: string, pem: string, now: number) => {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'rsa') throw new Error('the GitHub App key must be an RSA private key');
  const iat = Math.floor(now / 1000) - 60;
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat, exp: iat + 600, iss: id })}`;
  return `${input}.${sign('sha256', Buffer.from(input), key).toString('base64url')}`;
};

const git = (dir: string, args: string[]) =>
  Effect.async<Buffer, ForgeError>(resume => {
    execFile(
      'git',
      ['-C', dir, ...args],
      { encoding: 'buffer', maxBuffer: 256 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) =>
        resume(
          error
            ? Effect.fail(
                new ForgeError({ message: `git ${args[0]} failed: ${stderr.toString().trim() || error.message}` })
              )
            : Effect.succeed(stdout)
        )
    );
  });
const gitText = (dir: string, args: string[]) => Effect.map(git(dir, args), out => out.toString('utf8').trim());

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

/** Mints installation tokens for the App on `app.repo`, one at a time, reusing a token until a minute before it expires. */
export const appToken = (
  app: { repo: string; id: string; key: Redacted.Redacted },
  fetch: Fetch = globalThis.fetch
): Effect.Effect<string, ForgeError> => {
  const request = requester(fetch);
  let token: { value: string; expires: number } | undefined;
  const minting = Effect.unsafeMakeSemaphore(1);
  return minting.withPermits(1)(
    Effect.suspend(() => {
      if (token && token.expires - 60_000 > Date.now()) return Effect.succeed(token.value);
      return Effect.gen(function* () {
        const signed = yield* appSigned(app);
        const { data: installation } = yield* request<{ id: number }>('GET', `/repos/${app.repo}/installation`, signed);
        const { data } = yield* request<{ token: string; expires_at: string }>(
          'POST',
          `/app/installations/${installation.id}/access_tokens`,
          signed
        );
        token = { value: data.token, expires: Date.parse(data.expires_at) };
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
  token: Effect.Effect<string, ForgeError> = appToken(app, fetch)
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

    const gh = <T>(method: string, path: string, body?: unknown) =>
      Effect.flatMap(token, t => request<T>(method, path, t, body)).pipe(Effect.map(r => r.data));

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
          const page: { data: T[]; next?: string } = yield* Effect.flatMap(token, t => request<T[]>('GET', url!, t));
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
      };
    };

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

    const thread: Forge['Type']['thread'] = number =>
      Effect.gen(function* () {
        const self = yield* me;
        const issue = yield* gh<RestIssue>('GET', `${repo}/issues/${number}`);
        const isPull = !!issue.pull_request;
        const [said, parent, pull, lined] = yield* Effect.all(
          [
            all<RestComment>(`${repo}/issues/${number}/comments?per_page=100`),
            missing(gh<RestIssue>('GET', `${repo}/issues/${number}/parent`)),
            isPull ? gh<RestPull>('GET', `${repo}/pulls/${number}`) : Effect.succeed(undefined),
            isPull ? all<RestComment>(`${repo}/pulls/${number}/comments?per_page=100`) : Effect.succeed([]),
          ],
          { concurrency: 'unbounded' }
        );
        const comments = [...said, ...lined].map(c => toComment(c, self)).sort((a, b) => a.at.localeCompare(b.at));
        return { ...toThread(issue, pull, parent?.number), comments };
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

          const text = (body: string | null | undefined) => {
            const shown = visible(body);
            const request = commanded(shown, self);
            return request === undefined ? shown : `/bothub ${request}`.trim();
          };
          const heard = (thread: number, c: RestComment, kind: Message['kind'] = 'comment'): Message => {
            const trusted = members.has(c.author_association) && !isBot(c.user);
            const comment = toComment(c, self);
            return {
              thread,
              kind,
              actor: comment.author,
              trusted,
              at: c.created_at,
              comment: trusted ? { ...comment, body: text(c.body) } : comment,
            };
          };

          const messages: Message[] = [];
          for (const c of said) if (after(c.created_at)) messages.push(heard(numberIn(c.issue_url), c));
          for (const c of lined) if (after(c.created_at)) messages.push(heard(numberIn(c.pull_request_url), c));
          for (const r of reviews.flat()) {
            if (!after(r.submitted_at)) continue;
            const kind = r.state === 'APPROVED' ? 'approved' : r.state === 'CHANGES_REQUESTED' ? 'changes' : 'comment';
            if (kind === 'comment' && !visible(r.body).trim()) continue;
            messages.push(heard(r.thread, { ...r, created_at: r.submitted_at, html_url: '' }, kind));
          }
          const merged = new Set(events.filter(e => e.event === 'merged').map(e => e.issue.number));
          for (const e of events) {
            if (!after(e.created_at)) continue;
            const kind =
              e.event === 'merged'
                ? 'merged'
                : e.event === 'closed' && !merged.has(e.issue.number)
                  ? 'closed'
                  : e.event === 'labeled' && e.label
                    ? 'label'
                    : undefined;
            if (!kind) continue;
            messages.push({
              thread: e.issue.number,
              kind,
              actor: login(e.actor),
              trusted: yield* permitted(e.actor),
              at: e.created_at,
              ...(kind === 'label' && { label: e.label!.name }),
            });
          }
          return messages.sort((a, b) => a.at.localeCompare(b.at));
        })
      );

    /** Replays local commits from `HEAD` back to what GitHub has, then moves `branch` forward to the result. */
    const push = (dir: string, branch: string, message: string) =>
      Effect.gen(function* () {
        const ref = yield* refPath(branch);
        if (yield* gitText(dir, ['status', '--porcelain'])) {
          yield* git(dir, ['add', '-A']);
          yield* git(dir, [
            '-c',
            'user.name=bothub',
            '-c',
            'user.email=bothub@localhost',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '-qm',
            message,
          ]);
        }
        const tip = (yield* missing(gh<{ object: { sha: string } }>('GET', `${repo}/git/ref/${ref}`)))?.object.sha;
        const remote = new Map<string, string>();
        const replay = (commit: string): Effect.Effect<string, ForgeError> =>
          Effect.gen(function* () {
            const known = remote.get(commit);
            if (known) return known;
            if (yield* missing(gh('GET', `${repo}/git/commits/${commit}`)))
              return remote.set(commit, commit).get(commit)!;
            const [tree, ...parents] = (yield* gitText(dir, ['log', '-1', '--format=%T %P', commit])).split(' ') as [
              string,
              ...string[],
            ];
            const [first] = parents;
            if (!first) return yield* new ForgeError({ message: `commit ${commit} has no parent on GitHub` });
            const onGitHub: string[] = [];
            for (const parent of parents) onGitHub.push(yield* replay(parent));
            const changed = yield* entries(dir, first, commit);
            const base = yield* gitText(dir, ['rev-parse', `${first}^{tree}`]);
            const made = changed.length
              ? (yield* gh<{ sha: string }>('POST', `${repo}/git/trees`, { base_tree: base, tree: changed })).sha
              : base;
            if (made !== tree) return yield* new ForgeError({ message: `GitHub built tree ${made}, expected ${tree}` });
            const text = (yield* git(dir, ['log', '-1', '--format=%B', commit])).toString('utf8').replace(/\n+$/, '\n');
            const { sha } = yield* gh<{ sha: string }>('POST', `${repo}/git/commits`, {
              message: text,
              tree,
              parents: onGitHub,
            });
            return remote.set(commit, sha).get(commit)!;
          });
        const head = yield* replay(yield* gitText(dir, ['rev-parse', 'HEAD']));
        if (head === tip) return head;
        if (tip) yield* gh('PATCH', `${repo}/git/refs/${ref}`, { sha: head, force: false });
        else yield* gh('POST', `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: head });
        return head;
      });

    /** The tree entries that turn `parent`'s tree into `commit`'s, uploading each changed blob. */
    const entries = (dir: string, parent: string, commit: string) =>
      Effect.gen(function* () {
        const fields = (yield* git(dir, ['diff-tree', '-r', '-z', '--no-renames', '--no-abbrev', parent, commit]))
          .toString('utf8')
          .split('\0');
        const changed: { path: string; mode: string; type: 'blob' | 'commit'; sha: string | null }[] = [];
        for (let i = 0; i + 1 < fields.length; i += 2) {
          const [oldMode, newMode, oldSha, newSha] = fields[i]!.slice(1).split(' ') as [string, string, string, string];
          const path = fields[i + 1]!;
          const type = (mode: string) => (mode === '160000' ? 'commit' : 'blob');
          if (newMode === '000000') changed.push({ path, mode: oldMode, type: type(oldMode), sha: null });
          else if (newMode === '160000' || oldSha === newSha)
            changed.push({ path, mode: newMode, type: type(newMode), sha: newSha });
          else {
            const content = (yield* git(dir, ['cat-file', 'blob', newSha])).toString('base64');
            const { sha } = yield* gh<{ sha: string }>('POST', `${repo}/git/blobs`, { content, encoding: 'base64' });
            if (sha !== newSha)
              return yield* new ForgeError({ message: `GitHub stored ${path} as ${sha}, expected ${newSha}` });
            changed.push({ path, mode: newMode, type: 'blob', sha });
          }
        }
        return changed;
      });

    const comment = (number: number, body: string) =>
      Effect.map(gh<{ html_url: string }>('POST', `${repo}/issues/${number}/comments`, { body }), c => ({
        url: c.html_url,
      }));

    const act = (number: number, p: Proposal, dir?: string): Effect.Effect<{ url?: string }, ForgeError> => {
      switch (p.kind) {
        case 'reply':
          return comment(number, p.body);
        case 'ask':
          return comment(number, p.question);
        case 'back':
          return Effect.succeed({});
        case 'label':
          return Effect.gen(function* () {
            if (p.add?.length) yield* gh('POST', `${repo}/issues/${number}/labels`, { labels: p.add });
            for (const name of p.remove ?? [])
              yield* missing(gh('DELETE', `${repo}/issues/${number}/labels/${encodeURIComponent(name)}`));
            return {};
          });
        case 'push':
          if (dir === undefined) return Effect.fail(new ForgeError({ status: 422, message: 'push needs a checkout' }));
          return Effect.map(push(dir, p.branch, p.message), head => ({
            url: `https://github.com/${app.repo}/commit/${head}`,
          }));
        case 'pull':
          return Effect.map(
            gh<{ html_url: string }>('POST', `${repo}/pulls`, {
              title: p.title,
              head: p.branch,
              base: p.into,
              body: p.body,
            }),
            r => ({ url: r.html_url })
          );
        case 'merge':
          return Effect.as(gh('PUT', `${repo}/pulls/${p.number}/merge`, { sha: p.head }), {});
        case 'issue':
          return Effect.gen(function* () {
            const made = yield* gh<{ id: number; html_url: string }>('POST', `${repo}/issues`, {
              title: p.title,
              body: p.body,
            });
            if (p.parent !== undefined)
              yield* gh('POST', `${repo}/issues/${p.parent}/sub_issues`, { sub_issue_id: made.id });
            return { url: made.html_url };
          });
      }
    };

    const apply: Forge['Type']['apply'] = (number, proposal, dir) =>
      act(number, proposal, dir).pipe(
        Effect.map((done): Applied => ({ proposal, ok: true, ...done })),
        Effect.catchIf(
          e => e.status !== undefined && refusals.has(e.status),
          e => Effect.succeed<Applied>({ proposal, ok: false, reason: e.message })
        )
      );

    return { threads, thread, since, apply };
  });
