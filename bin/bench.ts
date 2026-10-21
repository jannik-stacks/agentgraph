/**
 * Replays merged pull requests on v2, on a plain single session (floor) and on v1, then scores and judges them blind.
 * Usage: node bin/bench.ts run (v2|floor|v1) <case dir> <out> --repo <clone> [--point harness:model] [--repeat k]
 *        node bin/bench.ts score <case dir> <out> --repo <clone>
 *        node bin/bench.ts judge <case dir> <out> [--pairs all|human]
 *        node bin/bench.ts report <out>
 * A case dir holds case.json, issue.md and merged.diff. Each step skips outputs that exist, keeps everything under
 * <out>/<case id>/<arm>, and appends to <out>/log.jsonl. Paid steps stop past --max-codex weekly Codex points over the
 * first reading, or after --max-claude-calls judge calls. Model keys come from --keys, infra/local/.keys.env by default.
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs, parseEnv } from 'node:util';
const engine = process.env.BENCH_ENGINE ?? join(import.meta.dirname, '..');

type Case = {
  id: string;
  dir: string;
  repo: string;
  base: string;
  merged: string;
  title: string;
  body: string;
  bucket?: string;
  control?: 'bug' | 'padded';
};
type Commands = {
  author?: string;
  hasTests?: boolean;
  test?: string;
  suite?: string;
  typecheck?: string;
  setup?: string;
  runner?: string;
};
type Finding = { severity: string; category: string; text: string };
type Verdict = { A?: { findings?: Finding[] }; B?: { findings?: Finding[] }; prefer: 'A' | 'B' | 'tie'; why?: string };

const bots = ['v2', 'floor', 'v1'];
const arms = ['human', ...bots, 'control'];
const hubs: Record<string, string> = { clarinet: 'clarinet', 'acme-app': 'sk', 'bothub-sandbox': 'sandbox' };
const strataKeys = ['repo', 'size', 'kind', 'bucket', 'filesBucket', 'area', 'issue'];
const answer = '/bothub No more information. Use your judgment.';
const limits = { codex: 30, claude: 60 };
const options = { point: process.env.BENCH_POINT, repeat: 1, pairs: 'all' };
const panel: Record<string, number> = { opus: 1, sonnet: 2, sol: 2 };
const testPath = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.\w+$|_test\.\w+$/;
const noise = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|CHANGELOG[^/]*)$/;
const caseStart = /^\s*(?:(?:it|test)(?:\.\w+)*\s*\(|#\[(?:tokio::)?test\]|def test_|func Test)/;
const branches = /\b(?:if|for|while|match|case|catch|loop)\b|&&|\|\|/g;
const comment = /^\s*(\/\/|\/\*|\*|#(?!\[))/;

const here = (path: string) => join(import.meta.dirname, '..', path);
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 20);
const treeText = (dir: string): string =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? [treeText(join(dir, e.name))] : [e.name, readFileSync(join(dir, e.name), 'utf8')]))
    .join('\0');
/** Where a result is kept for reuse: nothing is reused without BENCH_CACHE or with BENCH_FRESH. */
const slot = (kind: string, ...key: unknown[]) =>
  process.env.BENCH_CACHE ? join(process.env.BENCH_CACHE, kind, hash(JSON.stringify(key))) : undefined;
const reusable = (dir: string | undefined) => dir !== undefined && !process.env.BENCH_FRESH && existsSync(dir);
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const round = (n: number) => Math.round(n * 1000) / 1000;
const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
const sh = (cmd: string, args: string[], o: { cwd?: string; env?: Record<string, string> } = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...o, env: { ...process.env, ...o.env } });
const save = (path: string, v: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof v === 'string' ? v : `${JSON.stringify(v, null, 2)}\n`);
};
const lines = (path: string) =>
  read(path)
    .split('\n')
    .flatMap(l => (l ? [JSON.parse(l) as Record<string, unknown>] : []));
const step = async <A>(out: string, entry: Record<string, unknown>, f: () => A | Promise<A>) => {
  const log = (more: object) =>
    appendFileSync(join(out, 'log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry, ...more })}\n`);
  log({ event: 'start' });
  try {
    const result = await f();
    log({ event: 'end' });
    return result;
  } catch (e) {
    log({ event: 'error', error: String(e).slice(0, 500) });
    throw e;
  }
};

const quote = (p: string) => `'${p.replaceAll("'", "'\\''")}'`;
const install = (fallback: string) =>
  `npx --yes pnpm@$(node -p "((require('./package.json').packageManager ?? '').split('@')[1] ?? '${fallback}').split('+')[0]") install --frozen-lockfile --ignore-scripts --store-dir node_modules/.pnpm-store`;

/** The test command and its setup, from the repo and the test files a merged change touches. */
export const plan = (repo: string, tests: string[]): Commands => {
  const name = repo.split('/').pop();
  const js = tests.filter(p => /\.(test|spec)\.[jt]sx?$/.test(p));
  const files = js.map(quote).join(' ');
  if (name === 'billing' && js.length) {
    const runner = 'node_modules/.bin/vitest run';
    return { setup: `${install('11.1.3')}`, runner, test: `${runner} ${files}` };
  }
  if (name === 'explorer' && js.length) {
    const runner = 'TZ=UTC node_modules/.bin/jest --env=jsdom --runTestsByPath';
    return { setup: `${install('10.28.2')}`, runner, test: `${runner} ${files}` };
  }
  if (name === 'stacks.js' && js.length) {
    const dirs = [...new Set(js.map(p => p.split('/').slice(0, 2).join('/')))];
    const run = (d: string) =>
      `(cd ${d} && npx jest --runTestsByPath ${js
        .filter(p => p.startsWith(`${d}/`))
        .map(p => quote(p.slice(d.length + 1)))
        .join(' ')})`;
    return { setup: 'npm ci --no-audit --no-fund --ignore-scripts', test: dirs.map(run).join(' && ') };
  }
  const rust = tests.flatMap(p => {
    const m = /^components\/([^/]+)\/tests\/([^/]+)\.rs$/.exec(p);
    return m ? [`cargo test -p ${m[1]} --test ${m[2]}`] : [];
  });
  if (name === 'clarinet' && rust.length) return { test: rust.join(' && ') };
  return { hasTests: false };
};

const loadCase = (dir: string): Case & Commands => {
  const c = JSON.parse(read(join(dir, 'case.json'))) as Omit<Case, 'id' | 'dir' | 'body'> &
    Commands & { tests?: unknown };
  const issue = read(join(dir, 'issue.md'));
  return {
    ...(Array.isArray(c.tests) && plan(c.repo, c.tests as string[])),
    ...c,
    ...(typeof c.tests === 'string' && !c.test && { test: c.tests }),
    ...(c.bucket === 'no-tests' && { hasTests: false }),
    id: basename(resolve(dir)),
    dir: resolve(dir),
    title: /^# (.+)$/m.exec(issue)?.[1] ?? c.title,
    body: issue.replace(/^# .+\n+/, '').trim(),
  };
};

const loadKeys = (file: string) => {
  const env = parseEnv(read(file)) as Record<string, string>;
  Object.assign(process.env, env);
  process.env.BOTHUB_PROXY_KEYS ??= Object.entries(env)
    .flatMap(([k, v]) =>
      k.startsWith('BOTHUB_LLM_API_KEY_') ? [`${k.slice(19).toLowerCase().replaceAll('_', '-')}=${v}`] : []
    )
    .join(',');
};

export const codexUsed = () => {
  spawnSync('codex', ['exec', '-m', 'gpt-6-luna', '--skip-git-repo-check', '-C', tmpdir(), 'Reply with exactly: ok'], {
    timeout: 120_000,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  const found = spawnSync('find', [join(homedir(), '.codex/sessions'), '-name', '*.jsonl', '-mmin', '-5'], {
    encoding: 'utf8',
  });
  const newest = found.stdout
    .split('\n')
    .filter(Boolean)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  const m = [...read(newest ?? '').matchAll(/"primary":\{"used_percent":([\d.]+)/g)].at(-1);
  return m ? Number(m[1]) : undefined;
};

const guard = (out: string, claude: boolean) => {
  const file = join(out, 'budget.json');
  const b = JSON.parse(read(file) || '{}') as { start?: number; now?: number; at?: number };
  if (!b.at || Date.now() - b.at > 600_000) {
    const now = codexUsed();
    if (now !== undefined) Object.assign(b, { start: b.start ?? now, now });
    save(file, { ...b, at: Date.now() });
  }
  if (b.now !== undefined && b.now - (b.start ?? b.now) > limits.codex)
    throw new Error(`Codex weekly use is ${b.now}%, more than ${limits.codex} points over ${b.start}%`);
  const calls = lines(join(out, 'log.jsonl')).filter(l => l.event === 'start' && /opus|sonnet/.test(String(l.judge)));
  if (claude && calls.length >= limits.claude) throw new Error(`${calls.length} claude judge calls, the limit`);
};
const forge = (dir: string, ...args: string[]) =>
  sh(process.execPath, [here('bin/forge.ts'), dir, ...args, '--as', 'maintainer']);

/** Points every agent of a hub at `harness:model`, by the two lines of its front matter. */
export const repoint = (hub: string, point: string) => {
  const [harness, model] = point.split(':');
  const dir = join(hub, 'agents');
  for (const name of existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.md')) : [])
    save(
      join(dir, name),
      read(join(dir, name)).replace(/^---\n[\s\S]*?\n---/, head =>
        head.replace(/^harness: .*$/m, `harness: ${harness}`).replace(/^model: .*$/m, `model: ${model}`)
      )
    );
  const key = process.env[`BOTHUB_LLM_API_KEY_PT_${point.replace(/\W/g, '_').toUpperCase()}`];
  if (key && existsSync(dir))
    process.env.BOTHUB_PROXY_KEYS = readdirSync(dir)
      .map(n => `${basename(n, '.md')}=${key}`)
      .join(',');
};

const engineArm = async (c: Case & Commands, arm: string, at: string, repo: string) => {
  const { start } = (await import(join(engine, 'src/main.ts'))) as typeof import('../src/main.ts');
  const own = process.env.BENCH_HUB ?? `examples/${hubs[c.repo.split('/').pop() ?? ''] ?? 'bench'}`;
  const hub = join(at, 'hub');
  cpSync(resolve(engine, own), hub, { recursive: true });
  if (own === 'examples/bench' && c.runner) {
    save(
      join(hub, 'scripts/tests.sh'),
      `set -f\nfiles=$(git ls-files -mo --exclude-standard | grep -E '[.](test|spec)[.][jt]sx?$')\n[ -z "$files" ] || ${c.runner} $files\n`
    );
    save(
      join(hub, 'checks/tests.md'),
      read(join(hub, 'checks/tests.md')).replace('npm test', 'sh "$BOTHUB_HUB/scripts/tests.sh"')
    );
    if (c.setup) save(join(hub, 'hub.yaml'), `setup: ${JSON.stringify(c.setup)}\n${read(join(hub, 'hub.yaml'))}`);
  }
  if (own === 'examples/bench' && !c.runner) {
    rmSync(join(hub, 'checks'), { recursive: true });
    save(
      join(hub, 'workflows/issue.md'),
      read(join(hub, 'workflows/issue.md')).replace(/^ {4}checks: \[tests\]\n/m, '')
    );
  }
  const raw = read(join(hub, 'hub.yaml'));
  if (/^setup: pnpm install/m.test(raw)) save(join(hub, 'hub.yaml'), raw.replace(/^setup: .*\n/m, ''));
  const limit = (yaml: string, key: string, value: number) =>
    new RegExp(`^ {2}${key}:`, 'm').test(yaml)
      ? yaml.replace(new RegExp(`^( {2}${key}:).*$`, 'm'), `$1 ${value}`)
      : /^limits:/m.test(yaml)
        ? yaml.replace(/^limits:/m, `limits:\n  ${key}: ${value}`)
        : `${yaml}limits:\n  ${key}: ${value}\n`;
  save(join(hub, 'hub.yaml'), limit(limit(read(join(hub, 'hub.yaml')), 'parallel', 1), 'sessions', 3));
  if (arm === 'floor') {
    rmSync(join(hub, 'workflows'), { recursive: true });
    for (const d of ['agents', 'skills']) rmSync(join(hub, d), { recursive: true, force: true });
    rmSync(join(hub, 'checks'), { recursive: true, force: true });
    cpSync(here('bench/floor'), hub, { recursive: true });
  }
  if (options.point) repoint(hub, options.point);
  const dir = join(at, 'forge');
  forge(dir, 'init', repo, '--at', c.base);
  save(join(at, 'issue.md'), c.body);
  forge(dir, 'issue', c.title, '--body', join(at, 'issue.md'));
  forge(dir, 'comment', '1', '/bothub');
  process.env.BOTHUB_FORGE = dir;
  let answers = 0;
  let status: string | undefined;
  for (let pass = 0; pass < 6; pass++) {
    const [run] = await start({ hub, issue: 1, data: join(at, 'data') });
    status = run?.status;
    if (!run || run.status === 'done' || run.status === 'stopped') break;
    if (run.status !== 'waiting') continue;
    if (!run.reason || answers) break;
    forge(dir, 'comment', '1', answer);
    answers++;
  }
  const origin = join(dir, 'origin.git');
  const pull = readdirSync(dir)
    .map(n => join(dir, n, 'pull.json'))
    .find(existsSync);
  const branch = ['--git-dir', origin, 'rev-parse', '-q', '--verify', 'refs/heads/bothub/1'];
  const head = pull
    ? (JSON.parse(read(pull)) as { head: string }).head
    : spawnSync('git', branch, { encoding: 'utf8' }).stdout.trim();
  save(join(at, 'diff.patch'), head ? sh('git', ['--git-dir', origin, 'diff', c.base, head]) : '');
  return { answers, status };
};

/** Why an arm's run says nothing about the arm, when it does not: no diff, a failed setup or a run that never finished. */
export const infra = (s: { infra?: string; files?: number; setup?: { ok: boolean }; status?: string | undefined }) =>
  s.infra ??
  (s.files === 0
    ? 'empty diff'
    : s.setup?.ok === false
      ? 'setup fails'
      : s.status === 'running'
        ? 'run did not finish'
        : undefined);

/** Where an arm run is kept: by case, arm, engine, hub (`BENCH_HUB` when set) and commands, and the point and repeat when given. */
export const armSlot = (
  c: Pick<Case & Commands, 'id' | 'base' | 'repo' | 'runner' | 'setup'>,
  arm: string,
  { point, repeat }: Pick<typeof options, 'point' | 'repeat'> = options
) => {
  const treeSha = spawnSync('git', ['-C', engine, 'rev-parse', 'HEAD:./src'], { encoding: 'utf8' }).stdout.trim();
  const own = hubs[c.repo.split('/').pop() ?? ''] ?? 'bench';
  return slot(
    'arm',
    c.id,
    c.base,
    arm,
    arm === 'floor' ? '' : treeSha,
    treeText(process.env.BENCH_HUB ?? join(engine, 'examples', own)),
    arm === 'floor' ? treeText(here('bench/floor')) : '',
    c.runner,
    c.setup,
    ...(point || repeat > 1 ? [point ?? '', repeat] : [])
  );
};

const runArm = async (arm: string, caseDir: string, out: string, repo: string) => {
  const c = loadCase(caseDir);
  const at = join(out, c.id, arm);
  if (arm === 'v1')
    throw new Error('not yet: v1 needs its own sandbox image, env and a leak-free seed (docs/bench.md)');
  if (existsSync(join(at, 'diff.patch'))) return;
  if (!process.env.BOTHUB_PROXY_KEYS) throw new Error('no model keys: pass --keys <env file>');
  if (await prepare(c, out, repo)) return;
  const kept = armSlot(c, arm);
  if (reusable(kept)) return void cpSync(kept!, at, { recursive: true });
  let reason: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (existsSync(at)) renameSync(at, `${at}.${Date.now()}`);
    guard(out, false);
    const started = Date.now();
    try {
      const meta = await step(out, { step: 'run', case: c.id, arm }, () => engineArm(c, arm, at, resolve(repo)));
      reason = infra({ ...stats(read(join(at, 'diff.patch'))), ...meta });
      save(join(at, 'meta.json'), { ...meta, ms: Date.now() - started });
    } catch (e) {
      reason = String(e).slice(0, 200);
    }
    if (!reason) return keep(at, kept);
  }
  if (!existsSync(join(at, 'diff.patch'))) save(join(at, 'diff.patch'), '');
  save(join(at, 'meta.json'), { ...JSON.parse(read(join(at, 'meta.json')) || '{}'), infra: reason });
};

/** The changed files of a unified diff, each with its part of the diff. */
export const files = (diff: string) =>
  diff.split(/^(?=diff --git )/m).flatMap(part => {
    const path = /^diff --git a\/\S+ b\/(\S+)/.exec(part)?.[1];
    return path ? [{ path, part }] : [];
  });

/** Size, test cases and branch-token delta of a diff, and the share of files it has in common with `human`. */
export const stats = (diff: string, human: string[] = []) => {
  const s = {
    files: 0,
    srcAdded: 0,
    srcRemoved: 0,
    testsAdded: 0,
    testsRemoved: 0,
    testCases: 0,
    complexity: 0,
    overlap: 0,
  };
  const changed = files(diff).filter(f => !noise.test(f.path));
  for (const { path, part } of changed) {
    const kind = testPath.test(path) ? 'tests' : 'src';
    const hunks = part.indexOf('\n@@');
    if (hunks < 0) continue;
    for (const line of part.slice(hunks + 1).split('\n')) {
      if (line[0] !== '+' && line[0] !== '-') continue;
      const sign = line[0] === '+' ? 1 : -1;
      s[`${kind}${sign > 0 ? 'Added' : 'Removed'}`]++;
      if (sign > 0 && caseStart.test(line.slice(1))) s.testCases++;
      if (kind === 'src' && !comment.test(line.slice(1))) s.complexity += sign * (line.match(branches)?.length ?? 0);
    }
  }
  const mine = changed.map(f => f.path);
  const union = new Set([...mine, ...human]);
  return {
    ...s,
    files: changed.length,
    overlap: union.size ? round(mine.filter(p => human.includes(p)).length / union.size) : 1,
  };
};
const exec = (cmd: string, cwd: string) => {
  const started = Date.now();
  const PATH = [process.env.BENCH_PATH, process.env.PATH].filter(Boolean).join(':');
  const env = { ...process.env, PATH, NODE_OPTIONS: '' };
  const r = spawnSync('sh', ['-c', cmd], { cwd, env, encoding: 'utf8', timeout: 3_600_000, maxBuffer: 1 << 28 });
  return { ok: r.status === 0, ms: Date.now() - started, tail: `${r.stdout}${r.stderr}`.slice(-8000) };
};

const coupled =
  /Cannot find module|Failed to resolve import|is not a function|is not exported|does not provide an export|No matching export|is not defined|is not a constructor|TS\d{4}|Cannot destructure|Cannot read propert/i;

/** Whether a failed hidden run broke on the human's names and signatures (coupled) or on a result (behaviour). */
export const failureClass = (tail: string) => (coupled.test(tail) ? 'coupled' : 'behaviour');

const check = (c: Case & Commands, tree: string, diff: string, hidden: string[]) => {
  sh('git', ['-C', tree, 'checkout', '-q', '-f', c.base]);
  sh('git', ['-C', tree, 'clean', '-qfdx', '-e', 'node_modules', '-e', 'target']);
  if (
    diff &&
    spawnSync('git', ['-C', tree, 'apply', '--whitespace=nowarn', '-'], { input: `${diff.trimEnd()}\n` }).status
  )
    return { applied: false };
  const suite = c.suite ?? c.test;
  const result = {
    applied: true,
    ...(c.setup && { setup: exec(c.setup, tree) }),
    ...(suite && { suite: exec(suite, tree) }),
    ...(c.typecheck && { typecheck: exec(c.typecheck, tree) }),
  };
  if (!c.test || !hidden.length) return result;
  for (const path of hidden)
    if (spawnSync('git', ['-C', tree, 'checkout', c.merged, '--', path]).status)
      rmSync(join(tree, path), { force: true });
  const run = exec(c.test, tree);
  return { ...result, hidden: run.ok ? run : { ...run, class: failureClass(run.tail) } };
};
/** Sessions, reported cost and tokens by model of an arm's traces; input counts only uncached tokens. */
const effort = (data: string) => {
  const traces = existsSync(data) ? readdirSync(data).flatMap(id => lines(join(data, id, 'trace.jsonl'))) : [];
  const sessions = traces.flatMap(t => (t.session ? [t.session as { usd: number }] : []));
  const models: Record<string, string> = {};
  const tokens: Record<string, { input: number; cacheRead: number; cacheWrite: number; output: number }> = {};
  for (const t of traces) {
    const e = (t.event ?? {}) as Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite', number>> & {
      type?: string;
      model?: string;
    };
    if (e.type === 'start' && e.model) models[String(t.key)] = e.model;
    if (e.type !== 'usage') continue;
    const [read, write] = [e.cacheRead ?? 0, e.cacheWrite ?? 0];
    const sum = (tokens[models[String(t.key)] ?? 'unknown'] ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
    sum.input += (e.input ?? 0) - read - write;
    sum.cacheRead += read;
    sum.cacheWrite += write;
    sum.output += e.output ?? 0;
  }
  return { sessions: sessions.length, usd: round(sessions.reduce((a, s) => a + s.usd, 0)), tokens };
};
const usage = (at: string) =>
  (JSON.parse(read(join(at, 'usage.json')) || 'null') as ReturnType<typeof effort> | null) ?? effort(join(at, 'data'));

/** Writes an arm's usage beside it, then copies it to `kept` without its data, forge and hub dirs. */
export const keep = (at: string, kept: string | undefined) => {
  save(join(at, 'usage.json'), effort(join(at, 'data')));
  if (kept) cpSync(at, kept, { recursive: true, filter: p => !/\/(data|forge|hub)$/.test(p) });
};

const scoreArms = async (c: Case & Commands, out: string, repo: string, which: string[]) => {
  const root = join(out, c.id);
  const merged = read(join(c.dir, 'merged.diff'));
  if (!existsSync(join(root, 'human/diff.patch'))) save(join(root, 'human/diff.patch'), merged);
  if (!existsSync(join(root, 'base/diff.patch'))) save(join(root, 'base/diff.patch'), '');
  save(join(root, 'case.json'), read(join(c.dir, 'case.json')));
  const human = files(merged).map(f => f.path);
  const hidden = human.filter(p => testPath.test(p) && !noise.test(p));
  const tree = join(root, 'tree');
  if (!existsSync(tree)) sh('git', ['clone', '-q', '--shared', '--no-checkout', resolve(repo), tree]);
  for (const arm of which) {
    const at = join(root, arm);
    if (!existsSync(join(at, 'diff.patch')) || existsSync(join(at, 'score.json'))) continue;
    const diff = read(join(at, 'diff.patch'));
    const meta = JSON.parse(read(join(at, 'meta.json')) || '{}') as { answers?: number; ms?: number };
    const tests = await step(out, { step: 'score', case: c.id, arm }, () =>
      (c.test || c.suite) && c.hasTests !== false ? check(c, tree, diff, hidden) : {}
    );
    save(join(at, 'score.json'), { ...tests, ...stats(diff, human), ...usage(at), ...meta });
  }
};

type Tests = { applied?: boolean; setup?: { ok: boolean }; suite?: { ok: boolean }; hidden?: { ok: boolean } };

/** Why a case cannot tell arms apart, when it cannot: the hidden tests must fail on base and pass on the human. */
export const invalid = (base: Tests, human: Tests) => {
  if (human.applied === false) return 'the human diff does not apply to base';
  if (base.setup?.ok === false || human.setup?.ok === false) return 'setup fails';
  if (!base.hidden || !human.hidden) return undefined;
  if (base.hidden.ok) return 'base already passes the hidden tests';
  if (!human.hidden.ok) return 'the human fails the hidden tests';
  if (human.suite?.ok === false) return 'the human fails the suite';
  return undefined;
};

const prepare = async (c: Case & Commands, out: string, repo: string) => {
  const file = join(out, c.id, 'valid.json');
  const kept = slot('valid', c.id, c.base, c.merged, c.runner, c.setup, c.test);
  if (!existsSync(file) && reusable(kept)) cpSync(kept!, join(out, c.id), { recursive: true });
  if (!existsSync(file)) {
    await scoreArms(c, out, repo, ['base', 'human']);
    const tests = (arm: string) => JSON.parse(read(join(out, c.id, arm, 'score.json')) || '{}') as Tests;
    save(file, { invalid: invalid(tests('base'), tests('human')) });
    if (kept) cpSync(join(out, c.id), kept, { recursive: true, filter: p => !/\/(tree|v2|floor|judge)$/.test(p) });
  }
  return (JSON.parse(read(file)) as { invalid?: string }).invalid;
};

const score = async (caseDir: string, out: string, repo: string) => {
  const c = loadCase(caseDir);
  if (!(await prepare(c, out, repo))) await scoreArms(c, out, repo, bots);
};

const flips: [RegExp, string][] = [
  [/===/, '!=='],
  [/!==/, '==='],
  [/<=/, '<'],
  [/>=/, '>'],
  [/ < /, ' > '],
  [/ > /, ' < '],
];

/** The diff with one comparison flipped in its first added source line that has one. */
export const plant = (diff: string) => {
  for (const { path, part } of files(diff))
    if (!testPath.test(path) && !noise.test(path))
      for (const line of part.split('\n'))
        if (line.startsWith('+') && !line.startsWith('+++') && !comment.test(line.slice(1)))
          for (const [from, to] of flips) if (from.test(line)) return diff.replace(line, () => line.replace(from, to));
  return undefined;
};

/** The diff with a test file of trivial cases and comments appended. */
export const pad = (diff: string) => {
  const body = ['// Edge cases.', ...Array.from({ length: 20 }, (_, i) => `it('handles case ${i + 1}', () => {});`)];
  const head = `diff --git a/pad.test.ts b/pad.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/pad.test.ts\n`;
  return `${diff.trimEnd()}\n${head}@@ -0,0 +1,${body.length} @@\n${body.map(l => `+${l}`).join('\n')}\n`;
};

/** A diff for a judge: no lockfiles or changelogs, no index lines, issue numbers and the given names masked. */
export const scrub = (text: string, names: string[] = []) => {
  const who = new RegExp(`\\b(${['bothub', ...names.filter(n => /^[\w-]+$/.test(n))].join('|')})\\b`, 'gi');
  const kept = text.startsWith('diff --git')
    ? files(text)
        .filter(f => !noise.test(f.path))
        .map(f => f.part)
        .join('')
    : text;
  return kept
    .split('\n')
    .filter(l => !l.startsWith('index '))
    .map(l => l.replace(/#\d+\b/g, '#N').replace(who, 'someone'))
    .join('\n');
};

/** The last JSON block of a judge's answer, when it names a preference. */
export const verdict = (text: string): Verdict | undefined => {
  try {
    const v = JSON.parse([...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1] ?? '') as Verdict;
    return ['A', 'B', 'tie'].includes(v.prefer) ? v : undefined;
  } catch {
    return undefined;
  }
};

const claude = (model: string) => (prompt: string, cwd: string) =>
  new Promise<string>((done, fail) => {
    const args = ['-p', '--model', model, '--tools', '', '--no-session-persistence'];
    const child = execFile('claude', args, { cwd, maxBuffer: 1 << 26, timeout: 1_800_000 }, (e, out) =>
      e ? fail(e) : done(out)
    );
    child.stdin?.end(prompt);
  });
const sol = async (prompt: string) => {
  const r = await fetch('http://127.0.0.1:4000/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.BOTHUB_LLM_API_KEY_REVIEWER}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'smart', messages: [{ role: 'user', content: prompt }] }),
  });
  return ((await r.json()) as { choices?: { message: { content: string } }[] }).choices?.[0]?.message.content ?? '';
};
const judges: Record<string, (prompt: string, cwd: string) => Promise<string>> = {
  opus: claude('opus'),
  sonnet: claude('sonnet'),
  sol,
};

/** The orders (0 is first-then-second, 1 the reverse) a judge reads a pair in; with one, it is picked by the pair's key. */
export const orders = (count: number, key: string) =>
  count > 1 ? [0, 1] : [[...key].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 2];

/** `opus:1,sonnet:2` as the number of orders per judge. */
export const parsePanel = (spec: string) =>
  Object.fromEntries(
    spec.split(',').map(part => {
      const [name = '', n = ''] = part.split(':');
      if (!(name in judges) || !['1', '2'].includes(n)) throw new Error(`bad --judges entry: ${part}`);
      return [name, Number(n)];
    })
  );

const judge = async (caseDir: string, out: string) => {
  const c = loadCase(caseDir);
  const root = join(out, c.id);
  if ((JSON.parse(read(join(root, 'valid.json')) || '{}') as { invalid?: string }).invalid) return;
  const names = [c.author ?? '', c.repo.split('/')[0] ?? ''];
  const human = read(join(root, 'human/diff.patch'));
  if (c.control) {
    const changed = c.control === 'bug' ? plant(human) : pad(human);
    if (!changed) throw new Error(`${c.id}: no comparison to flip in the human diff`);
    save(join(root, 'control/diff.patch'), changed);
  }
  const have = c.control
    ? ['human', 'control']
    : arms.filter(a => a !== 'control' && read(join(root, a, 'diff.patch')).trim());
  const block = (label: string, arm: string) =>
    `## Candidate ${label}\n\n\`\`\`diff\n${scrub(read(join(root, arm, 'diff.patch')), names)}\n\`\`\``;
  const issue = scrub(`# ${c.title}\n\n${c.body}`, names);
  for (const [i, x] of have.entries())
    for (const y of have.slice(i + 1).filter(y => options.pairs === 'all' || x === 'human' || y === 'human'))
      for (const [at, [a, b]] of (
        [
          [x, y],
          [y, x],
        ] as const
      ).entries()) {
        const prompt = `${read(here('bench/judge.md'))}\n## Issue\n\n${issue}\n\n${block('A', a)}\n\n${block('B', b)}\n`;
        const dir = join(root, 'judge', `${a}-${b}`);
        save(join(dir, 'prompt.md'), prompt);
        await Promise.all(
          Object.entries(judges)
            .filter(([name]) => orders(panel[name] ?? 2, `${c.id}/${x}-${y}`).includes(at))
            .map(async ([name, ask]) => {
              const kept = slot('judge', name, prompt);
              for (let attempt = 0; attempt < 3 && !existsSync(join(dir, `${name}.json`)); attempt++) {
                const hit = reusable(kept);
                if (!hit) guard(out, name !== 'sol');
                const raw = hit
                  ? read(kept!)
                  : await step(out, { step: 'judge', case: c.id, pair: `${a}-${b}`, judge: name }, () =>
                      ask(prompt, tmpdir())
                    ).catch(() => '');
                save(join(dir, `${name}.${attempt}.raw.md`), raw);
                const v = verdict(raw);
                if (v) save(join(dir, `${name}.json`), { judge: name, order: [a, b], ...v });
                if (v && kept && !hit) save(kept, raw);
              }
            })
        );
      }
};

/** The 95% interval of the mean of `xs` over resampled sets of the same size. */
export const bootstrap = (xs: number[], n = 2000): [number, number] => {
  const means = Array.from({ length: n }, () => mean(xs.map(() => xs[Math.floor(Math.random() * xs.length)]!)));
  means.sort((a, b) => a - b);
  return [round(means[Math.floor(n * 0.025)]!), round(means[Math.floor(n * 0.975)]!)];
};

const metrics = (s: Record<string, unknown>): Record<string, number> =>
  Object.fromEntries(
    Object.entries(s).flatMap(([k, v]): [string, number][] => {
      if (k === 'ms' && typeof v === 'number') return [['min', round(v / 60_000)]];
      if (typeof v === 'number') return [[k, v]];
      if (typeof v === 'boolean') return [[k, +v]];
      return v && typeof v === 'object' && 'ok' in v ? [[k, +Boolean(v.ok)]] : [];
    })
  );

const table = (rows: [string, Record<string, number | string>][]) => {
  const cols = [...new Set(rows.flatMap(([, r]) => Object.keys(r)))];
  return [
    `| arm | ${cols.join(' | ')} |`,
    `|${'---|'.repeat(cols.length + 1)}`,
    ...rows.map(([n, r]) => `| ${n} | ${cols.map(k => r[k] ?? '').join(' | ')} |`),
  ].join('\n');
};

type Judged = Verdict & { judge: string; order: [string, string] };
type Scored = {
  id: string;
  invalid?: string;
  infra: Record<string, string>;
  strata: Record<string, string>;
  rows: [string, Record<string, number>][];
  failures: string[];
  verdicts: Judged[];
};

const loadScored = (out: string, id: string): Scored => {
  const c = JSON.parse(read(join(out, id, 'case.json')) || '{}') as Record<string, unknown>;
  const strata = Object.fromEntries(
    strataKeys.flatMap(k => (c[k] === undefined || typeof c[k] === 'object' ? [] : [[k, String(c[k])]]))
  );
  if (c.repo) strata.issue = Array.isArray(c.flags) && c.flags.includes('no-issue-pr-body') ? 'pr-body' : 'issue';
  const scores = Object.fromEntries(
    ['base', ...arms].flatMap(arm => {
      const s = read(join(out, id, arm, 'score.json'));
      return s ? [[arm, JSON.parse(s) as Record<string, unknown>]] : [];
    })
  );
  const skipped = Object.fromEntries(
    bots.flatMap(arm => {
      const reason = scores[arm] && infra(scores[arm]);
      return reason ? [[arm, reason]] : [];
    })
  );
  const rows = Object.entries(scores)
    .filter(([arm]) => !(arm in skipped))
    .map(([arm, s]): [string, Record<string, number>] => [arm, metrics(s)]);
  const failures = bots.flatMap(arm => {
    const h = (scores[arm] as { hidden?: { ok: boolean; tail: string; class?: string } } | undefined)?.hidden;
    return h && !h.ok && !(arm in skipped) ? [`${id}/${arm}: ${h.class ?? failureClass(h.tail)}`] : [];
  });
  const judged = join(out, id, 'judge');
  const verdicts = (existsSync(judged) ? readdirSync(judged) : [])
    .flatMap(pair =>
      readdirSync(join(judged, pair))
        .filter(f => /^\w+\.json$/.test(f))
        .map(f => JSON.parse(read(join(judged, pair, f))) as Judged)
    )
    .filter(v => !v.order.some(arm => arm in skipped));
  const { invalid } = JSON.parse(read(join(out, id, 'valid.json')) || '{}') as { invalid?: string };
  return { id, ...(invalid && { invalid }), infra: skipped, strata, rows, failures, verdicts };
};

/**
 * One row per case and arm run of an out dir, keyed by its point. A dir without `point.json` reads as opencode:smart,
 * repeat 1, engine unknown, with the dir name as its set.
 */
export const rowsOf = (out: string) => {
  const p = {
    harness: 'opencode',
    model: 'smart',
    engine: 'unknown',
    set: basename(resolve(out)),
    repeat: 1,
    hubs: {} as Record<string, string>,
    ...(JSON.parse(read(join(out, 'point.json')) || '{}') as object),
  };
  const ok = (v: unknown) => (v && typeof v === 'object' && 'ok' in v ? (+Boolean(v.ok) as 0 | 1) : undefined);
  return readdirSync(out)
    .filter(id => existsSync(join(out, id, 'human')))
    .map(id => loadScored(out, id))
    .filter(c => !c.invalid)
    .flatMap(c =>
      ['human', ...bots].flatMap(arm => {
        const s = JSON.parse(read(join(out, c.id, arm, 'score.json')) || 'null') as Record<string, unknown> | null;
        if (!s) return [];
        const seen = c.verdicts.filter(v => v.order.includes(arm));
        const byJudge: Record<string, number[]> = {};
        for (const v of seen.filter(v => arm !== 'human' && v.order.includes('human')))
          (byJudge[v.judge] ??= []).push(v.prefer === 'tie' ? 0.5 : +(v.order[+(v.prefer === 'B')] === arm));
        const found = (severity: string) =>
          seen.length
            ? mean(
                seen.map(
                  v => (v[v.order[0] === arm ? 'A' : 'B']?.findings ?? []).filter(f => f.severity === severity).length
                )
              )
            : 0;
        const spent = usage(join(out, c.id, arm));
        const [hidden, suite, typecheck] = [ok(s.hidden), ok(s.suite), ok(s.typecheck)];
        return [
          {
            point: `${p.harness}:${p.model}/${arm}@${p.engine}/${p.hubs[arm] ?? ''}/${p.set}`,
            case: c.id,
            repeat: p.repeat,
            strata: c.strata,
            ...(c.infra[arm] && { infra: c.infra[arm] }),
            ...(hidden !== undefined && { hidden }),
            ...(suite !== undefined && { suite }),
            ...(typecheck !== undefined && { typecheck }),
            vsHuman: Object.fromEntries(Object.entries(byJudge).map(([j, ps]) => [j, mean(ps)])),
            findings: { critical: found('critical'), high: found('high') },
            answers: Number(s.answers ?? 0),
            minutes: Number(s.ms ?? 0) / 60_000,
            tokens: spent.tokens,
            usd: typeof s.usd === 'number' ? s.usd : spent.usd,
          },
        ];
      })
    );
};

const summary = (cases: Scored[]) => {
  const perArm: Record<string, Record<string, number>[]> = {};
  const wins: Record<string, number[]> = {};
  const severities: Record<string, Record<string, number>> = {};
  const agreed: boolean[] = [];
  for (const { rows, verdicts } of cases) {
    for (const [arm, r] of rows) (perArm[arm] ??= []).push(r);
    const pairs: Record<string, Record<string, number[]>> = {};
    for (const v of verdicts) {
      const [x, y] = [...v.order].sort((p, q) => arms.indexOf(p) - arms.indexOf(q)) as [string, string];
      const point = v.prefer === 'tie' ? 0.5 : +(v.order[+(v.prefer === 'B')] === x);
      ((pairs[`${x} vs ${y}`] ??= {})[v.judge] ??= []).push(point);
      for (const side of ['A', 'B'] as const)
        for (const f of v[side]?.findings ?? []) {
          const by = (severities[v.order[+(side === 'B')]!] ??= {});
          by[f.severity] = (by[f.severity] ?? 0) + 1;
        }
    }
    for (const [pair, byJudge] of Object.entries(pairs)) {
      (wins[pair] ??= []).push(mean(Object.values(byJudge).flat()));
      const calls = Object.values(byJudge).map(ps => (ps.every(p => p === ps[0]) ? ps[0] : 0.5));
      agreed.push(calls.length > 1 && calls.every(p => p === calls[0]));
    }
  }
  const winRows: [string, Record<string, number | string>][] = Object.entries(wins).map(([pair, ws]) => [
    pair,
    { cases: ws.length, 'first wins': round(mean(ws)), '95% CI': bootstrap(ws).join(' to ') },
  ]);
  const means: [string, Record<string, number>][] = Object.entries(perArm).map(([arm, rs]) => [
    arm,
    Object.fromEntries(
      [...new Set(rs.flatMap(Object.keys))].map(k => [k, round(mean(rs.flatMap(r => (k in r ? [r[k]!] : []))))])
    ),
  ]);
  return [
    ...(winRows.length ? ['Win rates', '', table(winRows), ''] : []),
    'Mean metrics',
    '',
    table(means),
    '',
    ...(Object.keys(severities).length ? ['Findings by severity', '', table(Object.entries(severities)), ''] : []),
    `Judges agree, order-consistent, on ${agreed.filter(Boolean).length} of ${agreed.length} case pairs.`,
    '',
  ];
};

const headline = (cases: Scored[], valid: Scored[]) => {
  const infras = valid.flatMap(c => Object.entries(c.infra).map(([arm, why]) => `${c.id}/${arm}: ${why}`));
  const invalids = cases.flatMap(c => (c.invalid ? [`${c.id}: ${c.invalid}`] : []));
  const rate = ([arm, passes]: [string, number[]]): [string, Record<string, number>] => [
    arm,
    { passed: passes.reduce((a, p) => a + p, 0), of: passes.length, rate: round(mean(passes)) },
  ];
  const hidden = ['base', ...arms].flatMap((arm): [string, number[]][] => {
    const passes = valid.flatMap(c => c.rows.flatMap(([a, r]) => (a === arm && 'hidden' in r ? [r.hidden!] : [])));
    return passes.length ? [[arm, passes]] : [];
  });
  const list = (title: string, items: string[]) => (items.length ? [title, '', ...items.map(i => `- ${i}`), ''] : []);
  return [
    `${valid.length} valid cases, ${invalids.length} invalid, ${infras.length} infra arm runs.`,
    '',
    ...(hidden.length
      ? ['Hidden tests passed, valid cases, infra arms left out', '', table(hidden.map(rate)), '']
      : []),
    ...list(
      'Hidden test failures, coupled to the human API or behaviour',
      valid.flatMap(c => c.failures)
    ),
    ...list('Invalid cases, not run or judged', invalids),
    ...list('Infra arm runs, left out of every number below', infras),
  ];
};

const report = (out: string) => {
  const ids = readdirSync(out).filter(id => existsSync(join(out, id, 'human')));
  const all = ids.map(id => loadScored(out, id));
  const cases = all.filter(c => !c.invalid);
  const md = [
    '# Bench report',
    '',
    ...headline(all, cases),
    `## All ${cases.length} valid cases`,
    '',
    ...summary(cases),
  ];
  for (const key of strataKeys)
    for (const value of [...new Set(cases.flatMap(c => c.strata[key] ?? []))].sort()) {
      const some = cases.filter(c => c.strata[key] === value);
      md.push(`## ${key} ${value}, ${some.length} cases`, '', ...summary(some));
    }
  for (const c of cases) md.push(`## ${c.id}`, '', table(c.rows), '');
  return md.join('\n');
};

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      keys: { type: 'string', default: here('infra/local/.keys.env') },
      'max-codex': { type: 'string', default: '30' },
      'max-claude-calls': { type: 'string', default: '60' },
      judges: { type: 'string', default: 'opus:1,sonnet:2,sol:2' },
      point: { type: 'string' },
      repeat: { type: 'string', default: '1' },
      pairs: { type: 'string', default: 'all' },
    },
  });
  const point = values.point ?? options.point;
  if (point && !/^[\w-]+:[\w.-]+$/.test(point)) throw new Error(`bad --point ${point}`);
  if (!['all', 'human'].includes(values.pairs)) throw new Error(`bad --pairs ${values.pairs}`);
  Object.assign(options, { point, repeat: Number(values.repeat), pairs: values.pairs });
  Object.assign(limits, { codex: Number(values['max-codex']), claude: Number(values['max-claude-calls']) });
  Object.assign(panel, parsePanel(values.judges));
  const [command, a, b, c] = positionals;
  loadKeys(values.keys);
  if (command === 'run' && a && bots.includes(a) && b && c && values.repo) await runArm(a, b, resolve(c), values.repo);
  else if (command === 'score' && a && b && values.repo) await score(a, resolve(b), values.repo);
  else if (command === 'judge' && a && b) await judge(a, resolve(b));
  else if (command === 'report' && a) {
    save(join(a, 'report.md'), report(a));
    console.log(read(join(a, 'report.md')));
  } else {
    console.error('usage: node bin/bench.ts (run (v2|floor|v1) <case> <out> | score <case> <out>) --repo <clone>');
    console.error('       node bin/bench.ts judge <case> <out> | report <out>');
    process.exit(2);
  }
}
