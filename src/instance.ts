import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import { parse, stringify } from 'yaml';
import type { Issue } from './event.ts';
import { fileForge, Forge, formatIssueFile, parseIssueFile, writeTimelineEvent } from './forge.ts';
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
  readonly?: boolean;
};

export const defaultDir = fileURLToPath(new URL('../default', import.meta.url));

const git = (env: Record<string, string>, args: string[], codes: number[] = [], input?: Uint8Array) =>
  Effect.runPromise(hostGit(env, args, { codes, ...(input && { input }) })).then(out => out.toString('utf8').trim());
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
    return undefined;
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
      ...(i.readonly && { readonly: true }),
      exported: i.exported,
    })
  );

const readInstance = (dir: string): Instance | undefined => {
  const file = join(dir, 'instance.yaml');
  if (!existsSync(file)) return undefined;
  const own = parse(readFileSync(file, 'utf8')) as Pick<Instance, 'repo' | 'base' | 'owner'> &
    Partial<Pick<Instance, 'exported' | 'provider' | 'readonly'>>;
  return { exported: {}, ...own, dir, forge: join(dir, 'forge'), data: join(dir, 'data') };
};

export const writeInstanceProvider = (i: Instance, provider: string) => {
  i.provider = provider;
  writeInstance({ ...(readInstance(i.dir) ?? i), provider });
};

export const findInstances = (root: string) =>
  (existsSync(root) ? readdirSync(root) : []).flatMap(name => readInstance(join(root, name)) ?? []);

const isInside = (dir: string, path: string) => {
  const inside = relative(dir, path);
  return inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
};

export const ensureInstance = async (root: string, repo: string, base?: string, readonly?: boolean) => {
  const real = realpathSync(repo);
  const common = readRealPath(await inRepo(real, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const assertOutside = (path: string) => {
    if ([real, common].some(dir => isInside(dir, readRealPath(path))))
      throw new Error(
        `the data dir ${path} is inside ${real}; pass --data or set AGENTGRAPH_DATA to a folder outside it`
      );
  };
  assertOutside(root);
  const key = createHash('sha256').update(real).digest('hex').slice(0, 6);
  const dir = join(resolve(root), `${basename(real)}-${key}-local`);
  const found = readInstance(dir);
  const paths = [dir, found?.data ?? join(dir, 'data'), origin(found ?? { forge: join(dir, 'forge') })];
  paths.forEach(assertOutside);
  if (found && (!base || base === found.base) && (!readonly || found.readonly)) return { ...found, made: false };
  const named = found ? found.owner : readOwner(real);
  const i: Instance = found
    ? { ...found, base: base ?? found.base, ...(readonly && { readonly }) }
    : {
        dir,
        repo: real,
        base: base ?? (await readBranch(real)),
        owner: named ?? userInfo().username,
        forge: join(dir, 'forge'),
        data: join(dir, 'data'),
        exported: {},
        ...(readonly && { readonly }),
      };
  await mkdir(i.data, { recursive: true });
  paths.forEach(assertOutside);
  if (!found) await git({}, ['init', '-q', '--bare', '-b', i.base, origin(i)]);
  await inForge(i, ['symbolic-ref', 'HEAD', `refs/heads/${i.base}`]);
  writeInstance(i);
  return { ...i, made: !found, ...(!named && { unnamed: true }) };
};

export const ensureBase = async (i: Instance): Promise<string | undefined> => {
  const mirror = 'refs/agentgraph/repo';
  await inForge(i, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', i.repo, `+refs/heads/${i.base}:${mirror}`]);
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

export const ensureGraph = async (i: Instance, flag?: string) => {
  if (flag) return resolve(flag);
  const tree = await inForge(i, ['rev-parse', '-q', '--verify', `refs/heads/${i.base}:.agentgraph`], [1, 128]);
  if (!tree) return existsSync(join(i.repo, '.agentgraph')) ? join(i.repo, '.agentgraph') : defaultDir;
  const dir = join(i.dir, 'graphs', tree);
  if (existsSync(dir)) return dir;
  const linked = (await inForge(i, ['ls-tree', '-r', tree])).split('\n').filter(l => /^(120000|160000) /.test(l));
  if (linked.length)
    throw new Error(`.agentgraph holds links or submodules: ${linked.map(l => l.split('\t')[1]).join(', ')}`);
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

const isCommittedGraph = (i: Instance, graph: string) => graph.startsWith(join(i.dir, 'graphs'));

export const whyGraphUncommitted = async (i: Instance, graph: string) => {
  if (!isCommittedGraph(i, graph)) return undefined;
  const listed = await inRepo(i.repo, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    '.agentgraph',
  ]);
  const local = new Set(
    listed
      .split('\0')
      .filter(Boolean)
      .map(p => relative('.agentgraph', p))
  );
  const committed = readdirSync(graph, { recursive: true, encoding: 'utf8' }).filter(p =>
    statSync(join(graph, p)).isFile()
  );
  const same = (p: string) => {
    const mine = join(i.repo, '.agentgraph', p);
    return existsSync(mine) && readFileSync(mine).equals(readFileSync(join(graph, p)));
  };
  return committed.length === local.size && committed.every(p => local.has(p) && same(p))
    ? undefined
    : `.agentgraph/ has uncommitted changes; runs use the committed version on ${i.base}. Commit them, or pass --dir .agentgraph to try them.`;
};

export const formatGraphName = async (i: Instance, graph: string) => {
  if (graph === defaultDir) return 'default graph';
  if (graph === join(i.repo, '.agentgraph') && !(await inRepo(i.repo, ['ls-files', '--', '.agentgraph'])))
    return 'graph .agentgraph/ (not in git)';
  if (!isCommittedGraph(i, graph)) return `graph ${graph}`;
  return `.agentgraph/ at ${i.base} ${await inForge(i, ['rev-parse', '--short', `refs/heads/${i.base}`])}`;
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

const writeTrustedEvent = (
  dir: string,
  as: string,
  m: Omit<Parameters<typeof writeTimelineEvent>[1], 'actor' | 'trusted'>
) => writeTimelineEvent(dir, { ...m, actor: as, trusted: true });

export const writeComment = async (dir: string, as: string, n: number, body: string, line?: string) => {
  if (!line) return apply(dir, as, n, { kind: 'comment', body });
  const [, path, at] = /^(.+):(\d+)$/.exec(line) ?? [];
  if (!path) throw new Error('--line takes <path>:<line>');
  const pull = await findPull(dir, n);
  if (!pull) throw new Error(`#${n} has no pull request`);
  await writeTrustedEvent(dir, as, { issue: pull.number, kind: 'comment', comment: { body, path, line: Number(at) } });
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
  await writeTrustedEvent(dir, as, { issue: pull.number, kind: verdict, comment: { body: text } });
};

export const writeLabels = (dir: string, as: string, n: number, add: string[]) =>
  apply(dir, as, n, { kind: 'label', add, remove: [] });

export const writeClosed = async (dir: string, as: string, n: number) => {
  const md = join(dir, `${n}.md`);
  if (!existsSync(md)) throw new Error(`no issue #${n}`);
  const { front, body } = parseIssueFile(readFileSync(md, 'utf8'));
  writeFileAtomic(md, formatIssueFile({ ...front, state: 'closed' }, body.trim()));
  await writeTrustedEvent(dir, as, { issue: n, kind: 'closed' });
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
      writeFileAtomic(join(i.forge, String(t.number), 'pull.json'), { ...t.pull, base });
  const issue = Number(/(\d+)$/.exec(branch)?.[1]);
  const named = (await readIssues(i.forge)).find(t => t.number === issue);
  if (named?.state === 'open') await writeClosed(i.forge, i.owner, issue);
  return pr.pull;
};

export const writePullToRepo = async (
  i: Instance,
  n: number,
  to: { as?: string; patch?: string; auto?: boolean } = {}
): Promise<{ ref: string; base: string; stat: string } | { why: string } | undefined> => {
  const pr = await findPull(i.forge, n);
  if (!pr) return undefined;
  const { branch, base, head } = pr.pull;
  const stat = await inForge(i, ['diff', '--stat', '--no-ext-diff', '--no-textconv', `refs/heads/${base}...${head}`]);
  if (to.patch && pr.state === 'merged') return { why: `#${pr.number} is merged into ${base}` };
  if (to.patch) {
    const patch = await inForge(i, ['format-patch', '--stdout', `refs/heads/${base}..${head}`]);
    await writeFile(resolve(to.patch), `${patch}\n`, { flag: 'wx' });
    return { ref: resolve(to.patch), base, stat };
  }
  const saved = readInstance(i.dir) ?? i;
  if (saved.readonly) return { why: `agentgraph does not write to ${i.repo}; pass --patch <file>` };
  const name = to.as ?? branch;
  const ref = `refs/heads/${name}`;
  if (!name.startsWith('agentgraph/')) return { why: `${name} is not an agentgraph/ branch` };
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head) || !(await succeeds(git({}, ['check-ref-format', ref]))))
    return { why: `${name} is not a branch` };
  const current = await inRepo(i.repo, ['rev-parse', '-q', '--verify', ref], [1]);
  if (current === head) return { ref: name, base, stat };
  const exported = saved.exported[ref];
  if (current && current !== exported) return { why: `${name} in your repo moved since agentgraph wrote it` };
  if (!current && exported && to.auto)
    return { why: `${name} was deleted in your repo; agi export ${n} writes it again` };
  const checkedOut = (await inRepo(i.repo, ['worktree', 'list', '--porcelain'])).split('\n');
  if (checkedOut.includes(`branch ${ref}`)) return { why: `${name} is checked out in your repo` };
  const haves: string[] = [];
  for (const at of [await inForge(i, ['rev-parse', '-q', '--verify', 'refs/agentgraph/repo'], [1]), exported])
    if (at && (await succeeds(inRepo(i.repo, ['cat-file', '-e', `${at}^{commit}`])))) haves.push(at);
  const list = await inForge(i, ['rev-list', '--objects', head, '--not', ...haves]);
  const keep = list ? await sendPack(i, list) : undefined;
  try {
    await inRepo(i.repo, ['rev-list', '--objects', '--quiet', head, '--not', '--all']);
    await inRepo(i.repo, ['update-ref', '--no-deref', '-m', 'agentgraph export', ref, head, current]);
  } finally {
    if (keep) await rm(keep, { force: true });
  }
  const now = readInstance(i.dir) ?? i;
  i.exported = { ...now.exported, [ref]: head };
  writeInstance({ ...now, exported: i.exported });
  return { ref: name, base, stat };
};

const succeeds = (run: Promise<unknown>) =>
  run.then(
    () => true,
    () => false
  );

const sendPack = async (i: Instance, list: string) => {
  const packs = await inRepo(i.repo, ['rev-parse', '--path-format=absolute', '--git-path', 'objects/pack']);
  const pack = await Effect.runPromise(
    hostGit({ GIT_DIR: origin(i) }, ['pack-objects', '-q', '--stdout'], { input: list })
  );
  const [, id] =
    /^keep\t(\w+)$/m.exec(
      await git({}, ['-C', i.repo, 'index-pack', '--stdin', '--strict', '--keep=agentgraph export'], [], pack)
    ) ?? [];
  if (!id) throw new Error(`git index-pack kept no pack in ${i.repo}`);
  return join(packs, `pack-${id}.keep`);
};
