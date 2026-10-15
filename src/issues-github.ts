import type { GitHub, GitHubError } from './github-app.ts';
import { isTrusted } from './dispatch.ts';
import { visible } from './github.ts';
import { changeEvent, matches, type Comment, type Issue, type Issues } from './issues.ts';
import { Association } from './schema.ts';
import type { BotEvent } from './types.ts';

type RestUser = { login: string };
type RestIssue = {
  id: number;
  number: number;
  title: string;
  state: 'open' | 'closed';
  body?: string | null;
  html_url: string;
  user?: RestUser | null;
  author_association: string;
  labels: (string | { name?: string })[];
  created_at: string;
  closed_at?: string | null;
  pull_request?: unknown;
};
type RestComment = {
  id: number;
  body?: string | null;
  html_url: string;
  issue_url: string;
  user?: RestUser | null;
  author_association: string;
  created_at: string;
};

const login = (user: RestUser | null | undefined) => user?.login ?? 'ghost';

const bot = (author: string) => author.endsWith('[bot]');

/** What a bot may read of a text: a bot's own text whole, with its markers; anyone else's as a reader sees it. */
const readable = (text: string | null | undefined, author: string) => (bot(author) ? (text ?? '') : visible(text ?? ''));

const association = (value: string) => {
  const parsed = Association.safeParse(value);
  return parsed.success ? parsed.data : 'NONE';
};

const notFound = (e: GitHubError) => {
  if (e.status !== 404) throw e;
  return undefined;
};

const referenced = (body: string, self: number) => [
  ...new Set([...body.matchAll(/(?:^|[\s(])#(\d+)\b/g)].map(m => Number(m[1])).filter(n => n !== self)),
];

const toIssue = (r: RestIssue, parent?: number): Issue => {
  const body = readable(r.body, login(r.user));
  const links = referenced(body, r.number).filter(n => n !== parent);
  return {
    number: r.number,
    title: r.title,
    state: r.state,
    labels: r.labels.map(l => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
    body,
    author: login(r.user),
    ...(parent !== undefined && { parent }),
    ...(links.length && { links }),
    comments: [],
    url: r.html_url,
  };
};

/** A comment as bots read it; one from outside the repository's collaborators is withheld. */
const toComment = (c: RestComment): Comment => {
  const author = login(c.user);
  const trusted = bot(author) || isTrusted(association(c.author_association));
  return {
    author,
    ts: c.created_at,
    body: trusted ? readable(c.body, author) : `(comment by @${author} withheld: not a collaborator)`,
    url: c.html_url,
  };
};

/**
 * Issues in a GitHub repository over the REST client. Parents and steps use the sub-issues API; `links` are the
 * other issues a body mentions as `#<n>`. `watch` polls for new issues, state changes and comments. Text from people
 * comes back `visible`, and comments from outside the collaborators are withheld.
 */
export const githubIssues = (gh: GitHub, repo: string): Issues => {
  const base = `/repos/${repo}/issues`;
  const parentOf = async (number: number) =>
    (await gh<RestIssue>('GET', `${base}/${number}/parent`).catch(notFound))?.number;

  const list: Issues['list'] = async (filter = {}) => {
    const { label, state = 'open', parent } = filter;
    if (parent !== undefined) {
      const subs = await gh<RestIssue[]>('GET', `${base}/${parent}/sub_issues?per_page=100`);
      return subs.map(r => toIssue(r, parent)).filter(issue => matches(issue, filter));
    }
    const query = new URLSearchParams({ state, per_page: '100', ...(label && { labels: label }) });
    const found = await gh<RestIssue[]>('GET', `${base}?${query}`);
    return found.filter(r => !r.pull_request).map(r => toIssue(r));
  };

  const get: Issues['get'] = async number => {
    const issue = await gh<RestIssue>('GET', `${base}/${number}`).catch(notFound);
    if (!issue) return;
    const [comments, parent] = await Promise.all([
      gh<RestComment[]>('GET', `${base}/${number}/comments?per_page=100`),
      parentOf(number),
    ]);
    return { ...toIssue(issue, parent), comments: comments.map(toComment) };
  };

  const link: Issues['link'] = async (parent, child) => {
    const { id } = await gh<RestIssue>('GET', `${base}/${child}`);
    await gh('POST', `${base}/${parent}/sub_issues`, { sub_issue_id: id });
  };

  const watch: Issues['watch'] = (onEvent, { interval = 60_000 } = {}) => {
    let since = new Date().toISOString();
    const emitted = new Set<string>();
    const emit = (key: string, event: BotEvent | undefined) => {
      if (!event || emitted.has(key)) return;
      emitted.add(key);
      onEvent(event);
    };
    const poll = async () => {
      const from = since;
      since = new Date().toISOString();
      const query = `since=${encodeURIComponent(from)}&sort=updated&direction=asc&per_page=100`;
      const [issues, comments] = await Promise.all([
        gh<RestIssue[]>('GET', `${base}?state=all&${query}`),
        gh<RestComment[]>('GET', `${base}/comments?${query}`),
      ]);
      for (const r of issues) {
        if (r.pull_request) continue;
        const issue = toIssue(r);
        const sender = login(r.user);
        const at = (id: string) => ({ repo, id, association: () => association(r.author_association) });
        if (r.created_at >= from)
          emit(
            `opened-${r.id}`,
            changeEvent({ kind: 'issues', action: 'opened', issue, sender }, at(`poll-${r.id}-opened`))
          );
        if (r.closed_at && r.closed_at >= from)
          emit(
            `closed-${r.id}-${r.closed_at}`,
            changeEvent({ kind: 'issues', action: 'closed', issue, sender }, at(`poll-${r.id}-closed`))
          );
      }
      for (const c of comments) {
        const number = Number(/\/issues\/(\d+)$/.exec(c.issue_url)?.[1]);
        if (!number || c.created_at < from) continue;
        const issue: Issue = {
          number,
          title: '',
          state: 'open',
          labels: [],
          body: '',
          comments: [],
          url: c.html_url.split('#')[0] ?? c.html_url,
        };
        const at = { repo, id: `poll-comment-${c.id}`, association: () => association(c.author_association) };
        emit(`comment-${c.id}`, changeEvent({ kind: 'issue_comment', issue, comment: toComment(c) }, at));
      }
    };
    const timer = setInterval(() => void poll().catch(() => {}), interval);
    return { ready: Promise.resolve(), stop: () => clearInterval(timer) };
  };

  return {
    backend: 'github',
    list,
    get,
    create: async ({ title, body = '', labels = [], parent, links = [] }) => {
      const mentions = links.filter(n => !referenced(body, 0).includes(n)).map(n => `#${n}`);
      const text = mentions.length ? `${body}\n\nRelated: ${mentions.join(', ')}`.trim() : body;
      const created = await gh<RestIssue>('POST', base, { title, body: text, labels });
      if (parent !== undefined) await gh('POST', `${base}/${parent}/sub_issues`, { sub_issue_id: created.id });
      return toIssue(created, parent);
    },
    comment: async (number, body) => toComment(await gh<RestComment>('POST', `${base}/${number}/comments`, { body })),
    label: async (number, { add = [], remove = [] }) => {
      if (add.length) await gh('POST', `${base}/${number}/labels`, { labels: add });
      for (const name of remove)
        await gh('DELETE', `${base}/${number}/labels/${encodeURIComponent(name)}`).catch(notFound);
    },
    close: async number => {
      await gh('PATCH', `${base}/${number}`, { state: 'closed' });
    },
    link,
    watch,
  };
};
