/**
 * Plays the human on a forge folder or an instance, so `node bin/run.ts --forge <dir>` or `--instance <dir>` runs
 * without GitHub. `<dir>` may be any folder inside an instance.
 * Usage: node bin/forge.ts <dir> init <git repo> [--at <sha>]   (copies the repo, or only <sha> as main, into <dir>/origin.git)
 *        node bin/forge.ts <dir> init <git repo> --hub <hub> [--base <branch>]   (makes <dir> an instance of the repo)
 *        node bin/forge.ts <dir> issue <title> [--body <file>] [--label <name>]...
 *        node bin/forge.ts <dir> comment <n> <text> [--line <path>:<line>]
 *        node bin/forge.ts <dir> review <n> (approve|changes) [text]
 *        node bin/forge.ts <dir> label <n> <name>
 *        node bin/forge.ts <dir> close <n>
 *        node bin/forge.ts <dir> merge <n>   (fast-forwards the base branch, closes the pull request's issue)
 *        node bin/forge.ts <dir> show [n]
 *        node bin/forge.ts <dir> sync   (fast-forwards the instance's base from its repo)
 *        node bin/forge.ts <dir> export <n> [--patch <file>]   (the pull request's branch into the instance's repo)
 * Comments, labels and issues are by `--as <name>`, the instance's owner or `git config user.name`, as a maintainer.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Effect } from 'effect';
import { stringify } from 'yaml';
import { fileForge, Forge, formatIssueFile, parseIssueFile, writeIssueFile } from '../src/forge.ts';
import type { Event } from '../src/event.ts';
import type { Proposal } from '../src/proposal.ts';
import { instanceAt } from '../src/instance.ts';
import { readFileOrEmpty } from './resume.ts';

const { values, positionals } = parseArgs({
  options: {
    at: { type: 'string' },
    body: { type: 'string' },
    label: { type: 'string', multiple: true },
    as: { type: 'string' },
    hub: { type: 'string' },
    base: { type: 'string' },
    line: { type: 'string' },
    patch: { type: 'string' },
  },
  allowPositionals: true,
});
const [where, command, ...rest] = positionals;
if (!where || !command) {
  console.error('usage: node bin/forge.ts <dir> (init|issue|comment|review|label|close|merge|show|sync|export) ...');
  process.exit(2);
}
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const fresh = command === 'init' && values.hub !== undefined;
if (fresh) {
  const root = resolve(where);
  if (existsSync(join(root, 'instance.yaml'))) throw new Error(`${root} is an instance already`);
  mkdirSync(join(root, 'data'), { recursive: true });
  cpSync(resolve(values.hub!), join(root, 'hub'), { recursive: true });
  const owner = values.as ?? git('config', 'user.name');
  writeFileSync(
    join(root, 'instance.yaml'),
    stringify({ repo: resolve(rest[0] ?? '.'), base: values.base ?? 'main', owner })
  );
}
const instance = command === 'init' && !fresh ? undefined : instanceAt(where);
const dir = instance?.forge ?? resolve(where);
const origin = join(dir, 'origin.git');
const as = values.as ?? instance?.owner ?? git('config', 'user.name');
const forge = <A>(f: (forge: Forge['Type']) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(Effect.flatMap(Forge, f).pipe(Effect.provide(fileForge(dir, as))));
const apply = async (n: number, p: Proposal) => {
  const applied = await forge(f => f.apply(n, p));
  if (!applied.ok) throw new Error(applied.reason);
};
/** Appends what the human did to the timeline of `n`; a body makes it a comment with the next id. */
const record = (n: number, kind: Event['kind'], body?: string, placed: { path?: string; line?: number } = {}) => {
  const file = join(dir, `${n}.jsonl`);
  const at = new Date().toISOString();
  const count = readFileOrEmpty(file).split('\n').filter(Boolean).length;
  const comment = body === undefined ? {} : { comment: { id: `${n}-${count + 1}`, author: as, body, at, ...placed } };
  appendFileSync(file, `${JSON.stringify({ issue: n, kind, actor: as, trusted: true, at, ...comment })}\n`);
};
const close = (n: number) => {
  const md = join(dir, `${n}.md`);
  const { front, body } = parseIssueFile(readFileSync(md, 'utf8'));
  writeFileSync(md, formatIssueFile({ ...front, state: 'closed' }, body.trim()));
  record(n, 'closed');
};
const pullOf = async (n: number) => {
  const pr = await forge(f => f.issue(n));
  if (!pr.pull) throw new Error(`#${n} is not a pull request`);
  return pr.pull;
};
const own = () => {
  if (!instance) throw new Error(`${command} needs an instance, made with init --hub`);
  return instance;
};
const n = Number(rest[0]);
const text = rest.slice(1).join(' ');

switch (command) {
  case 'init': {
    mkdirSync(dir, { recursive: true });
    const base = values.base ?? 'main';
    if (values.at) {
      git('init', '-q', '--bare', '-b', base, origin);
      git('-C', resolve(rest[0] ?? '.'), 'push', '-q', origin, `${values.at}:refs/heads/${base}`);
    } else git('clone', '-q', '--bare', resolve(rest[0] ?? '.'), origin);
    if (values.base || fresh) git('--git-dir', origin, 'symbolic-ref', 'HEAD', `refs/heads/${base}`);
    console.log(`${origin} from ${rest[0] ?? '.'}`);
    break;
  }
  case 'issue': {
    const body = values.body ? readFileSync(values.body, 'utf8').trim() : '';
    console.log(`#${await writeIssueFile(dir, { title: rest[0]!, author: as, labels: values.label ?? [] }, body)}`);
    break;
  }
  case 'comment': {
    if (!values.line) {
      await apply(n, { kind: 'comment', body: text });
      break;
    }
    const [, path, line] = /^(.+):(\d+)$/.exec(values.line) ?? [];
    if (!path) throw new Error('--line takes <path>:<line>');
    await pullOf(n);
    record(n, 'comment', text, { path, line: Number(line) });
    break;
  }
  case 'review': {
    const kind = ({ approve: 'approved', changes: 'changes_requested' } as const)[rest[1] as 'approve'];
    if (!kind) throw new Error('review takes approve or changes');
    await pullOf(n);
    record(n, kind, rest.slice(2).join(' '));
    break;
  }
  case 'label':
    await apply(n, { kind: 'label', add: rest.slice(1) });
    break;
  case 'close':
    close(n);
    break;
  case 'merge': {
    const { base, branch, head } = await pullOf(n);
    git('--git-dir', origin, 'merge-base', '--is-ancestor', `refs/heads/${base}`, head);
    git('--git-dir', origin, 'update-ref', `refs/heads/${base}`, head);
    await apply(n, { kind: 'merge', number: n, head });
    for (const t of await forge(f => f.issues({ state: 'open' })))
      if (t.pull?.base === branch)
        writeFileSync(join(dir, String(t.number), 'pull.json'), `${JSON.stringify({ ...t.pull, base }, null, 2)}\n`);
    const issue = Number(/(\d+)$/.exec(branch)?.[1]);
    if (existsSync(join(dir, `${issue}.md`))) close(issue);
    console.log(`${base} at ${head}`);
    break;
  }
  case 'show': {
    if (!rest[0]) {
      for (const t of await forge(f => f.issues()))
        console.log(
          `#${t.number} ${t.state} ${t.title}${t.labels.length ? ` [${t.labels.join(', ')}]` : ''}${t.pull ? ` (${t.pull.branch} into ${t.pull.base})` : ''}`
        );
      break;
    }
    const t = await forge(f => f.issue(n));
    console.log(
      `#${t.number} ${t.state} ${t.title} by ${t.author}${t.labels.length ? ` [${t.labels.join(', ')}]` : ''}\n\n${t.body}\n`
    );
    for (const m of t.events) {
      const on = m.comment?.path ? ` on ${m.comment.path}${m.comment.line ? `:${m.comment.line}` : ''}` : '';
      const said = m.comment?.body ? `\n${m.comment.body}\n` : '';
      console.log(`${m.at} ${m.actor} ${m.kind}${m.label ? ` ${m.label}` : ''}${on}${said}`);
    }
    const diff = join(dir, String(n), 'diff.patch');
    if (t.pull) console.log(`\n${t.pull.branch} into ${t.pull.base} at ${t.pull.head}\n\n${readFileOrEmpty(diff)}`);
    break;
  }
  case 'sync': {
    const { repo, base } = own();
    git('--git-dir', origin, 'fetch', '-q', repo, `refs/heads/${base}`);
    const behind = (a: string, b: string) =>
      spawnSync('git', ['--git-dir', origin, 'merge-base', '--is-ancestor', a, b]).status === 0;
    if (!behind('FETCH_HEAD', `refs/heads/${base}`)) {
      if (!behind(`refs/heads/${base}`, 'FETCH_HEAD')) throw new Error(`${base} moved both here and in ${repo}`);
      git('--git-dir', origin, 'update-ref', `refs/heads/${base}`, 'FETCH_HEAD');
    }
    console.log(`${base} at ${git('--git-dir', origin, 'rev-parse', `refs/heads/${base}`)}`);
    break;
  }
  case 'export': {
    const { repo, base } = own();
    const { branch } = await pullOf(n);
    if (values.patch) {
      git('--git-dir', origin, 'fetch', '-q', repo, `refs/heads/${base}`);
      const patch = git('--git-dir', origin, 'format-patch', '--stdout', `FETCH_HEAD..refs/heads/${branch}`);
      writeFileSync(resolve(values.patch), `${patch}\n`);
      console.log(`${values.patch} from ${branch}`);
      break;
    }
    git('-C', repo, 'fetch', '-q', '--no-write-fetch-head', origin, `refs/heads/${branch}:refs/heads/${branch}`);
    console.log(`${branch} at ${git('-C', repo, 'rev-parse', `refs/heads/${branch}`)} in ${repo}`);
    break;
  }
  default:
    console.error(`unknown command ${command}`);
    process.exit(2);
}
