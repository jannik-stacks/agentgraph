// Mines replay cases from merged pull requests: one directory per PR with the issue text, the merged diff, review
// comments and later commits that touched the same lines. Read-only against GitHub (`gh` GET calls) and the clone.
//   node bench/mine.mjs OWNER/REPO --clone DIR --out DIR [--since DATE] [--limit 10]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const MEMORY_CUTOFF = '2026-06-01';
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const gh = (...args) => JSON.parse(run('gh', args) || 'null');

/** Drops code blocks and the sections of a PR body that describe the solution. */
export const stripSolution = body => {
  const sections = (body ?? '').replace(/```[\s\S]*?```/g, '').split(/^(?=#{1,4}\s)/m);
  const keep = sections.filter(
    s => !/^#{1,4}\s*(changes?|solution|implementation|what changed|fix|test plan|testing|how)/i.test(s)
  );
  return keep.join('').trim();
};

const mergeBase = (clone, sha) => {
  const parents = run('git', ['rev-list', '--parents', '-n', '1', sha], clone).trim().split(' ').slice(1);
  return parents.length > 1 ? run('git', ['merge-base', parents[0], parents[1]], clone).trim() : parents[0];
};

const ensure = (clone, sha) => {
  try {
    run('git', ['cat-file', '-e', `${sha}^{commit}`], clone);
  } catch {
    run('git', ['fetch', '--quiet', 'origin', sha], clone);
  }
};

const reviewsOf = (repo, number) => {
  const api = path => gh('api', '--paginate', '--slurp', `repos/${repo}/pulls/${number}/${path}`).flat();
  const inline = api('comments').map(
    c => `### ${c.path}:${c.line ?? c.original_line ?? '?'} (${c.user.login})\n\n${c.body}`
  );
  const verdicts = api('reviews')
    .filter(r => r.body?.trim())
    .map(r => `### review ${r.state} (${r.user.login})\n\n${r.body}`);
  return [...verdicts, ...inline].join('\n\n') || 'No review comments.\n';
};

const blame = (clone, commit, file, from, to) => {
  try {
    const out = run('git', ['blame', '--porcelain', '-L', `${from},${to}`, `${commit}^`, '--', file], clone);
    return out
      .split('\n')
      .filter(l => /^[0-9a-f]{40} \d+ \d+/.test(l))
      .map(l => ({ sha: l.slice(0, 40), line: +l.split(' ')[1] }));
  } catch {
    return [];
  }
};

/** Later commits within 30 days on the default branch whose removed or changed lines the PR itself introduced. */
export const followupsOf = (clone, base, merged, mergedAt) => {
  const own = new Set(
    run('git', ['rev-list', `${base}..${merged}`], clone)
      .split('\n')
      .filter(Boolean)
  );
  const until = new Date(Date.parse(mergedAt) + 30 * 864e5).toISOString();
  const later = run(
    'git',
    ['rev-list', '--reverse', '--ancestry-path', `--before=${until}`, `${merged}..origin/HEAD`],
    clone
  )
    .split('\n')
    .filter(Boolean);
  const out = [];
  for (const commit of later) {
    const hunks = [];
    const diff = run('git', ['diff', '-U0', '--no-renames', `${commit}^`, commit], clone);
    let file;
    for (const line of diff.split('\n')) {
      if (line.startsWith('--- ')) file = line.slice(4).replace(/^a\//, '');
      const m = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
      if (!m || file === '/dev/null') continue;
      const from = +m[1];
      const to = from + Math.max(+(m[2] ?? 1) - 1, 0);
      if (m[2] === '0') continue;
      const lines = blame(clone, commit, file, from, to)
        .filter(b => own.has(b.sha))
        .map(b => b.line);
      if (lines.length) hunks.push({ file, start: Math.min(...lines), end: Math.max(...lines) });
    }
    if (hunks.length)
      out.push({ commit, subject: run('git', ['log', '-1', '--format=%s', commit], clone).trim(), hunks });
  }
  return out;
};

const mine = ({ repo, clone, out, since, limit }) => {
  const prs = gh(
    'pr',
    'list',
    '-R',
    repo,
    '--state',
    'merged',
    '--search',
    `merged:>=${since}`,
    '--limit',
    String(limit * 4),
    '--json',
    'number,title,body,author,mergedAt,mergeCommit,closingIssuesReferences'
  );
  const made = [];
  for (const pr of prs) {
    if (made.length >= limit) break;
    const issueNumber = pr.closingIssuesReferences?.[0]?.number;
    const issue = issueNumber && gh('issue', 'view', String(issueNumber), '-R', repo, '--json', 'title,body');
    const text = issue ? `# ${issue.title}\n\n${issue.body ?? ''}` : `# ${pr.title}\n\n${stripSolution(pr.body)}`;
    if (!issue && stripSolution(pr.body).length < 200) continue;
    const merged = pr.mergeCommit?.oid;
    if (!merged) continue;
    ensure(clone, merged);
    const base = mergeBase(clone, merged);
    const dir = join(out, `${repo.replace('/', '__')}-${pr.number}`);
    mkdirSync(dir, { recursive: true });
    const diff = run('git', ['diff', '--no-renames', base, merged], clone);
    writeFileSync(
      join(dir, 'case.json'),
      JSON.stringify(
        {
          repo,
          pr: pr.number,
          issue: issueNumber ?? null,
          base,
          merged,
          mergedAt: pr.mergedAt,
          title: pr.title,
          author: pr.author?.login,
          postCutoff: pr.mergedAt >= MEMORY_CUTOFF,
          diffLines: diff.split('\n').length,
        },
        null,
        2
      )
    );
    writeFileSync(join(dir, 'issue.md'), `${text}\n`);
    writeFileSync(join(dir, 'merged.diff'), diff);
    writeFileSync(join(dir, 'reviews.md'), reviewsOf(repo, pr.number));
    writeFileSync(join(dir, 'followups.json'), JSON.stringify(followupsOf(clone, base, merged, pr.mergedAt), null, 2));
    made.push(dir);
  }
  return made;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      clone: { type: 'string' },
      out: { type: 'string' },
      since: { type: 'string', default: MEMORY_CUTOFF },
      limit: { type: 'string', default: '10' },
    },
  });
  if (!positionals[0] || !values.clone || !values.out)
    throw new Error('usage: mine.mjs OWNER/REPO --clone DIR --out DIR [--since DATE] [--limit N]');
  for (const dir of mine({
    repo: positionals[0],
    clone: values.clone,
    out: values.out,
    since: values.since,
    limit: +values.limit,
  }))
    console.log(dir);
}
