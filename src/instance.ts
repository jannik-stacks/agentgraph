import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import { parse, stringify } from 'yaml';
import type { Event, Issue } from './event.ts';
import { fileForge, Forge, formatIssueFile, parseIssueFile } from './forge.ts';
import { hostGit, makeHostEnv } from './git.ts';
import type { Proposal } from './proposal.ts';
import { writeFileAtomic } from './store.ts';

export type Instance = {
  dir: string;
  repo: string;
  base: string;
  owner: string;
  forge: string;
  data: string;
  exported: Record<string, string>;
  provider?: string;
};

export const defaultHub = fileURLToPath(new URL('../hub', import.meta.url));

const git = (env: Record<string, string>, args: string[], codes: number[] = []) =>
  Effect.runPromise(hostGit(env, args, { codes })).then(out => out.toString('utf8').trim());
const inRepo = (repo: string, args: string[], codes?: number[]) => git({}, ['-C', repo, ...args], codes);
const origin = (i: Pick<Instance, 'forge'>) => join(i.forge, 'origin.git');
const inForge = (i: Pick<Instance, 'forge'>, args: string[], codes?: number[]) =>
  git({ GIT_DIR: origin(i) }, args, codes);
const isAncestor = async (i: Pick<Instance, 'forge'>, a: string, b: string) =>
  (await inForge(i, ['merge-base', a, b], [1])) === a;

export const readRealPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(resolve(path));
    return parent === resolve(path) ? parent : join(readRealPath(parent), basename(path));
  }
};

export const findRepo = (from: string) =>
  inRepo(from, ['rev-parse', '--show-toplevel']).then(
    top => top || undefined,
    () => undefined
  );

const readOwner = (repo: string) => {
  try {
    return execFileSync('git', ['-C', repo, 'config', 'user.name'], { encoding: 'utf8', env: makeHostEnv() })
      .trim()
      .replaceAll(',', ' ');
  } catch {
    return userInfo().username;
  }
};

const readBranch = async (repo: string) => {
  const head = await inRepo(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], [1]);
  if (head) return head;
  const remote = await inRepo(repo, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], [1, 128]);
  return remote.replace(/^origin\//, '') || 'main';
};

const writeInstance = (i: Instance) =>
  writeFileAtomic(
    join(i.dir, 'instance.yaml'),
    stringify({
      repo: i.repo,
      base: i.base,
      owner: i.owner,
      ...(i.provider && { provider: i.provider }),
      exported: i.exported,
    })
  );

const readInstance = (dir: string): Instance | undefined => {
  const file = join(dir, 'instance.yaml');
  if (!existsSync(file)) return undefined;
  const own = parse(readFileSync(file, 'utf8')) as Pick<Instance, 'repo' | 'base' | 'owner'> &
    Partial<Pick<Instance, 'exported' | 'provider'>>;
  return { exported: {}, ...own, dir, forge: join(dir, 'forge'), data: join(dir, 'data') };
};

export const writeInstanceProvider = (i: Instance, provider: string) => {
  i.provider = provider;
  writeInstance({ ...(readInstance(i.dir) ?? i), provider });
};

export const findInstances = (root: string) =>
  (existsSync(root) ? readdirSync(root) : []).flatMap(name => readInstance(join(root, name)) ?? []);

export const ensureInstance = async (root: string, repo: string, base?: string) => {
  const real = realpathSync(repo);
  const inside = relative(real, readRealPath(root));
  if (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
    throw new Error(
      `the data dir ${root} is inside ${real}; pass --data or set AGENTGRAPH_DATA to a folder outside it`
    );
  const key = createHash('sha256').update(real).digest('hex').slice(0, 6);
  const dir = join(resolve(root), `${basename(real)}-${key}-local`);
  const found = readInstance(dir);
  if (found && (!base || base === found.base)) return { ...found, made: false };
  const i: Instance = found
    ? { ...found, base: base! }
    : {
        dir,
        repo: real,
        base: base ?? (await readBranch(real)),
        owner: readOwner(real),
        forge: join(dir, 'forge'),
        data: join(dir, 'data'),
        exported: {},
      };
  await mkdir(i.data, { recursive: true });
  if (!found) await git({}, ['init', '-q', '--bare', '-b', i.base, origin(i)]);
  await inForge(i, ['symbolic-ref', 'HEAD', `refs/heads/${i.base}`]);
  writeInstance(i);
  return { ...i, made: !found };
};

export const ensureBase = async (i: Instance): Promise<string | undefined> => {
  const mirror = 'refs/agentgraph/repo';
  await inForge(i, ['fetch', '-q', '--no-tags', i.repo, `+refs/heads/${i.base}:${mirror}`]);
  const theirs = await inForge(i, ['rev-parse', mirror]);
  const ours = await inForge(i, ['rev-parse', '-q', '--verify', `refs/heads/${i.base}`], [1]);
  if (!ours || (await isAncestor(i, ours, theirs))) {
    await inForge(i, ['update-ref', `refs/heads/${i.base}`, theirs, ours]);
    return undefined;
  }
  if (await isAncestor(i, theirs, ours)) return undefined;
  return [
    `${i.base} moved both in ${i.repo} (${theirs.slice(0, 7)}) and in agentgraph (${ours.slice(0, 7)}).`,
    `Merge agentgraph's ${i.base} into yours with \`git merge ${ours}\`, or reset it in your repo, then try again.`,
  ].join('\n');
};

export const ensureHub = async (i: Instance, flag?: string) => {
  if (flag) return resolve(flag);
  const tree = await inForge(i, ['rev-parse', '-q', '--verify', `refs/heads/${i.base}:.agentgraph`], [1, 128]);
  if (!tree) return defaultHub;
  const dir = join(i.dir, 'hubs', tree);
  if (existsSync(dir)) return dir;
  const draft = `${dir}.${randomUUID()}`;
  const index = { GIT_DIR: origin(i), GIT_INDEX_FILE: `${draft}.index`, GIT_WORK_TREE: draft };
  await mkdir(draft, { recursive: true });
  try {
    await git(index, ['read-tree', tree]);
    await git(index, ['checkout-index', '-a']);
    await rename(draft, dir).catch(() => undefined);
  } finally {
    await rm(draft, { recursive: true, force: true });
    await rm(index.GIT_INDEX_FILE, { force: true });
  }
  return dir;
};

const readIssues = (dir: string) =>
  Effect.runPromise(Effect.flatMap(Forge, f => f.issues()).pipe(Effect.provide(fileForge(dir))));

export const findPull = async (dir: string, n: number) => {
  const pulls = (await readIssues(dir)).filter(
    (t): t is Issue & Required<Pick<Issue, 'pull'>> =>
      !!t.pull && (t.number === n || t.pull.branch === `agentgraph/${n}`)
  );
  return pulls.find(t => t.state === 'open') ?? pulls.at(-1);
};

const apply = async (dir: string, as: string, n: number, p: Proposal) => {
  const applied = await Effect.runPromise(
    Effect.flatMap(Forge, f => f.apply(n, p)).pipe(Effect.provide(fileForge(dir, as)))
  );
  if (!applied.ok) throw new Error(applied.reason);
};

const record = (
  dir: string,
  as: string,
  n: number,
  kind: Event['kind'],
  body?: string,
  placed: { path?: string; line?: number } = {}
) => {
  const file = join(dir, `${n}.jsonl`);
  const at = new Date().toISOString();
  const count = (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n').filter(Boolean).length;
  const comment = body === undefined ? {} : { comment: { id: `${n}-${count + 1}`, author: as, body, at, ...placed } };
  appendFileSync(file, `${JSON.stringify({ issue: n, kind, actor: as, trusted: true, at, ...comment })}\n`);
};

export const writeComment = async (dir: string, as: string, n: number, body: string, line?: string) => {
  if (!line) return apply(dir, as, n, { kind: 'comment', body });
  const [, path, at] = /^(.+):(\d+)$/.exec(line) ?? [];
  if (!path) throw new Error('--line takes <path>:<line>');
  const pull = await findPull(dir, n);
  if (!pull) throw new Error(`#${n} has no pull request`);
  record(dir, as, pull.number, 'comment', body, { path, line: Number(at) });
};

export const writeReview = async (
  dir: string,
  as: string,
  n: number,
  verdict: 'approved' | 'changes_requested',
  text: string
) => {
  const pull = await findPull(dir, n);
  if (!pull || pull.state !== 'open') throw new Error(`#${n} has no open pull request`);
  record(dir, as, pull.number, verdict, text);
};

export const writeClosed = (dir: string, as: string, n: number) => {
  const md = join(dir, `${n}.md`);
  if (!existsSync(md)) throw new Error(`no issue #${n}`);
  const { front, body } = parseIssueFile(readFileSync(md, 'utf8'));
  writeFileAtomic(md, formatIssueFile({ ...front, state: 'closed' }, body.trim()));
  record(dir, as, n, 'closed');
};

export const mergePull = async (i: Pick<Instance, 'forge' | 'owner'>, n: number) => {
  const pr = await findPull(i.forge, n);
  if (!pr || pr.state !== 'open') throw new Error(`#${n} has no open pull request`);
  const { base, branch, head } = pr.pull;
  const at = await inForge(i, ['rev-parse', `refs/heads/${base}`]);
  if (!(await isAncestor(i, at, head)))
    throw new Error(`${base} moved since ${branch} branched; review ${n} changes "rebase" first`);
  await inForge(i, ['update-ref', `refs/heads/${base}`, head, at]);
  await apply(i.forge, i.owner, pr.number, { kind: 'merge', number: pr.number, head });
  for (const t of await readIssues(i.forge))
    if (t.state === 'open' && t.pull?.base === branch)
      await writeFile(
        join(i.forge, String(t.number), 'pull.json'),
        `${JSON.stringify({ ...t.pull, base }, null, 2)}\n`
      );
  const issue = Number(/(\d+)$/.exec(branch)?.[1]);
  const named = (await readIssues(i.forge)).find(t => t.number === issue);
  if (named?.state === 'open') writeClosed(i.forge, i.owner, issue);
  return pr.pull;
};

export const writePullToRepo = async (
  i: Instance,
  n: number,
  to: { as?: string; patch?: string } = {}
): Promise<{ ref: string; base: string; stat: string } | { why: string } | undefined> => {
  const pr = await findPull(i.forge, n);
  if (!pr) return undefined;
  const { branch, base } = pr.pull;
  const head = await inForge(i, ['rev-parse', `refs/heads/${branch}`]);
  const stat = await inForge(i, ['diff', '--stat', '--no-ext-diff', '--no-textconv', `refs/heads/${base}...${head}`]);
  if (to.patch && pr.state === 'merged') return { why: `#${pr.number} is merged into ${base}` };
  if (to.patch) {
    const patch = await inForge(i, ['format-patch', '--stdout', `refs/heads/${base}..${head}`]);
    await writeFile(resolve(to.patch), `${patch}\n`);
    return { ref: resolve(to.patch), base, stat };
  }
  const ref = `refs/heads/${to.as ?? branch}`;
  const name = ref.slice('refs/heads/'.length);
  const current = await inRepo(i.repo, ['rev-parse', '-q', '--verify', ref], [1]);
  if (current === head) return { ref: name, base, stat };
  if (current && current !== i.exported[ref]) return { why: `${name} in your repo moved since agentgraph wrote it` };
  const checkedOut = (await inRepo(i.repo, ['worktree', 'list', '--porcelain'])).split('\n');
  if (checkedOut.includes(`branch ${ref}`)) return { why: `${name} is checked out in your repo` };
  await inRepo(i.repo, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', origin(i), `refs/heads/${branch}`]);
  await inRepo(i.repo, ['update-ref', ref, head, current]);
  const saved = readInstance(i.dir) ?? i;
  i.exported = { ...saved.exported, [ref]: head };
  writeInstance({ ...saved, exported: i.exported });
  return { ref: name, base, stat };
};
