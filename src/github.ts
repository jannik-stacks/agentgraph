import { execFile } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { promisify } from 'node:util';
import { Config, Effect, Layer, Option, Redacted, Schedule, Stream } from 'effect';
import {
  makeCommentWithAgentRequest,
  isAgentBranch,
  isPostedBy,
  pushLimits,
  unpushable,
  Forge,
  ForgeError,
  makePostableProposal,
  matches,
  withheld,
} from './forge.ts';
import type { Applied, Comment, Event, Issue } from './event.ts';
import type { Proposal } from './proposal.ts';
import type { Checkout } from './sandbox.ts';
import { hostGit, mergeTreeOnto, commitPublishedTree } from './git.ts';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type User = { login: string; type?: string } | null | undefined;
type RestIssue = {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  labels: (string | { name?: string })[];
  milestone?: { title: string } | null;
  user?: User;
  author_association?: string;
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
  commit: {
    message: string;
    author?: { name?: string; date?: string } | null;
    committer?: { date?: string } | null;
  };
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
type ProjectColumnPage = {
  data?: {
    repository: {
      issues: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ({
          number: number;
          projectItems: {
            nodes: ({
              project: { number: number; owner: { login?: string } };
              fieldValueByName: { name: string; updatedAt: string } | null;
            } | null)[];
          };
        } | null)[];
      };
    };
  };
  errors?: { type?: string; message: string }[];
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
const columnQuery = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { number projectItems(first: 20) { nodes {
        project { number owner { ... on User { login } ... on Organization { login } } }
        fieldValueByName(name: "Status") {
          ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt }
        }
      } } }
    }
  }
}`;

const readProjectToken: Effect.Effect<string, ForgeError> = Effect.gen(function* () {
  const set = yield* Effect.orElseSucceed(Config.option(Config.redacted('AGENTGRAPH_PROJECT_TOKEN')), Option.none);
  const value = Option.match(set, { onNone: () => '', onSome: Redacted.value }).trim();
  if (value) return value;
  return yield* Effect.tryPromise({
    try: () => promisify(execFile)('gh', ['auth', 'token']).then(out => out.stdout.trim()),
    catch: () => new ForgeError({ message: 'no token' }),
  }).pipe(Effect.filterOrFail(Boolean, () => new ForgeError({ message: 'no token' })));
});
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

const git = (work: Checkout, args: string[]) =>
  Effect.mapError(hostGit(work.git, args), e => new ForgeError({ message: e.detail }));
const gitText = (work: Checkout, args: string[]) => Effect.map(git(work, args), out => out.toString('utf8').trim());

const refPath = (branch: string) =>
  branch.split('/').some(part => !part || part === '.' || part === '..')
    ? Effect.fail(new ForgeError({ status: 422, message: `invalid branch "${branch}"` }))
    : Effect.succeed(`heads/${branch.split('/').map(encodeURIComponent).join('/')}`);

/**
 * A GitHub REST call with `auth` as the bearer; GETs are polled with ETags, so an unchanged answer is a free 304. A call
 * that may be sent twice, any but a POST or a token to mint, is retried with backoff when the network fails or GitHub
 * answers 502 to 504.
 */
const requester = (fetch: Fetch) => {
  const etags = new Map<string, { etag: string; data: unknown; next?: string }>();
  return <T>(method: string, path: string, auth: string, body?: unknown, version = '2022-11-28') =>
    Effect.gen(function* () {
      const url = path.startsWith('https://') ? path : api + path;
      const cached = method === 'GET' ? etags.get(url) : undefined;
      const again = method !== 'POST' || path.endsWith('/access_tokens');
      const res = yield* Effect.tryPromise({
        try: async signal => {
          const res = await fetch(url, {
            method,
            signal,
            headers: {
              Accept: 'application/vnd.github+json',
              Authorization: `Bearer ${auth}`,
              'X-GitHub-Api-Version': version,
              'User-Agent': 'agentgraph',
              ...(cached && { 'If-None-Match': cached.etag }),
              ...(body !== undefined && { 'Content-Type': 'application/json' }),
            },
            ...(body !== undefined && { body: JSON.stringify(body) }),
          });
          if (again && res.status >= 502 && res.status <= 504) throw new Error(`status ${res.status}`);
          return { status: res.status, ok: res.ok, headers: res.headers, text: await res.text() };
        },
        catch: e => new ForgeError({ message: `GitHub ${method} ${path}: ${String(e)}` }),
      }).pipe(
        Effect.timeoutFail({
          duration: '30 seconds',
          onTimeout: () => new ForgeError({ message: `GitHub ${method} ${path} timed out` }),
        }),
        Effect.retry({ schedule: Schedule.exponential('1 second'), times: again ? 4 : 0 })
      );
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
  issue: { issues: 'write' },
  push: { contents: 'write' },
  pull_request: { contents: 'read', pull_requests: 'write' },
  merge: { contents: 'write', pull_requests: 'write' },
  repos: { metadata: 'read' },
} as const;
type TokenScope = keyof typeof scopes;
type AppToken = (scope: TokenScope, refused?: string) => Effect.Effect<string, ForgeError>;
const freshMs = 5_000;

/** Mints installation tokens for the App, one per scope, reusing a token until a minute before it expires. */
export const appToken = (
  app: { repo: string; id: string; key: Redacted.Redacted },
  fetch: Fetch = globalThis.fetch
): AppToken => {
  const request = requester(fetch);
  const tokens = new Map<TokenScope, { value: string; expires: number; minted: number }>();
  const minting = Effect.unsafeMakeSemaphore(1);
  return (scope, refused) =>
    minting.withPermits(1)(
      Effect.suspend(() => {
        const token = tokens.get(scope);
        const kept = token && (token.value !== refused || Date.now() - token.minted < freshMs);
        if (kept && token.expires - 60_000 > Date.now()) return Effect.succeed(token.value);
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
          tokens.set(scope, { value: data.token, expires: Date.parse(data.expires_at), minted: Date.now() });
          return data.token;
        });
      })
    );
};

// UNEXPECTED: a token GitHub narrows to some repos or permissions loses private contents and pull requests ~10s after it is minted, answering 404; a new token reads them again.
const authed = <T>(token: AppToken, scope: TokenScope, call: (token: string) => Effect.Effect<T, ForgeError>) =>
  Effect.flatMap(token(scope), t =>
    Effect.catchIf(
      call(t),
      e => e.status === 404,
      e => Effect.flatMap(token(scope, t), fresh => (fresh === t ? Effect.fail(e) : call(fresh)))
    )
  );

const appSigned = (app: { id: string; key: Redacted.Redacted }) =>
  Effect.try({
    try: () => appJwt(app.id, Redacted.value(app.key), Date.now()),
    catch: e => new ForgeError({ message: (e as Error).message }),
  });

/**
 * The repo of one GitHub App installation. Reads are ETag-polled, text from non-collaborators (or logins outside `trust`) is withheld, and pushes
 * go through the Git data API so GitHub signs the commits. Posted bodies are stamped with their run, linked into `studio` when set.
 */
export const githubForge = (
  app: { repo: string; id: string; key: Redacted.Redacted },
  fetch: Fetch = globalThis.fetch,
  token: AppToken = appToken(app, fetch),
  trust?: readonly string[],
  studio?: string,
  projectToken = readProjectToken
): Layer.Layer<Forge> =>
  Layer.sync(Forge, () => {
    const listed = (user: User, association = '') => (trust ? trust.includes(login(user)) : members.has(association));
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

    const gh = <T>(method: string, path: string, body?: unknown, scope: TokenScope = 'read', version?: string) =>
      authed(token, scope, t => request<T>(method, path, t, body, version)).pipe(Effect.map(r => r.data));

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
          const page: { data: T[]; next?: string } = yield* authed(token, 'read', t => request<T[]>('GET', url!, t));
          items.push(...page.data);
          url = more(page.data) ? page.next : undefined;
        }
        return items;
      });

    const toIssue = (i: RestIssue, self: string, pull?: RestPull, parent?: number): Issue => {
      const own = pull?.head.repo?.full_name === app.repo;
      const author = login(i.user);
      const shown = listed(i.user, i.author_association) || author === `${self}[bot]`;
      return {
        number: i.number,
        title: shown ? visible(i.title) : withheld(author, 'title'),
        body: shown ? visible(i.body) : withheld(author, 'issue text'),
        state: i.pull_request?.merged_at || pull?.merged_at ? 'merged' : i.state,
        labels: i.labels.map(l => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
        author,
        ...(i.milestone && { milestone: i.milestone.title }),
        ...(parent !== undefined && { parent }),
        ...(pull && {
          pull: {
            branch: own ? pull.head.ref : `${pull.head.repo?.full_name ?? 'unknown'}:${pull.head.ref}`,
            base: pull.base.ref,
            head: pull.head.sha,
            ...(pull.base.sha && { baseSha: pull.base.sha }),
          },
        }),
        url: i.html_url,
      };
    };

    const toComment = (c: RestComment, self: string): Comment => {
      const author = login(c.user);
      const shown = listed(c.user, c.author_association) || author === `${self}[bot]`;
      const comment: Comment = {
        id: String(c.id),
        author,
        body: shown ? visible(c.body) : withheld(author),
        at: c.created_at,
        ...(c.path !== undefined && { path: c.path }),
        ...(typeof c.line === 'number' && { line: c.line }),
        ...(c.in_reply_to_id !== undefined && { under: String(c.in_reply_to_id) }),
      };
      return shown ? makeCommentWithAgentRequest(comment) : comment;
    };

    const heard = (issue: number, c: RestComment, self: string, kind: Event['kind'] = 'comment'): Event => {
      const comment = toComment(c, self);
      const trusted = listed(c.user, c.author_association) && !isBot(c.user);
      return { issue, kind, actor: comment.author, trusted, at: c.created_at, comment };
    };

    /** A review as an event: its state, or a comment when it only has a body; undefined for an empty comment. */
    const reviewed = (issue: number, r: RestReview, self: string): Event | undefined => {
      const kind =
        r.state === 'APPROVED' ? 'approved' : r.state === 'CHANGES_REQUESTED' ? 'changes_requested' : 'comment';
      if (!r.submitted_at || (kind === 'comment' && !visible(r.body).trim())) return undefined;
      return heard(issue, { ...r, created_at: r.submitted_at, html_url: '' }, self, kind);
    };

    const kinds: Record<string, Event['kind']> = {
      merged: 'merged',
      closed: 'closed',
      labeled: 'label',
      unlabeled: 'unlabel',
    };
    /** An issue event in our shape, trusted when `may` says its actor may write; undefined for events that say nothing here. */
    const evented = (issue: number, e: RestEvent, merged: boolean, may: ReturnType<typeof writer>) =>
      Effect.gen(function* () {
        const kind = kinds[e.event];
        if (!kind || (kind === 'closed' && merged) || ((kind === 'label' || kind === 'unlabel') && !e.label))
          return undefined;
        return {
          issue,
          kind,
          actor: login(e.actor),
          trusted: (yield* may(e.actor)) && (!trust || trust.includes(login(e.actor))),
          at: e.created_at,
          ...(e.label && { label: e.label.name }),
        } satisfies Event;
      });

    const listState = (state?: Issue['state']) => (state === undefined ? 'all' : state === 'open' ? 'open' : 'closed');

    const issues: Forge['Type']['issues'] = (filter = {}) =>
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
        const self = yield* me;
        return issues.map(i => toIssue(i, self, byNumber.get(i.number), parent)).filter(matches(filter));
      });

    /** The checks and statuses on a commit: name and conclusion only. Without the permission to read them, none. */
    const checked = (issue: number, sha: string) =>
      Effect.all([
        gh<{ check_runs: RestCheck[] }>('GET', `${repo}/commits/${sha}/check-runs?per_page=100`, undefined, 'checks'),
        gh<{ statuses: RestStatus[] }>('GET', `${repo}/commits/${sha}/status`, undefined, 'checks'),
      ]).pipe(
        Effect.map(([runs, status]): Event[] => [
          ...runs.check_runs.map(c => ({
            issue,
            kind: 'check' as const,
            actor: c.app?.slug ?? 'checks',
            trusted: false,
            at: c.completed_at ?? c.started_at ?? '',
            check: { name: visible(c.name), conclusion: c.conclusion ?? c.status },
          })),
          ...status.statuses.map(s => ({
            issue,
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

    const issue: Forge['Type']['issue'] = number =>
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
        // A fork's commits name their author by email alone, which anyone can claim.
        const own = pull?.head.repo?.full_name === app.repo;
        const may = writer();
        const timeline: Event[] = [
          ...[...said, ...lined].map(c => heard(number, c, self)),
          ...reviews.flatMap(r => reviewed(number, r, self) ?? []),
          ...(yield* Effect.forEach(commits, c =>
            Effect.map(
              !own ? Effect.succeed(false) : login(c.author) === `${self}[bot]` ? Effect.succeed(true) : may(c.author),
              (shown): Event => ({
                issue: number,
                kind: 'commit',
                actor: login(c.author),
                trusted: false,
                at: c.commit.author?.date ?? '',
                commit: {
                  sha: c.sha,
                  title: shown
                    ? visible(c.commit.message.split('\n')[0])
                    : withheld(login(c.author), 'commit title', own ? undefined : 'from a fork'),
                },
              })
            )
          )),
          ...(yield* Effect.forEach(events, e => evented(number, e, merged, may))).flatMap(m => m ?? []),
          ...(pull ? yield* checked(number, pull.head.sha) : []),
        ];
        return {
          ...toIssue(issue, self, pull, parent?.number),
          events: timeline.sort((a, b) => a.at.localeCompare(b.at)),
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

    /** `permitted`, asked once per login for the life of the returned function. */
    const writer = () => {
      const asked = new Map<string, boolean>();
      return (user: User) =>
        asked.has(login(user))
          ? Effect.succeed(asked.get(login(user))!)
          : Effect.tap(permitted(user), ok => asked.set(login(user), ok));
    };

    const columns = Effect.runSync(
      Effect.cached(
        Effect.gen(function* () {
          const auth = yield* projectToken;
          const [owner, name] = app.repo.split('/');
          const found: Event[] = [];
          let after: string | null = null;
          do {
            const page: ProjectColumnPage = (yield* request<ProjectColumnPage>('POST', '/graphql', auth, {
              query: columnQuery,
              variables: { owner, name, after },
            })).data;
            if (!page.data || page.errors?.some(e => e.type === 'INSUFFICIENT_SCOPES'))
              return yield* new ForgeError({ message: page.errors?.map(e => e.message).join('; ') ?? 'no data' });
            const { issues } = page.data.repository;
            for (const t of issues.nodes)
              for (const item of t?.projectItems.nodes ?? []) {
                const v = item?.fieldValueByName;
                if (!t || !item || !v?.name) continue;
                const by = item.project.owner.login ?? 'ghost';
                found.push({
                  issue: t.number,
                  kind: 'column',
                  actor: by,
                  trusted: by === owner,
                  at: v.updatedAt,
                  column: { project: `${by}/${item.project.number}`, name: v.name },
                });
              }
            after = issues.pageInfo.hasNextPage ? issues.pageInfo.endCursor : null;
          } while (after);
          return found;
        }).pipe(
          Effect.catchAll(e =>
            Effect.as(
              Effect.logError(
                `Reading project columns needs a GitHub token with the read:project scope: run \`gh auth refresh -s read:project\`, or set AGENTGRAPH_PROJECT_TOKEN. (${e.message})`
              ),
              []
            )
          )
        )
      )
    );

    const since: Forge['Type']['since'] = (cursor, read) =>
      Stream.fromIterableEffect(
        Effect.gen(function* () {
          const self = yield* me;
          const may = writer();
          const after = (at?: string | null): at is string => !!at && at > cursor;
          const from = cursor ? `since=${encodeURIComponent(cursor)}&` : '';
          const window = `${from}sort=updated&direction=asc&per_page=100`;
          const [said, lined, events, open, board] = yield* Effect.all(
            [
              all<RestComment>(`${repo}/issues/comments?${window}`),
              all<RestComment>(`${repo}/pulls/comments?${window}`),
              all<RestEvent>(`${repo}/issues/events?per_page=100`, page => after(page.at(-1)?.created_at)),
              all<RestPull>(`${repo}/pulls?state=open&per_page=100`),
              read ? columns : Effect.succeed([]),
            ],
            { concurrency: 'unbounded' }
          );
          const reviews = yield* Effect.forEach(
            open,
            p =>
              Effect.map(all<RestReview>(`${repo}/pulls/${p.number}/reviews?per_page=100`), rs =>
                rs.map(r => ({ ...r, issue: p.number }))
              ),
            { concurrency: 4 }
          );

          const ours = open.filter(p => p.head.repo?.full_name === app.repo && isAgentBranch(p.head.ref));
          const commits = yield* Effect.forEach(
            ours,
            p =>
              Effect.map(all<RestCommit>(`${repo}/pulls/${p.number}/commits?per_page=100`), cs =>
                cs.map(c => ({ ...c, issue: p.number }))
              ),
            { concurrency: 4 }
          );

          const found: Event[] = [];
          for (const c of commits.flat()) {
            const at = c.commit.committer?.date ?? c.commit.author?.date;
            if (after(at) && c.author && login(c.author) !== `${self}[bot]`)
              found.push({
                issue: c.issue,
                kind: 'commit',
                actor: login(c.author),
                trusted: true,
                at,
                commit: { sha: c.sha, title: visible(c.commit.message.split('\n')[0]) },
              });
          }
          for (const c of said) if (after(c.created_at)) found.push(heard(numberIn(c.issue_url), c, self));
          for (const c of lined) if (after(c.created_at)) found.push(heard(numberIn(c.pull_request_url), c, self));
          for (const r of reviews.flat()) {
            const m = after(r.submitted_at) ? reviewed(r.issue, r, self) : undefined;
            if (m) found.push(m);
          }
          const merged = new Set(events.filter(e => e.event === 'merged').map(e => e.issue?.number));
          for (const e of events) {
            const m =
              after(e.created_at) && e.issue
                ? yield* evented(e.issue.number, e, merged.has(e.issue.number), may)
                : undefined;
            if (m) found.push(m);
          }
          found.push(...board.filter(m => after(m.at)));
          for (const m of found) if (m.trusted && (m.comment || m.commit)) m.trusted = yield* may({ login: m.actor });
          return found.sort((a, b) => a.at.localeCompare(b.at));
        })
      );

    /** The last commit pushed from each checkout and its tree; the next push from it builds on that commit. */
    const pushed = new Map<string, { sha: string; tree: string }>();
    /** The `.github/` files each branch's pushes left out, for its pull request to name. */
    const held = new Map<string, Set<string>>();
    const refuse = (message: string, moved?: true) => new ForgeError({ status: 422, message, ...(moved && { moved }) });
    let repositoryId: string | undefined;
    const rewrite = (branch: string, before: string, after: string) =>
      Effect.gen(function* () {
        repositoryId ??= (yield* gh<{ node_id: string }>('GET', repo)).node_id;
        const result = yield* gh<{ data?: { updateRefs: unknown }; errors?: { message: string }[] }>(
          'POST',
          '/graphql',
          {
            query: 'mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }',
            variables: {
              input: {
                repositoryId,
                refUpdates: [{ name: `refs/heads/${branch}`, beforeOid: before, afterOid: after, force: true }],
              },
            },
          },
          'push'
        );
        if (result.errors?.length || !result.data?.updateRefs) {
          const ref = yield* refPath(branch);
          const tip = (yield* missing(gh<{ object: { sha: string } }>('GET', `${repo}/git/ref/${ref}`)))?.object.sha;
          if (tip !== before) return yield* refuse(`${branch} moved while its ref was updated`, true);
          return yield* new ForgeError({
            message: `GitHub updateRefs ${branch}: ${result.errors?.map(e => e.message).join('; ') ?? 'no update returned'}`,
          });
        }
      });

    /**
     * Commits the checkout's files on top of its base, or of its last push, through the Git data API, then moves
     * `branch` forward to that commit. Only regular files outside `.github/` and `.git/` are pushed, within the limits;
     * changes under `.github/` are left out and held for the pull request to name.
     */
    const push = (work: Checkout, branch: string, message: string, onto?: string, merge?: true) =>
      Effect.gen(function* () {
        if (!isAgentBranch(branch)) return yield* refuse(`a push goes to a ${pushLimits.prefix} branch`);
        const ref = yield* refPath(branch);
        const last = pushed.get(work.dir);
        const parent = last?.sha ?? work.head ?? work.base;
        const tip = (yield* missing(gh<{ object: { sha: string } }>('GET', `${repo}/git/ref/${ref}`)))?.object.sha;
        if (tip && tip !== parent)
          return yield* refuse(`${branch} is at ${tip}, the checkout builds on ${parent}`, true);
        const follow = last ? undefined : onto;
        const parents = follow ? (merge ? [parent, follow] : [follow]) : [parent];
        const from = last?.tree ?? (yield* gitText(work, ['rev-parse', `${parents[0]}^{tree}`]));
        yield* git(work, ['add', '-A']);
        let tree = yield* gitText(work, ['write-tree']);
        const left = (yield* gitText(work, [
          'diff-tree',
          '-r',
          '--name-only',
          '--no-renames',
          from,
          tree,
          '--',
          '.github',
        ]))
          .split('\n')
          .filter(Boolean);
        if (left.length) {
          yield* git(work, ['reset', '-q', from, '--', '.github']);
          tree = yield* gitText(work, ['write-tree']);
          held.set(branch, new Set([...(held.get(branch) ?? []), ...left]));
        }
        let head = parent;
        if (tree !== from || follow) {
          if (tree !== from) yield* upload(work, from, tree);
          const commit = { message, tree, parents };
          head = (yield* gh<{ sha: string }>('POST', `${repo}/git/commits`, commit, 'push')).sha;
        }
        if (head === tip) return head;
        const force = !!follow && !merge;
        if (
          force &&
          (yield* missing(gh<{ object: { sha: string } }>('GET', `${repo}/git/ref/${ref}`)))?.object.sha !== tip
        )
          return yield* refuse(`${branch} moved while the commit was built`, true);
        if (tip) {
          if (force) yield* rewrite(branch, tip, head);
          else yield* gh('PATCH', `${repo}/git/refs/${ref}`, { sha: head, force }, 'push');
        } else yield* gh('POST', `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: head }, 'push');
        yield* commitPublishedTree(work, tree).pipe(Effect.mapError(e => new ForgeError({ message: e.detail })));
        pushed.set(work.dir, { sha: head, tree });
        return head;
      });

    /** Builds tree `to` on GitHub from tree `from`, from the checkout's objects. */
    const upload = (work: Checkout, from: string, to: string) =>
      Effect.gen(function* () {
        const tree = yield* entries(work, from, to);
        const made = (yield* gh<{ sha: string }>('POST', `${repo}/git/trees`, { base_tree: from, tree }, 'push')).sha;
        if (made !== to) return yield* new ForgeError({ message: `GitHub built tree ${made}, expected ${to}` });
      });

    /**
     * Replays the commits on `branch` after `from` onto `onto` as new commits through the Git data API, then moves the
     * branch there unless it moved meanwhile. Commits that become empty are dropped. The checkout ends on the result.
     */
    const rebase = (work: Checkout, branch: string, from: string, onto: string, local?: string) =>
      Effect.gen(function* () {
        if (!isAgentBranch(branch)) return yield* refuse(`a rebase goes to a ${pushLimits.prefix} branch`);
        const ref = yield* refPath(branch);
        const readRefTip = Effect.map(
          missing(gh<{ object: { sha: string } }>('GET', `${repo}/git/ref/${ref}`)),
          r => r?.object.sha
        );
        const tip = yield* readRefTip;
        if (!tip) return yield* refuse(`${branch} does not exist`);
        if (local && tip !== onto) return yield* refuse(`${branch} moved to ${tip}`, true);
        if (local) {
          pushed.delete(work.dir);
          work.head = onto;
        }
        if (yield* gitText(work, ['rev-list', '--merges', `${from}..${local ?? tip}`]))
          return yield* refuse(`${branch} contains merge commits; rebase it by hand`);
        const commits = (yield* gitText(work, ['rev-list', '--reverse', '--no-merges', `${from}..${local ?? tip}`]))
          .split('\n')
          .filter(Boolean);
        let head = onto;
        let tree = yield* gitText(work, ['rev-parse', `${onto}^{tree}`]);
        for (const commit of commits) {
          const { tree: next, files } = yield* mergeTreeOnto(work, tree, `${commit}^{tree}`, `${commit}~1^{tree}`).pipe(
            Effect.mapError(e => refuse(e.detail ?? e.reason))
          );
          if (files.length > 0) {
            if (local) yield* git(work, ['read-tree', '-u', '--reset', next]);
            return yield* refuse(`${commit.slice(0, 7)} on ${branch} conflicts with ${onto.slice(0, 7)}`);
          }
          if (next === tree) continue;
          if (local) {
            tree = next;
            continue;
          }
          yield* upload(work, tree, next);
          const message = yield* gitText(work, ['log', '-1', '--format=%B', commit]);
          head = (yield* gh<{ sha: string }>(
            'POST',
            `${repo}/git/commits`,
            { message, tree: next, parents: [head] },
            'push'
          )).sha;
          tree = next;
        }
        if (local) {
          yield* git(work, ['read-tree', '-u', '--reset', tree]);
          return onto;
        }
        if ((yield* readRefTip) !== tip) return yield* refuse(`${branch} moved while it was rebased`, true);
        yield* rewrite(branch, tip, head);
        yield* git(work, ['read-tree', '-u', '--reset', tree]);
        yield* commitPublishedTree(work, tree).pipe(Effect.mapError(e => new ForgeError({ message: e.detail })));
        pushed.set(work.dir, { sha: head, tree });
        return head;
      });

    /** The tree entries that turn tree `from` into `to`, uploading each changed blob once every change passed. */
    const entries = (work: Checkout, from: string, to: string) =>
      Effect.gen(function* () {
        const fields = (yield* git(work, ['diff-tree', '-r', '-z', '--no-renames', '--no-abbrev', from, to]))
          .toString('utf8')
          .split('\0');
        const count = (fields.length - 1) / 2;
        if (count > pushLimits.files)
          return yield* refuse(`refused to push: ${count} files changed, at most ${pushLimits.files} can be pushed`);
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
            if (content.length > pushLimits.bytes) problems.push(`${path} is over ${pushLimits.bytes} bytes`);
            else changes.push({ path, mode: newMode, sha: newSha, content });
          }
        }
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

    /**
     * Registers the open pull requests whose bases chain down from `number` as a GitHub stack, or adds `number` on top
     * of its parent's stack. A repo without stacks keeps the plain chain.
     */
    const stack = (number: number, base: string) =>
      Effect.gen(function* () {
        const open = (yield* all<RestPull>(`${repo}/pulls?state=open&per_page=100`)).filter(
          o => o.head.repo?.full_name === app.repo
        );
        const chain = [number];
        for (let below = open.find(o => o.head.ref === base); below && !chain.includes(below.number);) {
          chain.unshift(below.number);
          const on = below.base.ref;
          below = open.find(o => o.head.ref === on);
        }
        if (chain.length < 2) return;
        const stacks = <T>(method: string, path: string, body?: unknown) =>
          gh<T>(method, `${repo}/stacks${path}`, body, method === 'GET' ? 'read' : 'pull_request', '2026-03-10');
        yield* stacks('POST', '', { pull_requests: chain }).pipe(
          Effect.catchIf(
            e => e.status === 422,
            () =>
              Effect.gen(function* () {
                const found = yield* stacks<{ number: number }[]>('GET', `?pull_request=${chain.at(-2)}`);
                const parent = Array.isArray(found) ? found[0] : undefined;
                if (parent) yield* stacks('POST', `/${parent.number}/add`, { pull_requests: [number] });
              })
          ),
          Effect.catchIf(
            e => e.status === 404 || e.status === 422,
            () => Effect.void
          )
        );
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
      work?: Checkout
    ): Effect.Effect<{ url?: string; id?: string }, ForgeError> => {
      switch (p.kind) {
        case 'comment':
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
          if (p.remove !== undefined)
            return Effect.as(missing(gh('DELETE', `${repo}/${on}/reactions/${p.remove}`, undefined, 'comment')), {});
          return Effect.map(
            gh<{ id: number }>('POST', `${repo}/${on}/reactions`, { content: 'eyes' }, 'comment'),
            r => ({ id: String(r.id) })
          );
        }
        case 'back':
        case 'run':
        case 'tell':
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
          return Effect.map(push(work, p.branch, p.message, p.onto, p.merge), head => ({
            url: `https://github.com/${app.repo}/commit/${head}`,
          }));
        case 'rebase':
          if (work === undefined) return Effect.fail(refuse('rebase needs a checkout'));
          return Effect.map(rebase(work, p.branch, p.from, p.onto, p.head), head => ({
            url: `https://github.com/${app.repo}/commit/${head}`,
          }));
        case 'pull_request':
          return Effect.gen(function* () {
            if (!isAgentBranch(p.branch))
              return yield* refuse(`a pull request goes from a ${pushLimits.prefix} branch`);
            type Made = { number: number; html_url: string };
            const left = [...(held.get(p.branch) ?? [])];
            const note = left.length
              ? `\n\nNot pushed: ${left.map(f => `\`${f}\``).join(', ')}. agentgraph does not push files under \`.github/\` (GitHub needs the app's Workflows permission for workflow files, and they run with the repo's secrets), so a maintainer pushes them to \`${p.branch}\`.`
              : '';
            const body = { title: p.title, head: p.branch, base: p.base, body: p.body + note };
            const owner = app.repo.split('/')[0];
            const made = yield* gh<Made>('POST', `${repo}/pulls`, body, 'pull_request').pipe(
              Effect.catchIf(
                e => e.status === 422,
                e =>
                  Effect.flatMap(gh<Made[]>('GET', `${repo}/pulls?state=open&head=${owner}:${p.branch}`), ([open]) =>
                    open
                      ? gh<Made>(
                          'PATCH',
                          `${repo}/pulls/${open.number}`,
                          { title: p.title, body: body.body },
                          'pull_request'
                        )
                      : Effect.fail(e)
                  )
              )
            );
            yield* stack(made.number, p.base).pipe(
              Effect.catchAll(e => Effect.logWarning(`stack for #${made.number}`, e))
            );
            return { url: made.html_url };
          });
        case 'merge':
          return Effect.as(gh('PUT', `${repo}/pulls/${p.number}/merge`, { sha: p.head }, 'merge'), {});
        case 'issue':
          return Effect.gen(function* () {
            const fields = { title: p.title, body: p.body, ...(p.labels?.length && { labels: p.labels }) };
            const made = yield* gh<{ id: number; number: number; html_url: string }>(
              'POST',
              `${repo}/issues`,
              fields,
              'issue'
            );
            const reason =
              p.parent === undefined
                ? undefined
                : yield* gh('POST', `${repo}/issues/${p.parent}/sub_issues`, { sub_issue_id: made.id }, 'issue').pipe(
                    Effect.as(undefined),
                    Effect.catchAll(e => Effect.succeed(`could not link #${made.number} to #${p.parent}: ${e.message}`))
                  );
            return { url: made.html_url, id: String(made.number), ...(reason && { reason }) };
          });
      }
    };

    const apply: Forge['Type']['apply'] = (number, proposal, work) =>
      Effect.flatMap(makePostableProposal(proposal, studio), ({ posted, at }) =>
        Effect.map(act(number, posted, work), (done): Applied => ({ proposal, ok: true, ...done, ...(at && { at }) }))
      ).pipe(
        Effect.catchIf(
          e => e.status !== undefined && refusals.has(e.status),
          e => Effect.succeed<Applied>({ proposal, ok: false, reason: e.message, ...(e.moved && { moved: e.moved }) })
        )
      );

    const findPost: Forge['Type']['findPost'] = (number, p, operation) => {
      type Posted = { id: number; number: number; html_url: string; body?: string | null };
      const find = (posts: Posted[], id: (post: Posted) => number) => {
        const post = posts.find(c => isPostedBy(c.body ?? '', operation));
        return post && { proposal: p, ok: true, url: post.html_url, id: String(id(post)) };
      };
      if (p.kind === 'issue')
        return Effect.map(gh<Posted[]>('GET', `${repo}/issues?state=all&sort=created&direction=desc&per_page=100`), i =>
          find(i, post => post.number)
        );
      if (p.kind !== 'comment' || p.edit !== undefined) return Effect.succeed(undefined);
      const thread = p.under === undefined ? `issues/${number}` : `pulls/${number}`;
      return Effect.map(all<Posted>(`${repo}/${thread}/comments?per_page=100`), c => find(c, post => post.id));
    };

    return { issues, issue, since, apply, findPost, slug: me, ...(studio && { studio }) };
  });

export const readInstallationReach = (
  app: { repo: string; id: string; key: Redacted.Redacted },
  fetch: Fetch = globalThis.fetch
) =>
  Effect.gen(function* () {
    const token = yield* appToken(app, fetch)('repos');
    const res = yield* Effect.tryPromise(() =>
      fetch('https://api.github.com/installation/repositories?per_page=100', {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'agentgraph',
        },
      }).then(r => (r.ok ? r.json() : Promise.reject(new Error(`GET /installation/repositories ${r.status}`))))
    );
    const repos = (res as { repositories: { full_name: string }[] }).repositories.map(r => r.full_name);
    const lines: string[] = [];
    const extra = repos.filter(r => r !== app.repo);
    if (extra.length > 0) {
      lines.push(`The installation reaches ${extra.length} repo(s) besides ${app.repo}: ${extra.join(', ')}`);
      lines.push('  Narrow it at https://github.com/settings/installations');
    }
    return lines;
  });
