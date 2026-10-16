/**
 * Plays the human on a forge folder, so `node bin/run.ts --forge <dir>` runs without GitHub.
 * Usage: node bin/forge.ts <dir> init <git repo>   (copies the repo into <dir>/origin.git)
 *        node bin/forge.ts <dir> issue <title> [--body <file>] [--label <name>]...
 *        node bin/forge.ts <dir> comment <n> <text>
 *        node bin/forge.ts <dir> label <n> <name>
 *        node bin/forge.ts <dir> close <n>
 *        node bin/forge.ts <dir> merge <n>   (fast-forwards the base branch, closes the pull request's issue)
 *        node bin/forge.ts <dir> show [n]
 * Comments, labels and issues are by `--as <name>`, or by `git config user.name`, as a maintainer.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Effect } from 'effect';
import { stringify } from 'yaml';
import { fileForge, Forge, type Proposal } from '../src/forge.ts';

const { values, positionals } = parseArgs({
  options: { body: { type: 'string' }, label: { type: 'string', multiple: true }, as: { type: 'string' } },
  allowPositionals: true,
});
const [where, command, ...rest] = positionals;
if (!where || !command) {
  console.error('usage: node bin/forge.ts <dir> (init|issue|comment|label|close|merge|show) ...');
  process.exit(2);
}
const dir = resolve(where);
const origin = join(dir, 'origin.git');
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const as = values.as ?? git('config', 'user.name');
const forge = <A>(f: (forge: Forge['Type']) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(Effect.flatMap(Forge, f).pipe(Effect.provide(fileForge(dir, as))));
const apply = async (n: number, p: Proposal) => {
  const applied = await forge(f => f.apply(n, p));
  if (!applied.ok) throw new Error(applied.reason);
};
const close = (n: number) => {
  const md = join(dir, `${n}.md`);
  writeFileSync(md, readFileSync(md, 'utf8').replace(/^state: open$/m, 'state: closed'));
  const at = new Date().toISOString();
  appendFileSync(
    join(dir, `${n}.jsonl`),
    `${JSON.stringify({ issue: n, kind: 'closed', actor: as, trusted: true, at })}\n`
  );
};
const n = Number(rest[0]);

switch (command) {
  case 'init': {
    mkdirSync(dir, { recursive: true });
    git('clone', '-q', '--bare', resolve(rest[0] ?? '.'), origin);
    console.log(`${origin} from ${rest[0] ?? '.'}`);
    break;
  }
  case 'issue': {
    const all = await forge(f => f.issues());
    const k = Math.max(0, ...all.map(t => t.number)) + 1;
    const body = values.body ? readFileSync(values.body, 'utf8').trim() : '';
    writeFileSync(
      join(dir, `${k}.md`),
      `---\n${stringify({ title: rest[0], state: 'open', author: as, labels: [] })}---\n\n${body}\n`
    );
    for (const label of values.label ?? []) await apply(k, { kind: 'label', add: [label] });
    console.log(`#${k}`);
    break;
  }
  case 'comment':
    await apply(n, { kind: 'comment', body: rest.slice(1).join(' ') });
    break;
  case 'label':
    await apply(n, { kind: 'label', add: rest.slice(1) });
    break;
  case 'close':
    close(n);
    break;
  case 'merge': {
    const pr = await forge(f => f.issue(n));
    if (!pr.pull) throw new Error(`#${n} is not a pull request`);
    const { base, branch, head } = pr.pull;
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
    for (const m of t.events)
      console.log(
        `${m.at} ${m.actor} ${m.kind}${m.label ? ` ${m.label}` : ''}${m.comment ? `\n${m.comment.body}\n` : ''}`
      );
    const diff = join(dir, String(n), 'diff.patch');
    if (t.pull)
      console.log(
        `\n${t.pull.branch} into ${t.pull.base} at ${t.pull.head}\n\n${existsSync(diff) ? readFileSync(diff, 'utf8') : ''}`
      );
    break;
  }
  default:
    console.error(`unknown command ${command}`);
    process.exit(2);
}
