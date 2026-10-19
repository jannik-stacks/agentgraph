/**
 * Replays merged pull requests on v2, on a plain single session (floor) and on v1, then scores them.
 * Usage: node bin/bench.ts run (v2|floor|v1) <case dir> <out> --repo <clone>
 *        node bin/bench.ts score <case dir> <out> --repo <clone>
 * A case dir holds case.json, issue.md and merged.diff. Each step skips outputs that exist, keeps everything under
 * <out>/<case id>/<arm>, and appends to <out>/log.jsonl. Paid steps stop past --max-codex weekly Codex points over the
 * first reading, or after --max-claude-calls judge calls. Model keys come from --keys, infra/local/.keys.env by default.
 */
import { execFileSync, spawnSync } from 'node:child_process';
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
import { parseArgs, parseEnv } from 'node:util';
import { start } from '../src/main.ts';

type Case = { id: string; dir: string; repo: string; base: string; merged: string; title: string; body: string };
type Commands = {
  author?: string;
  hasTests?: boolean;
  test?: string;
  suite?: string;
  typecheck?: string;
  setup?: string;
};

const arms = ['human', 'v2', 'floor', 'v1'];
const hubs: Record<string, string> = { clarinet: 'clarinet', 'acme-app': 'sk', 'bothub-sandbox': 'sandbox' };
const answer = '/bothub No more information. Use your judgment.';
const limits = { codex: 30, claude: 60 };
const testPath = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.\w+$|_test\.\w+$/;
const noise = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|CHANGELOG[^/]*)$/;
const caseStart = /^\s*(?:(?:it|test)(?:\.\w+)*\s*\(|#\[(?:tokio::)?test\]|def test_|func Test)/;
const branches = /\b(?:if|for|while|match|case|catch|loop)\b|&&|\|\|/g;
const comment = /^\s*(\/\/|\/\*|\*|#(?!\[))/;

const here = (path: string) => join(import.meta.dirname, '..', path);
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const round = (n: number) => Math.round(n * 1000) / 1000;
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

const loadCase = (dir: string): Case & Commands => {
  const c = JSON.parse(read(join(dir, 'case.json'))) as Omit<Case, 'id' | 'dir' | 'body'> &
    Commands & { tests?: unknown };
  const issue = read(join(dir, 'issue.md'));
  return {
    ...c,
    ...(typeof c.tests === 'string' && !c.test && { test: c.tests }),
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

const codexUsed = () => {
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

const engineArm = async (c: Case & Commands, arm: string, at: string, repo: string) => {
  const own = `examples/${hubs[c.repo.split('/').pop() ?? ''] ?? 'bench'}`;
  const hub = join(at, 'hub');
  cpSync(here(own), hub, { recursive: true });
  if (own === 'examples/bench' && c.test)
    save(join(hub, 'checks/tests.md'), read(join(hub, 'checks/tests.md')).replace('npm test', c.test));
  if (arm === 'floor') {
    rmSync(join(hub, 'workflows'), { recursive: true });
    cpSync(here('bench/floor'), hub, { recursive: true });
  }
  const dir = join(at, 'forge');
  forge(dir, 'init', repo, '--at', c.base);
  save(join(at, 'issue.md'), c.body);
  forge(dir, 'issue', c.title, '--body', join(at, 'issue.md'));
  forge(dir, 'comment', '1', '/bothub');
  process.env.BOTHUB_FORGE = dir;
  let answers = 0;
  for (let pass = 0; pass < 6; pass++) {
    const [run] = await start({ hub, issue: 1, data: join(at, 'data') });
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
  return { answers };
};

const runArm = async (arm: string, caseDir: string, out: string, repo: string) => {
  const c = loadCase(caseDir);
  const at = join(out, c.id, arm);
  if (arm === 'v1')
    throw new Error('not yet: v1 needs its own sandbox image, env and a leak-free seed (docs/bench.md)');
  if (existsSync(join(at, 'diff.patch'))) return;
  if (existsSync(at)) renameSync(at, `${at}.${Date.now()}`);
  if (!process.env.BOTHUB_PROXY_KEYS) throw new Error('no model keys: pass --keys <env file>');
  guard(out, false);
  const started = Date.now();
  const meta = await step(out, { step: 'run', case: c.id, arm }, () => engineArm(c, arm, at, resolve(repo)));
  save(join(at, 'meta.json'), { ...meta, ms: Date.now() - started });
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
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', timeout: 3_600_000, maxBuffer: 1 << 28 });
  return { ok: r.status === 0, ms: Date.now() - started, tail: `${r.stdout}${r.stderr}`.slice(-2000) };
};

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
  return { ...result, hidden: exec(c.test, tree) };
};
const effort = (data: string) => {
  const traces = existsSync(data) ? readdirSync(data).flatMap(id => lines(join(data, id, 'trace.jsonl'))) : [];
  const sessions = traces.flatMap(t => (t.session ? [t.session as { usd: number }] : []));
  return { sessions: sessions.length, usd: round(sessions.reduce((a, s) => a + s.usd, 0)) };
};

const score = async (caseDir: string, out: string, repo: string) => {
  const c = loadCase(caseDir);
  const root = join(out, c.id);
  const merged = read(join(c.dir, 'merged.diff'));
  if (!existsSync(join(root, 'human/diff.patch'))) save(join(root, 'human/diff.patch'), merged);
  if (!existsSync(join(root, 'base/diff.patch'))) save(join(root, 'base/diff.patch'), '');
  save(join(root, 'case.json'), read(join(c.dir, 'case.json')));
  const human = files(merged).map(f => f.path);
  const hidden = human.filter(p => testPath.test(p) && !noise.test(p));
  const tree = join(root, 'tree');
  if (!existsSync(tree)) sh('git', ['clone', '-q', '--shared', '--no-checkout', resolve(repo), tree]);
  for (const arm of ['base', ...arms]) {
    const at = join(root, arm);
    if (!existsSync(join(at, 'diff.patch')) || existsSync(join(at, 'score.json'))) continue;
    const diff = read(join(at, 'diff.patch'));
    const meta = JSON.parse(read(join(at, 'meta.json')) || '{}') as { answers?: number; ms?: number };
    const tests = await step(out, { step: 'score', case: c.id, arm }, () =>
      (c.test || c.suite) && c.hasTests !== false ? check(c, tree, diff, hidden) : {}
    );
    save(join(at, 'score.json'), { ...tests, ...stats(diff, human), ...effort(join(at, 'data')), ...meta });
  }
};

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      keys: { type: 'string', default: here('infra/local/.keys.env') },
      'max-codex': { type: 'string', default: '30' },
      'max-claude-calls': { type: 'string', default: '60' },
    },
  });
  Object.assign(limits, { codex: Number(values['max-codex']), claude: Number(values['max-claude-calls']) });
  const [command, a, b, c] = positionals;
  loadKeys(values.keys);
  if (command === 'run' && a && arms.includes(a) && a !== 'human' && b && c && values.repo)
    await runArm(a, b, resolve(c), values.repo);
  else if (command === 'score' && a && b && values.repo) await score(a, resolve(b), values.repo);
  else {
    console.error('usage: node bin/bench.ts (run (v2|floor|v1) <case> <out> | score <case> <out>) --repo <clone>');
    process.exit(2);
  }
}
