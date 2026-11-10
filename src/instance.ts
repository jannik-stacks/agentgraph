import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, Schema } from 'effect';
import { parse, stringify } from 'yaml';
import { InstanceFile } from './settings.ts';
import { readDirOrEmpty, readOrUndefined } from './read.ts';
import { getCachePath } from './env.ts';
import {
  findBranchPull,
  findIssueDir,
  isAgentBranch,
  pushLimits,
  folderTracker,
  Tracker,
  formatIssueFile,
  parseIssueFile,
  runLocked,
  writeProposal,
  writeTimelineEvent,
} from './tracker.ts';
import { gitIdentity, hostGit, makeHostEnv, readGit } from './git.ts';
import type { JsonValue } from './meta.ts';
import type { Proposal } from './proposal.ts';
import { formatInstanceFlags, formatShellWord } from './status.ts';
import { fileStore, Store, writeFileAtomic } from './store.ts';
import { startRun } from './run/start.ts';
import { type RunRecord } from './types.ts';

export type Instance = Omit<typeof InstanceFile.Type, 'tracker'> & {
  dir: string;
  tracker: string;
  trackerName?: string;
  data: string;
};

const git = (env: Record<string, string>, args: string[], codes: number[] = [], input?: Uint8Array) =>
  Effect.runPromise(readGit(env, args, { codes, ...(input && { input }) }));
const inRepo = (repo: string, args: string[], codes?: number[]) => git({}, ['-C', repo, ...args], codes);
const origin = (i: Pick<Instance, 'tracker'>) => join(i.tracker, 'origin.git');
const inTracker = (i: Pick<Instance, 'tracker'>, args: string[], codes?: number[]) =>
  git({ GIT_DIR: origin(i) }, args, codes);
const isAncestor = async (i: Pick<Instance, 'tracker'>, a: string, b: string) =>
  (await inTracker(i, ['merge-base', a, b], [1])) === a;

export const readRealPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch (e) {
    readOrUndefined(e);
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

const writeInstance = ({ dir, data: _data, tracker: _tracker, trackerName, ...record }: Instance) =>
  writeFileAtomic(join(dir, 'instance.yaml'), stringify({ ...record, ...(trackerName && { tracker: trackerName }) }));

export const readInstance = (root: string, name: string): Instance | undefined => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error('instance name must be one path component');
  const dir = join(resolve(root), name);
  const file = join(dir, 'instance.yaml');
  if (!existsSync(file)) return undefined;
  const { tracker: trackerName, ...own } = Schema.decodeUnknownSync(InstanceFile, { onExcessProperty: 'error' })(
    parse(readFileSync(file, 'utf8'))
  );
  return {
    ...own,
    checkout: readRealPath(resolve(dir, own.checkout)),
    ...(own.graph !== undefined && { graph: resolve(dir, own.graph) }),
    ...(own.env !== undefined && { env: resolve(dir, own.env) }),
    ...(trackerName && { trackerName }),
    dir,
    tracker: join(dir, 'tracker'),
    data: join(dir, 'data'),
  };
};

export const writeInstanceProvider = (i: Instance, provider: string) => {
  i.provider = provider;
  writeInstance({ ...(readInstance(dirname(i.dir), basename(i.dir)) ?? i), provider });
};

export const findInstances = (root: string) =>
  readDirOrEmpty(root).flatMap(name => {
    const file = join(root, name, 'instance.yaml');
    if (!existsSync(file)) return [];
    try {
      return readInstance(root, name) ?? [];
    } catch (e) {
      console.error(`skipping ${file}: ${String(e).split('\n')[0]}`);
      return [];
    }
  });

export const readPickedInstance = async (root: string, name: string | undefined, creating: boolean) => {
  const found = name === undefined ? undefined : readInstance(root, name);
  if (found || creating || name === undefined) return found;
  const names = findInstances(root).map(i => basename(i.dir));
  throw new Error(
    `no instance ${name} under ${root}${names.length ? `; it holds ${names.join(', ')}` : ''}. Pass --repo <dir> to create it`
  );
};

const isInside = (dir: string, path: string) => {
  const inside = relative(dir, path);
  return inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
};

const isOtherInstance = (root: string, name: string, checkout: string) => {
  try {
    const at = readInstance(root, name)?.checkout;
    return at !== undefined && at !== checkout;
  } catch {
    return false;
  }
};

export const ensureInstance = async (
  root: string,
  picked: string | undefined,
  checkout: string,
  base?: string,
  readonly?: boolean
) => {
  const real = realpathSync(checkout);
  const common = readRealPath(await inRepo(real, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const assertOutside = (path: string) => {
    if ([real, common].some(dir => isInside(dir, readRealPath(path))))
      throw new Error(
        `the data dir ${path} is inside ${real}; pass --data or set AGENTGRAPH_DATA to a folder outside it`
      );
  };
  assertOutside(root);
  const name = picked ?? basename(checkout);
  const found = readInstance(root, name);
  const unknown = (found || picked ? [] : readDirOrEmpty(root)).filter(
    n =>
      n !== name &&
      n !== 'logs' &&
      statSync(join(root, n), { throwIfNoEntry: false })?.isDirectory() &&
      !isOtherInstance(root, n, real)
  );
  if (unknown.length)
    throw new Error(
      `${root} has no instance ${name} but holds ${unknown.join(', ')}; pass --instance <name> to use one, or --instance ${name} --repo ${formatShellWord(checkout)} to make it`
    );
  const dir = join(resolve(root), name);
  if (found && found.checkout !== real) throw new Error(`instance ${name} belongs to ${found.checkout}, not ${real}`);
  const paths = [dir, found?.data ?? join(dir, 'data'), origin(found ?? { tracker: join(dir, 'tracker') })];
  paths.forEach(assertOutside);
  if (found && (!base || base === found.base) && (!readonly || found.readonly)) return { ...found, made: false };
  const named = found ? found.owner : readOwner(real);
  const i: Instance = found
    ? { ...found, base: base ?? found.base, ...(readonly && { readonly }) }
    : {
        dir,
        checkout: real,
        base: base ?? (await readBranch(real)),
        owner: named ?? userInfo().username,
        tracker: join(dir, 'tracker'),
        data: join(dir, 'data'),
        exported: {},
        loop: false,
        ...(readonly && { readonly }),
      };
  await mkdir(i.data, { recursive: true });
  paths.forEach(assertOutside);
  if (!found) await git({}, ['init', '-q', '--bare', '-b', i.base, origin(i)]);
  if (existsSync(origin(i))) await inTracker(i, ['symbolic-ref', 'HEAD', `refs/heads/${i.base}`]);
  writeInstance(i);
  return { ...i, made: !found, ...(!named && { unnamed: true }) };
};

export const ensureBase = async (i: Instance): Promise<string | undefined> => {
  const mirror = 'refs/agentgraph/repo';
  await inTracker(i, [
    'fetch',
    '-q',
    '--no-tags',
    '--no-write-fetch-head',
    i.checkout,
    `+refs/heads/${i.base}:${mirror}`,
  ]);
  const theirs = await inTracker(i, ['rev-parse', mirror]);
  const ours = await inTracker(i, ['rev-parse', '-q', '--verify', `refs/heads/${i.base}`], [1]);
  if (!ours || (await isAncestor(i, ours, theirs))) {
    await inTracker(i, ['update-ref', `refs/heads/${i.base}`, theirs, ours]);
    return undefined;
  }
  if (await isAncestor(i, theirs, ours)) return undefined;
  return [
    `${i.base} moved both in ${i.checkout} (${theirs.slice(0, 7)}) and in agentgraph (${ours.slice(0, 7)}).`,
    `Merge agentgraph's ${i.base} into yours with \`git merge ${ours}\`, or reset it in your repo, then try again.`,
  ].join('\n');
};

const readGraphSource = async (i: Instance) => ({
  GIT_DIR: existsSync(origin(i)) ? origin(i) : await inRepo(i.checkout, ['rev-parse', '--absolute-git-dir']),
});

export const ensureGraph = async (i: Instance, flag = i.graph) => {
  const env = flag ? {} : await readGraphSource(i);
  if (!flag && !existsSync(origin(i))) await git(env, ['rev-parse', '--verify', `refs/heads/${i.base}`]);
  const tree = flag
    ? undefined
    : await git(env, ['rev-parse', '-q', '--verify', `refs/heads/${i.base}:.agentgraph`], [1, 128]);
  if (!tree) {
    const dir = flag ? resolve(flag) : join(i.checkout, '.agentgraph');
    if (existsSync(dir)) return dir;
    const example = fileURLToPath(new URL('../examples/starter', import.meta.url));
    throw new Error(
      `no graph found. Copy an example into this folder first:\n  cp -R ${formatShellWord(example)} ${formatShellWord(dir)}`
    );
  }
  const dir = getCachePath(i.data, 'graphs', tree);
  if (existsSync(dir)) return dir;
  const linked = (await git(env, ['ls-tree', '-r', tree])).split('\n').filter(l => /^(120000|160000) /.test(l));
  if (linked.length)
    throw new Error(`.agentgraph holds links or submodules: ${linked.map(l => l.split('\t')[1]).join(', ')}`);
  const draft = `${dir}.${randomUUID()}`;
  const index = { ...env, GIT_INDEX_FILE: `${draft}.index`, GIT_WORK_TREE: draft };
  await mkdir(draft, { recursive: true });
  try {
    await git(index, ['read-tree', tree]);
    await git(index, ['checkout-index', '-a']);
    await rename(draft, dir).catch(e => {
      if (!['EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e;
    });
  } finally {
    await rm(draft, { recursive: true, force: true });
    await rm(index.GIT_INDEX_FILE, { force: true });
  }
  return dir;
};

export const ensureInstanceGraph = async (i: Instance, flag?: string) => {
  if (!flag && !i.graph && existsSync(origin(i))) {
    const why = await ensureBase(i);
    if (why) throw new Error(why);
  }
  return ensureGraph(i, flag);
};

export const isCommittedGraph = (i: Instance, graph: string) => graph.startsWith(getCachePath(i.data, 'graphs'));

export const whyGraphUncommitted = async (i: Instance, graph: string) => {
  if (!isCommittedGraph(i, graph)) return undefined;
  const listed = await inRepo(i.checkout, [
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
    const mine = join(i.checkout, '.agentgraph', p);
    return existsSync(mine) && readFileSync(mine).equals(readFileSync(join(graph, p)));
  };
  return committed.length === local.size && committed.every(p => local.has(p) && same(p))
    ? undefined
    : `.agentgraph/ has uncommitted changes; runs use the committed version on ${i.base}. Commit them, or pass --dir .agentgraph to try them.`;
};

export const formatGraphName = async (i: Instance, graph: string) => {
  if (graph === join(i.checkout, '.agentgraph') && !(await inRepo(i.checkout, ['ls-files', '--', '.agentgraph'])))
    return 'graph .agentgraph/ (not in git)';
  if (!isCommittedGraph(i, graph)) return `graph ${graph}`;
  const at = await readGraphSource(i)
    .then(env => git(env, ['rev-parse', '--short', `refs/heads/${i.base}`]))
    .catch(() => '');
  return `.agentgraph/ at ${i.base} ${at}`.trim();
};

const readIssues = (dir: string) =>
  Effect.runPromise(Effect.flatMap(Tracker, f => f.issues()).pipe(Effect.provide(folderTracker(dir))));

const readRuns = (data: string) =>
  Effect.runPromise(Effect.flatMap(Store, s => s.list()).pipe(Effect.provide(fileStore(data))));

export const findPull = async (i: Pick<Instance, 'tracker' | 'data'>, n: number) => {
  const [issues, runs] = await Promise.all([readIssues(i.tracker), readRuns(i.data)]);
  const own = issues.find(t => t.number === n && t.pull);
  const branch = runs
    .filter(r => r.issue === n && r.checkout?.branch)
    .toSorted((a, b) => a.started.localeCompare(b.started))
    .at(-1)?.checkout?.branch;
  return findBranchPull(own ? [own] : issues, own?.pull?.branch ?? branch);
};

const findBranchIssue = async (i: Pick<Instance, 'data'>, branch: string) =>
  (await readRuns(i.data)).find(r => r.checkout?.branch === branch)?.issue;

const apply = (dir: string, as: string, n: number, p: Proposal) =>
  Effect.runPromise(writeProposal(n, p).pipe(Effect.provide(folderTracker(dir, as))));

const writeTrustedEvent = (
  dir: string,
  as: string,
  m: Omit<Parameters<typeof writeTimelineEvent>[1], 'actor' | 'trusted'>
) => runLocked(dir, () => writeTimelineEvent(dir, { ...m, actor: as, trusted: true }));

export const writeComment = (dir: string, as: string, n: number, body: string) =>
  apply(dir, as, n, { kind: 'comment', body });

export const writeLineComment = async (
  i: Pick<Instance, 'tracker' | 'owner' | 'data'>,
  n: number,
  body: string,
  line: string
) => {
  const [, path, at] = /^(.+):(\d+)$/.exec(line) ?? [];
  if (!path) throw new Error('--line takes <path>:<line>');
  const pull = await findPull(i, n);
  if (!pull) throw new Error(`#${n} has no pull request`);
  await writeTrustedEvent(i.tracker, i.owner, {
    issue: pull.number,
    kind: 'comment',
    comment: { body, path, line: Number(at) },
  });
};

export const findPullIssue = async (i: Pick<Instance, 'tracker' | 'data'>, n: number) => {
  const pull = await findPull(i, n);
  return (pull && (await findBranchIssue(i, pull.pull.branch))) ?? n;
};

export const writeReview = async (
  i: Pick<Instance, 'tracker' | 'owner' | 'data'>,
  n: number,
  verdict: 'approved' | 'changes_requested',
  text: string
) => {
  const pull = await findPull(i, n);
  if (!pull || pull.state !== 'open') throw new Error(`#${n} has no open pull request`);
  await writeTrustedEvent(i.tracker, i.owner, { issue: pull.number, kind: verdict, comment: { body: text } });
};

export const writeLabels = (dir: string, as: string, n: number, add: string[]) =>
  apply(dir, as, n, { kind: 'label', add, remove: [] });

export const writeClosed = (dir: string, as: string, n: number) =>
  runLocked(dir, async () => {
    const md = join(findIssueDir(dir, n), 'issue.md');
    if (!existsSync(md)) throw new Error(`no issue #${n}`);
    const { front, body } = parseIssueFile(readFileSync(md, 'utf8'));
    writeFileAtomic(md, formatIssueFile({ ...front, state: 'closed' }, body.trim()));
    await writeTrustedEvent(dir, as, { issue: n, kind: 'closed' });
  });

export const mergePull = (i: Pick<Instance, 'tracker' | 'owner' | 'data'>, n: number) =>
  runLocked(i.tracker, async () => {
    const pr = await findPull(i, n);
    if (!pr || pr.state !== 'open') throw new Error(`#${n} has no open pull request`);
    const { base, branch, head } = pr.pull;
    const at = await inTracker(i, ['rev-parse', `refs/heads/${base}`]);
    if (!(await isAncestor(i, at, head)))
      throw new Error(`${base} moved since ${branch} branched; review ${n} changes "rebase" first`);
    await inTracker(i, ['update-ref', `refs/heads/${base}`, head, at]);
    await apply(i.tracker, i.owner, pr.number, { kind: 'merge', number: pr.number, head });
    const open = (await readIssues(i.tracker)).filter(t => t.state === 'open');
    for (const t of open)
      if (t.pull?.base === branch)
        writeFileAtomic(join(findIssueDir(i.tracker, t.number), 'pull.json'), { ...t.pull, base });
    const issue = await findBranchIssue(i, branch);
    if (issue !== undefined && open.some(t => t.number === issue)) await writeClosed(i.tracker, i.owner, issue);
    return pr.pull;
  });

export const writePullToRepo = async (
  i: Instance,
  n: number,
  to: { as?: string; patch?: string; auto?: boolean } = {}
): Promise<{ ref: string; base: string; stat: string } | { why: string } | undefined> => {
  const pr = await findPull(i, n);
  if (!pr) return undefined;
  const { branch, base, head } = pr.pull;
  const stat = await inTracker(i, ['diff', '--stat', '--no-ext-diff', '--no-textconv', `refs/heads/${base}...${head}`]);
  if (to.patch && pr.state === 'merged') return { why: `#${pr.number} is merged into ${base}` };
  if (to.patch) {
    const patch = await inTracker(i, ['format-patch', '--stdout', `refs/heads/${base}..${head}`]);
    await writeFile(resolve(to.patch), `${patch}\n`, { flag: 'wx' });
    return { ref: resolve(to.patch), base, stat };
  }
  const saved = readInstance(dirname(i.dir), basename(i.dir)) ?? i;
  if (saved.readonly) return { why: `agentgraph does not write to ${i.checkout}; pass --patch <file>` };
  const name = to.as ?? branch;
  const ref = `refs/heads/${name}`;
  if (!isAgentBranch(name)) return { why: `${name} is not an ${pushLimits.prefix} branch` };
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head) || !(await succeeds(git({}, ['check-ref-format', ref]))))
    return { why: `${name} is not a branch` };
  const current = await inRepo(i.checkout, ['rev-parse', '-q', '--verify', ref], [1]);
  if (current === head) return { ref: name, base, stat };
  const exported = saved.exported[ref];
  if (current && current !== exported) return { why: `${name} in your repo moved since agentgraph wrote it` };
  if (!current && exported && to.auto)
    return {
      why: `${name} was deleted in your repo; agi export ${n}${formatInstanceFlags(i.checkout, dirname(i.dir), basename(i.dir))} writes it again`,
    };
  const checkedOut = (await inRepo(i.checkout, ['worktree', 'list', '--porcelain'])).split('\n');
  if (checkedOut.includes(`branch ${ref}`)) return { why: `${name} is checked out in your repo` };
  const haves: string[] = [];
  for (const at of [await inTracker(i, ['rev-parse', '-q', '--verify', 'refs/agentgraph/repo'], [1]), exported])
    if (at && (await succeeds(inRepo(i.checkout, ['cat-file', '-e', `${at}^{commit}`])))) haves.push(at);
  const list = await inTracker(i, ['rev-list', '--objects', head, '--not', ...haves]);
  const keep = list ? await sendPack(i, list) : undefined;
  try {
    await inRepo(i.checkout, ['rev-list', '--objects', '--quiet', head, '--not', '--all']);
    await inRepo(i.checkout, ['update-ref', '--no-deref', '-m', 'agentgraph export', ref, head, current]);
  } finally {
    if (keep) await rm(keep, { force: true });
  }
  const now = readInstance(dirname(i.dir), basename(i.dir)) ?? i;
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
  const packs = await inRepo(i.checkout, ['rev-parse', '--path-format=absolute', '--git-path', 'objects/pack']);
  const pack = await Effect.runPromise(
    hostGit({ GIT_DIR: origin(i) }, ['pack-objects', '-q', '--stdout'], { input: list })
  );
  const [, id] =
    /^keep\t(\w+)$/m.exec(
      await git({}, ['-C', i.checkout, 'index-pack', '--stdin', '--strict', '--keep=agentgraph export'], [], pack)
    ) ?? [];
  if (!id) throw new Error(`git index-pack kept no pack in ${i.checkout}`);
  return join(packs, `pack-${id}.keep`);
};

const commitPatch = async (i: Pick<Instance, 'tracker'>, base: string, patch: string) => {
  const index = { GIT_DIR: origin(i), GIT_INDEX_FILE: join(tmpdir(), `agentgraph-import-${randomUUID()}.index`) };
  try {
    await git(index, ['read-tree', base]);
    await git(index, ['apply', '--cached', patch]);
    const tree = await git(index, ['write-tree']);
    return await git(index, [...gitIdentity, 'commit-tree', tree, '-p', base, '-m', 'Imported change']);
  } finally {
    await rm(index.GIT_INDEX_FILE, { force: true });
  }
};

export const writeImportedRun = async (
  i: Pick<Instance, 'checkout' | 'tracker' | 'data'>,
  change: string,
  o: { version: string; from?: string; issue?: string; input?: JsonValue; plugin?: string; job?: string }
) => {
  const at = new Date().toISOString();
  const id = `import-${at.replace(/\D/g, '')}-${randomUUID().slice(0, 4)}`;
  const patch = existsSync(change) && statSync(change).isFile() ? resolve(change) : undefined;
  const commit = patch ? undefined : await inRepo(i.checkout, ['rev-parse', '--verify', `${change}^{commit}`]);
  const from = o.from ?? (commit ? `${commit}^` : 'HEAD');
  const base = await inRepo(i.checkout, ['rev-parse', '--verify', `${from}^{commit}`]);
  for (const sha of commit ? [base, commit] : [base])
    await inTracker(i, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', i.checkout, sha]);
  await inTracker(i, ['update-ref', `refs/agentgraph/runs/${id}`, commit ?? (await commitPatch(i, base, patch!))]);
  const [title, ...body] = o.issue ? readFileSync(o.issue, 'utf8').trim().split('\n') : [];
  const run: RunRecord = {
    id,
    workflow: 'import',
    step: 'import',
    status: 'done',
    tries: 0,
    rounds: {},
    sessions: {},
    ...(title && { title, body: body.join('\n').trim() }),
    startCommit: base,
    started: at,
    ended: at,
    meta: {
      engine: {
        origin: { plugin: o.plugin ?? 'agi', version: o.version, job: o.job ?? 'import', input: o.input ?? null },
      },
    },
  };
  await Effect.runPromise(startRun(run).pipe(Effect.provide(fileStore(i.data))));
  return id;
};
