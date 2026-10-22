/**
 * Replays merged pull requests on v2, on a plain single session (floor) and on v1, then scores and judges them blind.
 * Usage: node bin/bench.ts run (v2|floor|v1) <case dir> <out> --repo <clone> [--point harness:model] [--repeat k]
 *        node bin/bench.ts score <case dir> <out> --repo <clone> [--drop-env]
 *        node bin/bench.ts judge <case dir> <out> [--pairs all|human]
 *        node bin/bench.ts report <out>
 * A case dir holds case.json, issue.md and merged.diff. Each step skips outputs that exist, keeps everything under
 * <out>/<case id>/<arm>, and appends to <out>/log.jsonl. Paid steps stop past --max-codex weekly Codex points over the
 * first reading, or after --max-claude-calls judge calls. Model keys come from --keys, infra/local/.keys.env by default.
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { parseArgs, parseEnv } from 'node:util';
import { dockerArgs, type Made } from '../src/docker.ts';
import { dependencyDirs, drop, envOf, manifest, ownerId, room, seed } from '../src/env.ts';
import {
  append,
  attic,
  benchEnv,
  busy,
  claim,
  clock,
  down,
  jsonl,
  onStop,
  pin,
  publish,
  release,
  settle,
  sleep,
  sweep,
  write,
} from './resume.ts';
let engine = process.env.BENCH_ENGINE ?? join(import.meta.dirname, '..');

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
  /** The part of setup that builds from the repo's files, run again on every scored diff. */
  build?: string;
  runner?: string;
  /** The image the score step starts from, in place of the sandbox image. */
  image?: string;
};
type Finding = { severity: string; category: string; text: string };
type Verdict = { A?: { findings?: Finding[] }; B?: { findings?: Finding[] }; prefer: 'A' | 'B' | 'tie'; why?: string };

const bots = ['v2', 'floor', 'v1'];
const arms = ['human', ...bots, 'control'];
const hubs: Record<string, string> = { clarinet: 'clarinet', 'acme-app': 'sk', 'bothub-sandbox': 'sandbox' };
const strataKeys = ['repo', 'size', 'kind', 'bucket', 'filesBucket', 'area', 'issue'];
const answer = '/agent No more information. Use your judgment.';
const limits = { codex: 30, claude: 60 };
const options = { point: process.env.BENCH_POINT, repeat: 1, pairs: 'all' };
let panel: Record<string, number> = { opus: 1, sonnet: 2, sol: 2 };
const testPath = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.\w+$|_tests?\.\w+$/;
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
const save = write;
const lines = jsonl;
const logger =
  (out: string, entry: Record<string, unknown> = {}) =>
  (more: object) =>
    append(join(out, 'log.jsonl'), { at: new Date().toISOString(), pid: process.pid, ...entry, ...more });
const step = async <A>(out: string, entry: Record<string, unknown>, f: () => A | Promise<A>) => {
  const log = logger(out, entry);
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
/** The pnpm version from packageManager, else the major that writes the lockfile's version, else `fallback`. */
const pnpmVersion = (fallback: string) =>
  `node -p "const m = require('./package.json').packageManager ?? ''; const v = /lockfileVersion: '?(\\d+)/.exec(require('fs').readFileSync('pnpm-lock.yaml', 'utf8'))?.[1]; m.startsWith('pnpm@') ? m.slice(5).split('+')[0] : ({ 5: '7', 6: '8' })[v] ?? '${fallback}'"`;
const install = (fallback: string) =>
  `npx --yes pnpm@$(${pnpmVersion(fallback)}) install --frozen-lockfile --ignore-scripts --store-dir node_modules/.pnpm-store`;
/** Builds the wasm SDK and the node package, then runs the clarinet SDK test files. */
const clarinetSdk = (files: string[]): Commands => {
  const node = 'components/clarinet-sdk/node';
  const wasm = 'npm exec --yes --package=wasm-pack@0.15.0 -- node components/clarinet-sdk-wasm/build.mjs';
  const tsc = `(cd ${node} && npx tsc -b ./tsconfig.json ./tsconfig.cjs.json && node ./scripts/prepare-esm-package.js)`;
  return {
    build: [`(${wasm} || ${wasm})`, tsc].join(' && '),
    setup: [
      'rustup target add wasm32-unknown-unknown',
      `(${wasm} || ${wasm})`,
      `if [ -f pnpm-lock.yaml ]; then ${install('11.1.3')}; else npm ci --no-audit --no-fund --ignore-scripts; fi`,
      tsc,
    ].join(' && '),
    test: `(cd ${node} && npx vitest run ${files.map(p => quote(p.slice(node.length + 1))).join(' ')})`,
  };
};
/** Cargo commands for test targets, fixtures under a crate's tests/ and `*_tests.rs` modules in src. */
const cargoTests = (tests: string[]) => {
  const at = (re: RegExp) =>
    tests.flatMap(p => {
      const m = re.exec(p);
      return m ? [[m[1]!, m[2]!] as const] : [];
    });
  const targets = at(/^components\/([^/]+)\/tests\/([^/]+)\.rs$/);
  const fixtures = at(/^components\/([^/]+)\/tests\/(.+\.(?!rs$)\w+)$/)
    .map(([crate]) => crate)
    .filter(crate => !targets.some(([named]) => named === crate));
  return [
    ...targets.map(([crate, test]) => `cargo test -p ${crate} --test ${test}`),
    ...[...new Set(fixtures)].map(crate => `cargo test -p ${crate} --tests`),
    ...at(/^components\/([^/]+)\/src\/(.+_tests)\.rs$/).map(
      ([crate, mod]) => `cargo test -p ${crate} --lib ${mod.replaceAll('/', '::')}`
    ),
  ];
};

/** The test command and its setup, from the repo and the test files a merged change touches. */
export const plan = (repo: string, tests: string[]): Commands => {
  const name = repo.split('/').pop();
  const js = [...new Set(tests.map(p => p.replace(/^(.*\/)__snapshots__\/(.+)\.snap$/, '$1$2')))].filter(p =>
    /\.(test|spec)\.[jt]sx?$/.test(p)
  );
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
  if (name !== 'clarinet') return { hasTests: false };
  const sdk = js.filter(p => p.startsWith('components/clarinet-sdk/node/tests/'));
  const run = sdk.length ? clarinetSdk(sdk) : {};
  const test = [...cargoTests(tests), ...(run.test ? [run.test] : [])];
  return test.length ? { ...run, test: test.join(' && ') } : { hasTests: false };
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

/**
 * Points every agent of a hub at `harness:model`, by the two lines of its front matter. Every agent gets the point's
 * key, else its own, else the implementor's, so an agent a tune adds still has one.
 */
export const repoint = (hub: string, point: string) => {
  const [harness, model] = point.split(':');
  const dir = join(hub, 'agents');
  const names = existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.md')) : [];
  for (const name of names)
    save(
      join(dir, name),
      read(join(dir, name)).replace(/^---\n[\s\S]*?\n---/, head =>
        head.replace(/^harness: .*$/m, `harness: ${harness}`).replace(/^model: .*$/m, `model: ${model}`)
      )
    );
  const key = process.env[`BOTHUB_LLM_API_KEY_PT_${point.replace(/\W/g, '_').toUpperCase()}`];
  const own = new Map(
    (process.env.BOTHUB_PROXY_KEYS ?? '').split(',').flatMap(kv => {
      const at = kv.indexOf('=');
      return at > 0 ? [[kv.slice(0, at), kv.slice(at + 1)] as const] : [];
    })
  );
  const spare = key ?? own.get('implementor') ?? [...own.values()][0];
  for (const name of names.map(n => basename(n, '.md'))) if (spare && (key || !own.has(name))) own.set(name, spare);
  if (own.size) process.env.BOTHUB_PROXY_KEYS = [...own].map(([k, v]) => `${k}=${v}`).join(',');
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
  forge(dir, 'comment', '1', '/agent');
  process.env.BOTHUB_FORGE = dir;
  let answers = 0;
  let status: string | undefined;
  let reason: string | undefined;
  for (let pass = 0; pass < 6; pass++) {
    const [run] = await start({ hub, issue: 1, data: join(at, 'data') });
    status = run?.status;
    reason = run?.reason;
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
  const diff = head ? sh('git', ['--git-dir', origin, 'diff', c.base, head]) : '';
  return { answers, status, ...(reason && { reason: reason.slice(0, 500) }), diff };
};

/** Why an arm attempt broke on its environment, not on the agent: the engine stopped on a runner error. */
export const runnerError = (reason = '') =>
  /runner error|^(SandboxError|SessionStop|ForgeError)\b/.test(reason) ? reason.slice(0, 200) : undefined;

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

/** The harness's last words when the run's last session ended in an error, as when it cannot reach the proxy. */
export const harnessError = (data: string) => {
  const ends = (existsSync(data) ? readdirSync(data) : [])
    .flatMap(id => lines(join(data, id, 'trace.jsonl')))
    .flatMap(t => {
      const e = t.event as { type?: string; ended?: string; final?: string } | undefined;
      return e?.type === 'end' ? [e] : [];
    });
  const last = ends.at(-1);
  return last?.ended === 'error' ? `harness error: ${String(last.final ?? '').slice(0, 160)}` : undefined;
};

/** Environment failures an arm may have before it counts as infra, across restarts. */
const patience = 6;

/**
 * Runs one arm of a case once. Done means `diff.patch` exists, written last. A run the agent ended with nothing is
 * tried twice, then done as infra. A run its environment broke (proxy, docker, a runner error, the machine asleep)
 * waits for the environment and is tried again, and stays undone until it works or fails `patience` times.
 */
const runArm = async (arm: string, caseDir: string, out: string, repo: string) => {
  const c = loadCase(caseDir);
  const at = join(out, c.id, arm);
  if (arm === 'v1')
    throw new Error('not yet: v1 needs its own sandbox image, env and a leak-free seed (docs/bench.md)');
  if (existsSync(join(at, 'diff.patch'))) return;
  if (!process.env.BOTHUB_PROXY_KEYS) throw new Error('no model keys: pass --keys <env file>');
  const log = logger(out, { case: c.id, arm });
  if (!claim(at)) return log({ event: 'busy' });
  onStop(signal => {
    log({ event: 'paused', signal });
    sweep(at);
    release(at);
  });
  try {
    sweep(at);
    if (await prepare(c, out, repo)) return;
    const aside = () => {
      const to = attic(at);
      if (to) log({ event: 'attic', to });
    };
    aside();
    const kept = armSlot(c, arm);
    if (reusable(kept)) return publish(kept!, at);
    const failed = () =>
      lines(join(out, 'log.jsonl')).filter(l => l.event === 'infra' && l.case === c.id && l.arm === arm);
    for (let attempt = 0, empty = 0; ; attempt++) {
      await settle(log, false, net => down(net, { dir: out, ...(cache && { image, volume: cache }) }));
      aside();
      guard(out, false);
      const started = Date.now();
      const time = clock();
      let ran: Awaited<ReturnType<typeof engineArm>> | undefined;
      let broke: string | undefined;
      try {
        ran = await step(out, { step: 'run', case: c.id, arm }, () => engineArm(c, arm, at, resolve(repo)));
      } catch (e) {
        broke = String(e).slice(0, 200);
      }
      time.stop();
      const { diff = '', ...meta } = ran ?? {};
      const nothing = ran && infra({ ...stats(diff), ...meta });
      const env =
        broke ??
        runnerError(ran?.reason) ??
        harnessError(join(at, 'data')) ??
        (nothing ? ((await down()) ?? (time.missed() ? 'the machine slept' : undefined)) : undefined);
      if (env) {
        log({ event: 'infra', why: env, attempt });
        if (failed().length < patience) {
          await sleep(Math.min(60_000 * 2 ** attempt, 900_000));
          continue;
        }
      }
      save(join(at, 'meta.json'), {
        ...meta,
        ms: Date.now() - started - time.missed(),
        ...(time.missed() && { slept: time.missed() }),
        ...((env ?? nothing) && { infra: env ?? nothing }),
      });
      if (!env && nothing && ++empty < 2) continue;
      save(join(at, 'usage.json'), effort(join(at, 'data')));
      save(join(at, 'diff.patch'), diff);
      if (!env && !nothing) keep(at, kept);
      return;
    }
  } finally {
    release(at);
  }
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
const image = process.env.BOTHUB_IMAGE || 'bothub-sandbox:local';
const cache = process.env.BOTHUB_CACHE_VOLUME ?? 'bothub-cache';
const scoreSize = { memory: '8g', cpus: '4', pids: '2048' };

/** One score command in its own container on the tree at `/work`, with no network unless `open`. */
const exec = (cmd: string, tree: string, box: Made, from: string, network: 'none' | 'open' = 'none') => {
  const started = Date.now();
  const name = `bothub-score-${randomBytes(6).toString('hex')}`;
  const c = { cmd: 'sh', args: ['-c', cmd], dir: tree, env: { NODE_OPTIONS: '' }, network, minutes: 60 };
  const r = spawnSync('docker', dockerArgs(c, from, name, box, cache, scoreSize), {
    encoding: 'utf8',
    timeout: 3_600_000,
    maxBuffer: 1 << 28,
  });
  if (r.error) spawnSync('docker', ['rm', '-f', name]);
  if (r.error && (r.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT')
    throw new Error(`docker could not run a score container: ${r.error.message}`);
  if (r.status === 125 || /Cannot connect to the Docker daemon/.test(r.stderr ?? ''))
    throw new Error(`docker could not start a score container: ${r.stderr.slice(-2000)}`);
  return { ok: r.status === 0, ms: Date.now() - started, tail: `${r.stdout}${r.stderr}`.slice(-8000) };
};

const coupled =
  /Cannot find module|Failed to resolve import|is not a function|is not exported|does not provide an export|No matching export|is not defined|is not a constructor|TS\d{4}|Cannot destructure|Cannot read propert/i;

/** Whether a failed hidden run broke on the human's names and signatures (coupled) or on a result (behaviour). */
export const failureClass = (tail: string) => (coupled.test(tail) ? 'coupled' : 'behaviour');

/**
 * Scores a diff in the case's Env: setup runs again only when the diff touches a manifest or the Env could not hold
 * everything setup made, else only `build`, and nothing for an empty diff. Hidden tests reach the tree after the Env exists.
 */
const check = async (c: Case & Commands, tree: string, diff: string, hidden: string[], repo: string) => {
  sh('git', ['-C', tree, 'checkout', '-q', '-f', c.base]);
  sh('git', ['-C', tree, 'clean', '-qfdx']);
  if (
    diff &&
    spawnSync('git', ['-C', tree, 'apply', '--whitespace=nowarn', '-'], {
      input: diff.endsWith('\n') ? diff : `${diff}\n`,
    }).status
  )
    return { applied: false };
  const git = existsSync(join(repo, '.git')) ? join(repo, '.git') : repo;
  const start = c.image ?? image;
  const found = spawnSync('docker', ['image', 'inspect', start], { encoding: 'utf8' });
  if (found.status !== 0)
    throw new Error(`score needs docker and the ${start} image: ${found.error?.message ?? found.stderr.trim()}`);
  if (cache) await room({ dir: tree, image: start, volume: cache });
  const env = cache
    ? await envOf({ repo: c.repo, image: start, git, base: c.base, cache, ...(c.setup && { setup: c.setup }) })
    : undefined;
  const seeds = cache
    ? await seed(env ?? { image: start, outputs: [] }, ownerId(), tree, await dependencyDirs(git, c.base))
    : [];
  const box = { mounts: [{ src: git, dst: git, readonly: true }], seeds };
  const from = env?.image ?? start;
  try {
    const again = !env?.complete || files(diff).some(f => manifest.test(f.path));
    const prep = again ? c.setup : diff.trim() ? c.build : undefined;
    const suite = c.suite ?? c.test;
    const result = {
      applied: true,
      ...(env && { env: env.image }),
      ...(prep && { setup: exec(prep, tree, box, from, 'open') }),
      ...(suite && { suite: exec(suite, tree, box, from) }),
      ...(c.typecheck && { typecheck: exec(c.typecheck, tree, box, from) }),
    };
    if (!c.test || !hidden.length) return result;
    for (const path of hidden)
      if (spawnSync('git', ['-C', tree, 'checkout', c.merged, '--', path]).status)
        rmSync(join(tree, path), { force: true });
    const run = exec(c.test, tree, box, from);
    return { ...result, hidden: run.ok ? run : { ...run, class: failureClass(run.tail) } };
  } finally {
    await drop(seeds);
  }
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

/** Writes an arm's usage beside it, then copies it to `kept` without its data, forge, hub or attic dirs. */
export const keep = (at: string, kept: string | undefined) => {
  if (!existsSync(join(at, 'usage.json'))) save(join(at, 'usage.json'), effort(join(at, 'data')));
  if (kept) publish(at, kept, p => !/\/(data|forge|hub|\.attic)$/.test(p));
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
  while (!claim(tree)) await sleep(5000);
  try {
    if (!existsSync(tree)) sh('git', ['clone', '-q', '--shared', '--no-checkout', resolve(repo), tree]);
    for (const arm of which) {
      const at = join(root, arm);
      if (!existsSync(join(at, 'diff.patch')) || existsSync(join(at, 'score.json'))) continue;
      const diff = read(join(at, 'diff.patch'));
      const meta = JSON.parse(read(join(at, 'meta.json')) || '{}') as { answers?: number; ms?: number };
      const tests = await step(out, { step: 'score', case: c.id, arm }, () =>
        (c.test || c.suite) && c.hasTests !== false ? check(c, tree, diff, hidden, resolve(repo)) : {}
      );
      const offline = (tests as Tests).setup?.ok === false && (await down(true));
      if (offline) throw new Error(`infra: setup failed while ${offline}, ${c.id}/${arm} stays unscored`);
      save(join(at, 'score.json'), { ...tests, ...stats(diff, human), ...usage(at), ...meta });
    }
  } finally {
    rmSync(tree, { recursive: true, force: true });
    release(tree);
  }
};

/** Removes the scoring trees under `out` that no live process holds. */
const reapTrees = (out: string) => {
  for (const id of existsSync(out) ? readdirSync(out) : []) {
    const tree = join(out, id, 'tree');
    if (existsSync(tree) && !busy(tree)) rmSync(tree, { recursive: true, force: true });
  }
};

type Tests = { applied?: boolean; setup?: { ok: boolean }; suite?: { ok: boolean }; hidden?: { ok: boolean } };

/** Why a case cannot tell arms apart, when it cannot: the hidden tests must fail on base and pass on the human. */
export const invalid = (base: Tests, human: Tests, tested = false) => {
  if (human.applied === false) return 'the human diff does not apply to base';
  if (base.setup?.ok === false || human.setup?.ok === false) return 'setup fails';
  if (!base.hidden || !human.hidden) return tested ? 'no hidden tests run' : undefined;
  if (base.hidden.ok) return 'base already passes the hidden tests';
  if (!human.hidden.ok) return 'the human fails the hidden tests';
  if (human.suite?.ok === false) return 'the human fails the suite';
  return undefined;
};

/** The base commit's file list, a file's text, and whether a word occurs anywhere in it. */
export type Base = { files: string[]; text: (path: string) => string; has: (word: string) => boolean };

const baseOf = (repo: string, base: string): Base => {
  const at = (...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return {
    files: at('ls-tree', '-r', '--name-only', base).stdout.split('\n').filter(Boolean),
    text: path => at('show', `${base}:${path}`).stdout ?? '',
    has: word => at('grep', '-q', '-w', '-F', word, base).status === 0,
  };
};

const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js'];
const specifiers =
  /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]|\b(?:jest|vi)\.mock\(\s*['"]([^'"]+)['"]/g;
const named = /\bimport\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
const used = /^\s*(?:pub\s+)?use\s+([\w:]+?)(?:::\{([^}]*)\}|::(\w+))?\s*;/gm;
const word = (name: string) => new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`);

/** Which repo paths a module specifier names: exactly when relative, a package's index when scoped, else by suffix. */
const target = (from: string, spec: string) => {
  const bare = spec.replace(/\.js$/, '');
  if (spec.startsWith('.')) {
    const path = join('/', from.split('/').slice(0, -1).join('/'), bare).slice(1);
    return (p: string) => extensions.some(e => p === path + e);
  }
  if (!/^[@~#]/.test(spec) || !spec.includes('/')) return undefined;
  const tail = bare.split('/').slice(1).join('/');
  if (/^@[\w-]+\/[\w.-]+$/.test(spec)) {
    const index = new RegExp(`(^|/)${tail.replace(/\./g, '\\.')}(/src)?/index\\.[jt]sx?$`);
    return (p: string) => index.test(p);
  }
  return (p: string) => extensions.some(e => p.endsWith(`/${tail}${e}`) || p === tail + e);
};

/**
 * What ties a case's hidden tests to the human's exact interface rather than its behaviour: an import of a path the
 * human's diff added, or of a name only its source lines add, that the base lacks and the issue never mentions, and a
 * hidden snapshot.
 */
export const couplings = (diff: string, issue: string, base: Base) => {
  const said = flat(issue);
  const mentioned = (name: string) => said.includes(flat(name));
  const parts = files(diff).filter(f => !noise.test(f.path));
  const added = (part: string) =>
    part
      .split('\n')
      .filter(l => l.startsWith('+') && !l.startsWith('+++'))
      .map(l => l.slice(1))
      .join('\n');
  const src = parts.filter(f => !testPath.test(f.path));
  const made = src.filter(f => /^(new file mode|--- \/dev\/null)/m.test(f.part));
  const source = src.map(f => added(f.part)).join('\n');
  const created = (name: string) => word(name).test(source);
  const found: string[] = [];
  for (const { path, part } of parts.filter(f => testPath.test(f.path))) {
    const text = added(part);
    const matchers = text.match(/\.to[A-Z]\w*\s*\(/g) ?? [];
    if (/(^|\/)__snapshots__\/|\.snap$/.test(path) || (matchers.length && matchers.every(m => /Snapshot/.test(m)))) {
      found.push(`${path}: snapshot`);
      continue;
    }
    for (const m of text.matchAll(specifiers)) {
      const spec = m.slice(1).find(Boolean)!;
      const is = target(path, spec);
      const name = spec
        .replace(/(\/index)?(\.\w+)?$/, '')
        .split('/')
        .pop()!;
      if (is && !base.files.some(is) && made.some(f => is(f.path)) && !mentioned(name))
        found.push(`${path}: imports ${spec}, which only the human adds`);
    }
    for (const m of text.matchAll(named)) {
      const is = target(path, m[2]!);
      const texts = (is ? base.files.filter(is) : []).map(base.text);
      if (!texts.length || texts.some(t => /^export \*/m.test(t))) continue;
      for (const name of m[1]!.split(',').map(
        n =>
          n
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)[0]!
      ))
        if (name && created(name) && !texts.some(t => word(name).test(t)) && !mentioned(name))
          found.push(`${path}: imports ${name} from ${m[2]}, which only the human exports`);
    }
    if (!path.endsWith('.rs')) continue;
    for (const m of text.matchAll(used))
      for (const name of (m[2] ? m[2].split(',') : [m[3] ?? m[1]!]).map(n =>
        n
          .trim()
          .split(/\s+as\s+/)[0]!
          .split('::')
          .pop()!
      ))
        if (
          /^\w+$/.test(name) &&
          !['self', 'super', 'crate'].includes(name) &&
          created(name) &&
          !base.has(name) &&
          !mentioned(name)
        )
          found.push(`${path}: uses ${name}, which only the human defines`);
  }
  return found;
};

let tools: string | undefined;
/** The bench's scoring code and the image the score step starts from, which a validity verdict depends on. */
export const scorer = () =>
  (tools ??= hash(
    [check, invalid, exec, image].join('\0') +
      spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8' }).stdout
  ));

const prepare = async (c: Case & Commands, out: string, repo: string) => {
  const file = join(out, c.id, 'valid.json');
  if (!existsSync(file)) {
    const coupled = couplings(read(join(c.dir, 'merged.diff')), `${c.title}\n${c.body}`, baseOf(repo, c.base));
    if (coupled.length) save(file, { invalid: 'coupled', coupled });
  }
  const kept = slot(
    'valid',
    c.id,
    c.base,
    c.merged,
    c.runner,
    c.setup,
    c.test,
    ...(c.image ? [c.image] : []),
    scorer()
  );
  if (!existsSync(file) && reusable(kept)) {
    cpSync(kept!, join(out, c.id), { recursive: true, filter: p => !p.endsWith('/valid.json') });
    save(file, read(join(kept!, 'valid.json')));
  }
  if (!existsSync(file)) {
    await scoreArms(c, out, repo, ['base', 'human']);
    const tests = (arm: string) => JSON.parse(read(join(out, c.id, arm, 'score.json')) || '{}') as Tests;
    const why = invalid(tests('base'), tests('human'), c.bucket === 'tests' || Boolean(c.test));
    save(file, { invalid: why });
    if (kept && why !== 'setup fails')
      publish(join(out, c.id), kept, p => !/\/(tree|v2|floor|judge|\.attic)$/.test(p) && !p.endsWith('.lock'));
  }
  return (JSON.parse(read(file)) as { invalid?: string }).invalid;
};

/** Removes the Env images a case's scores ran in; docker keeps one a container still uses. */
const dropEnvs = (root: string) => {
  const used = readdirSync(root).flatMap(arm => {
    const env = (JSON.parse(read(join(root, arm, 'score.json')) || '{}') as { env?: string }).env;
    return env ? [env] : [];
  });
  for (const image of new Set(used)) spawnSync('docker', ['rmi', image], { stdio: 'ignore' });
};

const score = async (caseDir: string, out: string, repo: string, drop = false) => {
  const c = loadCase(caseDir);
  if (!(await prepare(c, out, repo))) await scoreArms(c, out, repo, bots);
  if (drop && existsSync(join(out, c.id))) dropEnvs(join(out, c.id));
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
const proxied = (model: string) => async (prompt: string) => {
  const r = await fetch('http://127.0.0.1:4000/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.BOTHUB_LLM_API_KEY_REVIEWER}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
  });
  return ((await r.json()) as { choices?: { message: { content: string } }[] }).choices?.[0]?.message.content ?? '';
};
const judges: Record<string, (prompt: string, cwd: string) => Promise<string>> = {
  opus: claude('opus'),
  sonnet: claude('sonnet'),
  sol: proxied('smart'),
  gemini: proxied('gemini'),
};
const judgeModels: Record<string, string> = { opus: 'claude-opus', sonnet: 'claude-sonnet', sol: 'smart', gemini: 'gemini' };
const upstream = (JSON.parse(read(here('infra/local/prices.json')) || '{}') as { aliases?: Record<string, string> })
  .aliases;

/** The maker of a proxy alias or model, from its upstream name: openai, anthropic, google, z-ai, x-ai and so on. */
export const family = (model: string, aliases = upstream ?? {}) => {
  const name = (aliases[model] ?? model).replace(/^openrouter\//, '');
  if (/^(chatgpt|openai)\/|^gpt-/.test(name)) return 'openai';
  if (/^(anthropic\/)?claude/.test(name)) return 'anthropic';
  return name.includes('/') ? name.split('/')[0]! : name;
};

/** The panel with each judge of the contestant's family swapped for the first of sol, gemini, opus from another one. */
export const unbiased = (chosen: Record<string, number>, contestant: string, aliases = upstream ?? {}) => {
  const own = family(contestant, aliases);
  const other = (name: string) => family(judgeModels[name]!, aliases) !== own;
  const out: Record<string, number> = {};
  for (const [name, n] of Object.entries(chosen)) {
    const judge = other(name) ? name : ['sol', 'gemini', 'opus'].find(j => other(j) && !(j in chosen) && !(j in out));
    if (judge) out[judge] = n;
  }
  return out;
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
          Object.entries(unbiased(panel, options.point?.split(':')[1] ?? 'smart'))
            .filter(([, n]) => orders(n, `${c.id}/${x}-${y}`).includes(at))
            .map(async ([name]) => {
              const ask = judges[name]!;
              const kept = slot('judge', name, prompt);
              for (let attempt = 0; attempt < 3 && !existsSync(join(dir, `${name}.json`)); attempt++) {
                const hit = reusable(kept);
                if (!hit) guard(out, family(judgeModels[name]!) === 'anthropic');
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

type Unit = { out: string; case: string; arm: string };

/** Where a set of arm runs stands: each unit's state, environment retries, a current wait and the time left. */
export const progress = (units: Unit[], parallel = 1) => {
  const json = (path: string) => JSON.parse(read(path) || '{}') as Record<string, unknown>;
  const state = (u: Unit) => {
    const at = join(u.out, u.case, u.arm);
    if (existsSync(join(at, 'diff.patch'))) return json(join(at, 'meta.json')).infra ? 'infra' : 'done';
    if (json(join(u.out, u.case, 'valid.json')).invalid) return 'invalid';
    return busy(at) ? 'running' : 'left';
  };
  const states = units.map(u => ({ ...u, state: state(u) }));
  const count = (k: string) => states.filter(u => u.state === k).length;
  const logs = [...new Set(units.map(u => u.out))].flatMap(out => lines(join(out, 'log.jsonl')));
  logs.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const last = logs.filter(l => ['wait', 'resume', 'start', 'end', 'paused'].includes(String(l.event))).at(-1);
  const ms = states.flatMap(u =>
    u.state === 'done' ? [Number(json(join(u.out, u.case, u.arm, 'meta.json')).ms) || []].flat() : []
  );
  const minutes = ms.length ? mean(ms) / 60_000 : undefined;
  return {
    total: units.length,
    done: count('done'),
    infra: count('infra'),
    invalid: count('invalid'),
    left: count('left'),
    running: states.filter(u => u.state === 'running').map(u => `${u.case}/${u.arm}`),
    retries: logs.filter(l => l.event === 'infra').length,
    ...(last?.event === 'wait' && { waiting: `${String(last.why)} since ${String(last.at)}` }),
    ...(minutes !== undefined && {
      eta: Math.round((minutes * (count('left') + count('running'))) / Math.max(1, parallel)),
    }),
  };
};

/** The units of an out dir: from `units.json` when a driver wrote one, else every case and arm seen. */
const unitsOf = (out: string) => {
  const planned = JSON.parse(read(join(out, 'units.json')) || 'null') as {
    units: Omit<Unit, 'out'>[];
    parallel?: number;
  } | null;
  const seen = readdirSync(out).flatMap(id =>
    existsSync(join(out, id, 'human'))
      ? bots
          .filter(a => existsSync(join(out, id, a)) || existsSync(join(out, id, `${a}.lock`)))
          .map(arm => ({ case: id, arm }))
      : []
  );
  return { units: (planned?.units ?? seen).map(u => ({ ...u, out })), parallel: planned?.parallel ?? 1 };
};

export const statusText = (p: ReturnType<typeof progress>) =>
  [
    `${p.done}/${p.total} done, ${p.infra} infra, ${p.invalid} invalid, ${p.running.length} running, ${p.left} left`,
    ...(p.running.length ? [`running: ${p.running.join(', ')}`] : []),
    `environment retries: ${p.retries}`,
    ...(p.waiting ? [`waiting: ${p.waiting}`] : []),
    ...(p.eta !== undefined ? [`about ${p.eta} min left`] : []),
  ].join('\n');

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
      keys: { type: 'string' },
      'max-codex': { type: 'string', default: '30' },
      'max-claude-calls': { type: 'string', default: '60' },
      judges: { type: 'string', default: 'opus:1,sonnet:2,sol:2' },
      point: { type: 'string' },
      repeat: { type: 'string', default: '1' },
      pairs: { type: 'string', default: 'all' },
      'drop-env': { type: 'boolean', default: false },
    },
  });
  const [command, a, b, c] = positionals;
  const out = command === 'run' ? c : ['score', 'judge'].includes(command ?? '') ? b : undefined;
  const env = out
    ? pin(join(resolve(out), 'env.json'), {
        ...benchEnv(),
        ...(values.keys && { keys: resolve(values.keys) }),
        ...(values.point && { point: values.point }),
      })
    : {};
  for (const [k, v] of Object.entries(env)) if (k.startsWith('BENCH_')) process.env[k] ??= v;
  engine = process.env.BENCH_ENGINE ?? engine;
  if (out && command !== 'judge') reapTrees(resolve(out));
  const point = env.point ?? values.point ?? process.env.BENCH_POINT;
  if (point && !/^[\w-]+:[\w.-]+$/.test(point)) throw new Error(`bad --point ${point}`);
  if (!['all', 'human'].includes(values.pairs)) throw new Error(`bad --pairs ${values.pairs}`);
  Object.assign(options, { point, repeat: Number(values.repeat), pairs: values.pairs });
  Object.assign(limits, { codex: Number(values['max-codex']), claude: Number(values['max-claude-calls']) });
  panel = parsePanel(values.judges);
  loadKeys(env.keys ?? values.keys ?? here('infra/local/.keys.env'));
  if (command === 'run' && a && bots.includes(a) && b && c && values.repo) await runArm(a, b, resolve(c), values.repo);
  else if (command === 'score' && a && b && values.repo) await score(a, resolve(b), values.repo, values['drop-env']);
  else if (command === 'judge' && a && b) await judge(a, resolve(b));
  else if (command === 'report' && a) {
    save(join(a, 'report.md'), report(a));
    console.log(read(join(a, 'report.md')));
  } else if (command === 'status' && a) {
    const { units, parallel } = unitsOf(resolve(a));
    console.log(statusText(progress(units, parallel)));
  } else {
    console.error('usage: node bin/bench.ts (run (v2|floor|v1) <case> <out> | score <case> <out>) --repo <clone>');
    console.error('       node bin/bench.ts judge <case> <out> | report <out> | status <out>');
    process.exit(2);
  }
}
