import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

if (process.argv.includes('--help')) {
  console.log(
    `usage: node slice-history.mjs [repo] [--ref <branch>] [--commits 300] [--prs 100] [--comments 300]\n\nPrints one JSON line per fact about how a repo's changes are written and reviewed: commit message style, where changes land, and, when \`gh\` is logged in and the repo is on GitHub, merged pull request sizes and review comments. Read only: git log and GitHub GET calls. Logins and emails are left out; a comment keeps its author's role. The pulls line names the branches pull requests merge into; rerun with --ref set to that branch when it is not the one checked out.`
  );
  process.exit(0);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ref: { type: 'string', default: 'HEAD' },
    commits: { type: 'string', default: '300' },
    prs: { type: 'string', default: '100' },
    comments: { type: 'string', default: '300' },
  },
});
const root = resolve(positionals[0] ?? '.');
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const emit = fact => console.log(JSON.stringify(fact));
const median = xs => (xs.length ? xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const p90 = xs => (xs.length ? xs.toSorted((a, b) => a - b)[Math.floor(xs.length * 0.9)] : 0);
const clip = (text, n) => (text.length > n ? `${text.slice(0, n)} [clipped]` : text);
const scrub = text =>
  text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/(^|\s)@[A-Za-z0-9-]{2,39}\b(?!\/)/g, '$1@<login>')
    .replace(/\/(Users|home)\/[^/\s]+/g, '~');

const log = run('git', ['log', '--no-color', `-n${values.commits}`, '--format=%x1e%s%x1f%b%x1f%P', values.ref])
  .split('\x1e')
  .filter(Boolean)
  .map(entry => {
    const [subject, body = '', parents = ''] = entry.split('\x1f');
    return { subject: subject.trim(), body: body.trim(), merge: parents.trim().split(' ').length > 1 };
  });
const plain = log.filter(c => !c.merge);
const conventional = /^(\w+)(\([^)]*\))?!?: /;
const types = {};
for (const c of plain) {
  const type = conventional.exec(c.subject)?.[1];
  if (type) types[type] = (types[type] ?? 0) + 1;
}
const trailers = {};
for (const c of plain)
  for (const [, name] of c.body.matchAll(/^([A-Z][\w-]+):\s/gm)) trailers[name] = (trailers[name] ?? 0) + 1;
emit({
  kind: 'commits',
  ref: values.ref,
  read: log.length,
  merges: log.length - plain.length,
  conventional: plain.filter(c => conventional.test(c.subject)).length,
  types,
  subjectLength: { median: median(plain.map(c => c.subject.length)), p90: p90(plain.map(c => c.subject.length)) },
  withBody: plain.filter(c => c.body.replace(/^[A-Z][\w-]+:.*$/gm, '').trim()).length,
  trailers,
  issueRefs: plain.filter(c => /#\d+/.test(c.subject)).length,
  samples: plain.slice(0, 20).map(c => scrub(c.subject)),
});

const churn = new Map();
for (const line of run('git', [
  'log',
  '--no-color',
  `-n${values.commits}`,
  '--no-merges',
  '--name-only',
  '--format=',
  values.ref,
])
  .split('\n')
  .filter(Boolean)) {
  const top = line.split('/').slice(0, 2).join('/');
  churn.set(top, (churn.get(top) ?? 0) + 1);
}
emit({ kind: 'churn', paths: Object.fromEntries([...churn].toSorted((a, b) => b[1] - a[1]).slice(0, 20)) });

let slug;
try {
  run('gh', ['auth', 'status']);
  slug = JSON.parse(run('gh', ['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
} catch {
  emit({ kind: 'github', available: false, why: 'gh is missing, not logged in, or the repo has no GitHub remote' });
  process.exit(0);
}

const listMergedPulls = limit => {
  try {
    return JSON.parse(
      run('gh', [
        'pr',
        'list',
        '--state',
        'merged',
        '--limit',
        String(limit),
        '--json',
        'number,title,body,baseRefName,additions,deletions,changedFiles,labels,reviews',
      ])
    );
  } catch (error) {
    if (limit <= 10) throw error;
    console.error(`gh pr list --limit ${limit} failed, trying ${Math.floor(limit / 2)}`);
    return listMergedPulls(Math.floor(limit / 2));
  }
};
const prs = listMergedPulls(Number(values.prs));
const sizes = prs.map(p => p.additions + p.deletions);
const bases = {};
for (const p of prs) bases[p.baseRefName] = (bases[p.baseRefName] ?? 0) + 1;
const labels = {};
for (const p of prs) for (const l of p.labels) labels[l.name] = (labels[l.name] ?? 0) + 1;
emit({
  kind: 'pulls',
  merged: prs.length,
  bases,
  changedLines: { median: median(sizes), p90: p90(sizes) },
  changedFiles: { median: median(prs.map(p => p.changedFiles)), p90: p90(prs.map(p => p.changedFiles)) },
  withReviews: prs.filter(p => p.reviews.length).length,
  changesRequested: prs.filter(p => p.reviews.some(r => r.state === 'CHANGES_REQUESTED')).length,
  bodyWords: { median: median(prs.map(p => (p.body ?? '').split(/\s+/).filter(Boolean).length)) },
  linkedIssues: prs.filter(p => /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#\d+/i.test(p.body ?? '')).length,
  labels,
  titles: prs.slice(0, 15).map(p => scrub(p.title)),
});

const inline = [];
for (let page = 1; inline.length < Number(values.comments); page++) {
  const batch = JSON.parse(
    run('gh', ['api', `repos/${slug}/pulls/comments?sort=created&direction=desc&per_page=100&page=${page}`])
  );
  inline.push(...batch);
  if (batch.length < 100) break;
}
for (const c of inline.slice(0, Number(values.comments))) {
  if (c.user?.type === 'Bot') continue;
  emit({
    kind: 'review-comment',
    pull: Number(c.pull_request_url.split('/').pop()),
    path: c.path,
    role: c.author_association,
    reply: Boolean(c.in_reply_to_id),
    text: clip(scrub(c.body), 600),
    hunk: clip(c.diff_hunk.split('\n').slice(-6).join('\n'), 400),
  });
}
for (const p of prs)
  for (const r of p.reviews.filter(r => r.body?.trim()))
    emit({ kind: 'review', pull: p.number, state: r.state, role: r.authorAssociation, text: clip(scrub(r.body), 600) });
