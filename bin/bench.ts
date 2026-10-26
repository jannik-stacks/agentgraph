/**
 * Replays merged pull requests on v2 and on a plain single session (floor), then scores and judges them blind.
 * Usage: node bin/bench.ts run (v2|floor) <case dir> <out> --repo <clone> [--point harness:model] [--repeat k]
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
import { basename, dirname, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash, randomBytes } from 'node:crypto';
import { parseArgs, parseEnv, stripVTControlCharacters } from 'node:util';
import { Effect } from 'effect';
import { dockerArgs, type CheckoutContainerSpec } from '../src/docker.ts';
import { getModelPrice, type Prices } from '../src/harnesses.ts';
import {
  dependencyDirs,
  discard,
  readSandboxSetup,
  createSharedMounts,
  manifest,
  removeOrphanedVolumes,
  written,
} from '../src/env.ts';
import { collect, ensureFreeDisk, findBuildDirs } from '../src/disk.ts';
import { getMean, getRounded } from '../src/stats.ts';
import type * as MainModule from '../src/main.ts';
import { writeIssueFile } from '../src/forge.ts';
import { writeComment } from '../src/instance.ts';
import { writeFileAtomic } from '../src/store.ts';
import {
  agentgraphDir,
  appendJsonl,
  moveDirToAttic,
  readBenchResultEnv,
  claim,
  clock,
  down,
  readJsonl,
  onStop,
  ensureRunSettingsPinned,
  copyDirIfAbsentAtomic,
  release,
  waitWhileServicesDown,
  readFileOrEmpty,
  removeSandboxContainersMountingDir,
} from './resume.ts';
import { isLockedByOtherProcess } from '../src/owner.ts';
import { hostSettings } from '../src/services.ts';
let engine = process.env.BENCH_ENGINE ?? agentgraphDir;

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
  /** Extra toolchain installs, run before setup under the cache's toolchain lock. */
  toolchain?: string;
  /** The part of setup that builds from the repo's files, run again on every scored diff. */
  build?: string;
  runner?: string;
  /** The image the score step starts from, in place of the sandbox image. */
  image?: string;
};
type Finding = { severity: string; category: string; text: string };
type Verdict = { A?: { findings?: Finding[] }; B?: { findings?: Finding[] }; prefer: 'A' | 'B' | 'tie'; why?: string };

const bots = ['v2', 'floor'];
/** Repos a bench never runs or reports. */
const excluded = new Set(['billing']);
const benched = (repo = '') => !excluded.has(repo.split('/').pop() ?? '');
const arms = ['human', ...bots, 'control'];
const hubs: Record<string, string> = {
  clarinet: 'clarinet',
  'acme-app': 'acme-app',
  'agentgraph-sandbox': 'sandbox',
};
const strataKeys = ['repo', 'tests', 'size', 'kind', 'bucket', 'filesBucket', 'area', 'issue'];
const answer = '/agent No more information. Use your judgment.';
const limits = { codex: 30, claude: 60 };
const options = { point: process.env.BENCH_POINT, repeat: 1, pairs: 'all' };
let panel: Record<string, number> = { opus: 1, sonnet: 2, sol: 2 };
const testPath = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.\w+$|_tests?\.\w+$/;
const noise =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|CHANGELOG[^/]*|[^/]*\.tsbuildinfo)$|(^|\/)\.(husky|changeset)\//;
const caseStart = /^\s*(?:(?:it|test)(?:\.\w+)*\s*\(|#\[(?:tokio::)?test\]|def test_|func Test)/;
const branches = /\b(?:if|for|while|match|case|catch|loop)\b|&&|\|\|/g;
const comment = /^\s*(\/\/|\/\*|\*|#(?!\[))/;

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 20);
const treeText = (dir: string): string =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? [treeText(join(dir, e.name))] : [e.name, readFileSync(join(dir, e.name), 'utf8')]))
    .join('\0');
/** Where a result is kept for reuse: nothing is reused without BENCH_CACHE or with BENCH_FRESH. */
const slot = (kind: string, ...key: unknown[]) =>
  process.env.BENCH_CACHE ? join(process.env.BENCH_CACHE, kind, hash(JSON.stringify(key))) : undefined;
const reusable = (dir: string | undefined) => dir !== undefined && !process.env.BENCH_FRESH && existsSync(dir);
const sh = (cmd: string, args: string[], o: { cwd?: string; env?: Record<string, string> } = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...o, env: { ...process.env, ...o.env } });
const logger =
  (out: string, entry: Record<string, unknown> = {}) =>
  (more: object) =>
    appendJsonl(join(out, 'log.jsonl'), { at: new Date().toISOString(), pid: process.pid, ...entry, ...more });
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
/**
 * One cargo command per hidden Rust file: an integration target, a module of a target directory, or a test module in
 * src; fixtures under tests/ run every test target of their crate when no Rust file does. `crate` selects the crate
 * at a directory, the workspace root when empty.
 */
const cargoTests = (tests: string[], crate = (dir: string) => `--manifest-path ${dir}/Cargo.toml`) => {
  const at = (dir = '') => (dir ? `${crate(dir)} ` : '');
  const rust = tests.filter(p => p.endsWith('.rs') && !/(^|\/)benches\//.test(p));
  const runs = rust.flatMap(p => {
    const lib = /^(?:(.*?)\/)?src\/(.+)\.rs$/.exec(p);
    if (lib) {
      const mod = lib[2]!.replace(/\/mod$/, '');
      return /_tests?$|(^|\/)tests?(\/|$)/.test(mod)
        ? [`cargo test ${at(lib[1])}--lib ${mod.replaceAll('/', '::')}`]
        : [];
    }
    const file = /^(?:(.*)\/)?tests\/([^/]+)\.rs$/.exec(p);
    if (file) return [`cargo test ${at(file[1])}--test ${file[2]}`];
    const dir = /^(?:(.*)\/)?tests\/([^/]+)\/(.+)\.rs$/.exec(p);
    if (!dir) return [];
    const target = `cargo test ${at(dir[1])}--test ${dir[2]}`;
    const mod = dir[3]!.replace(/(^|\/)mod$/, '');
    if (mod && mod !== 'main') return [`${target} ${mod.replaceAll('/', '::')}::`];
    return rust.some(o => o !== p && o.startsWith(p.slice(0, p.lastIndexOf('/') + 1))) ? [] : [target];
  });
  const fixtures = tests.flatMap(p =>
    /\.(rs|[cm]?[jt]sx?)$/.test(p) ? [] : (/^(?:(.*)\/)?tests\//.exec(p)?.slice(1, 2) ?? [])
  );
  return runs.length ? [...new Set(runs)] : [...new Set(fixtures)].map(dir => `cargo test ${at(dir)}--tests`);
};
/** `run` once in each package directory `depth` segments deep, on that package's files. */
const perPackage = (js: string[], depth: number, run: string) =>
  [...new Set(js.map(p => p.split('/').slice(0, depth).join('/')))]
    .map(
      d =>
        `(cd ${d} && ${run} ${js
          .filter(p => p.startsWith(`${d}/`))
          .map(p => quote(p.slice(d.length + 1)))
          .join(' ')})`
    )
    .join(' && ');
/** The sandbox image with PostgreSQL and Redis; its `services` command starts both. */
const services = 'agentgraph-sandbox:services';
/** The settings token-metadata-api's CI exports for its tests. */
const tokenEnv = [
  'export API_HOST=127.0.0.1 API_PORT=3000 PROMETHEUS_PORT=9154',
  ...['PG', 'BLOCKCHAIN_API_PG'].map(
    p => `${p}HOST=127.0.0.1 ${p}PORT=5432 ${p}USER=postgres ${p}PASSWORD=postgres ${p}DATABASE=postgres`
  ),
  'STACKS_NODE_RPC_HOST=127.0.0.1 STACKS_NODE_RPC_PORT=24440 SNP_REDIS_URL=redis://127.0.0.1:6379',
].join(' ');
/** Rust 1.79 for a lockfile without time 0.3.35 or later, whose older time releases fail to build on newer Rust. */
const oldRust =
  "export RUSTUP_TOOLCHAIN=$(grep -A1 '^name = \"time\"$' Cargo.lock | grep -qE '\"0[.]3[.](3[5-9]|[4-9][0-9])' && echo stable || echo 1.79)";
const pinRust = `${oldRust} && rustup toolchain install $RUSTUP_TOOLCHAIN --profile minimal`;
const npmCi = 'npm ci --no-audit --no-fund --ignore-scripts';
/**
 * The package script whose jest config holds each test file: `test:<dir>` for tests/<dir>/, else `test`. tests/2.5
 * needs a stacks node and bitcoind, which the sandbox lacks. Newer bases test against a client package with its own
 * lockfile.
 */
/**
 * Runs `cmd` once plain and once per `test-clarity-v<n>` feature clar2wasm declares, as its CI matrix does. Tests run
 * 100 proptest cases, as its scheduled CI does, so a property test finds the bug on base every time.
 */
/** Fetches every crate, then builds what compiles, so a test that cannot build fails at score, not in setup. */
const warm = 'cargo fetch && (cargo test --no-run || true)';
const clarityVersions = (cmd: string) =>
  `(for f in "" $(sed -n 's/^\\(test-clarity-v[0-9]*\\) *=.*/\\1/p' clar2wasm/Cargo.toml); do ${cmd.replace('cargo test', 'cargo test ${f:+--features $f}')} || exit 1; done)`;
const blockchainApi = (tests: string[]): Commands => {
  const files = tests.filter(p => /^(src\/)?tests\/.+(\.test|-tests)\.ts$/.test(p) && !p.startsWith('tests/2.5/'));
  const script = (p: string) => (p.startsWith('tests/') ? `test:${p.split('/')[1]}` : 'test');
  const runs = [...new Set(files.map(script))].map(
    s =>
      `npm run ${s} -- --coverage=false --runTestsByPath ${files
        .filter(p => script(p) === s)
        .map(quote)
        .join(' ')}`
  );
  return runs.length
    ? {
        image: services,
        setup: `${npmCi} && if [ -f client/package-lock.json ]; then (cd client && ${npmCi}); fi`,
        test: ['services', ...runs].join(' && '),
      }
    : { hasTests: false };
};

/** Each repo's typecheck and the setup it needs, run on every case whether or not it has hidden tests. */
const typechecks: Record<string, Commands> = {
  explorer: { setup: install('10.28.2'), typecheck: 'node_modules/.bin/tsc --noEmit' },
  'stacks.js': {
    setup: npmCi,
    typecheck: 'npm run typecheck --workspaces --if-present',
  },
  clarinet: { typecheck: 'cargo check --tests' },
};

/** The test command, the typecheck and their setup, from the repo and the test files a merged change touches. */
export const pickBenchTestCommands = (repo: string, tests: string[]): Commands => ({
  ...typechecks[repo.split('/').pop() ?? ''],
  ...tested(repo, tests),
});

const tested = (repo: string, tests: string[]): Commands => {
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
  if (name === 'stacks.js' && js.length) return { setup: npmCi, test: perPackage(js, 2, 'npx jest --runTestsByPath') };
  if (name === 'stacks-blockchain-api') return blockchainApi(tests);
  if (name === 'token-metadata-api' && js.length)
    return {
      image: services,
      setup: npmCi,
      test: `services && ${tokenEnv} && if [ -f jest.config.js ]; then node_modules/.bin/jest --runInBand --runTestsByPath ${files}; else NODE_ENV=test node --import tsx --test --test-concurrency=1 ${files}; fi`,
    };
  if (name === 'api-toolkit' && js.length)
    return { setup: npmCi, test: `node_modules/.bin/jest --runInBand --runTestsByPath ${files}` };
  if (name === 'connect' && js.length)
    return { setup: `${npmCi} && npm run build -w @stacks/connect-ui`, test: perPackage(js, 2, 'npx vitest run') };
  if (name === 'workers' && js.length) return { setup: install('10.33.0'), test: perPackage(js, 2, 'npx vitest run') };
  if (name === 'stacks-mesh-api' && js.length)
    return {
      setup: `${npmCi} && npm run build -w @stacks/mesh-schemas`,
      test: perPackage(js, 2, 'NODE_ENV=test node --test --import tsx --test-timeout 300000'),
    };
  if (name === 'clarity-wasm' || name === 'stacks-core') {
    const test = cargoTests(tests).map(t =>
      name === 'clarity-wasm' && t.includes('clar2wasm/Cargo.toml') ? clarityVersions(t) : t
    );
    const matrix =
      name === 'clarity-wasm'
        ? [`(${clarityVersions('cargo test --no-run --manifest-path clar2wasm/Cargo.toml')} || true)`]
        : [];
    return test.length
      ? {
          image: services,
          toolchain: pinRust,
          setup: [oldRust, warm, ...matrix].join(' && '),
          test: [oldRust, ...(name === 'clarity-wasm' ? ['export PROPTEST_CASES=100'] : []), ...test].join(' && '),
        }
      : { hasTests: false };
  }
  if (name !== 'clarinet') return { hasTests: false };
  const sdk = js.filter(p => p.startsWith('components/clarinet-sdk/'));
  const older = { setup: `(cd components/clarinet-sdk && ${npmCi})`, test: perPackage(sdk, 2, 'npx vitest run') };
  const run = !sdk.length
    ? {}
    : sdk.some(p => p.startsWith('components/clarinet-sdk/node/'))
      ? clarinetSdk(sdk)
      : older;
  const cargo = cargoTests(tests, dir => `-p ${dir.split('/').pop()}`);
  const test = [...(cargo.length ? [oldRust, ...cargo] : []), ...(run.test ? [run.test] : [])];
  const setup = [...(run.setup ? [run.setup] : []), ...(cargo.length ? [oldRust, warm] : [])].join(' && ');
  return test.length
    ? { ...run, ...(cargo.length && { toolchain: pinRust }), ...(setup && { setup }), test: test.join(' && ') }
    : { hasTests: false };
};

const loadCase = (dir: string): Case & Commands => {
  const c = JSON.parse(readFileOrEmpty(join(dir, 'case.json'))) as Omit<Case, 'id' | 'dir' | 'body'> &
    Commands & { tests?: unknown };
  const issue = readFileOrEmpty(join(dir, 'issue.md'));
  return {
    ...(Array.isArray(c.tests) && pickBenchTestCommands(c.repo, c.tests as string[])),
    ...c,
    ...(typeof c.tests === 'string' && !c.test && { test: c.tests }),
    ...(c.bucket === 'no-tests' && { hasTests: false }),
    id: basename(resolve(dir)),
    dir: resolve(dir),
    title: /^# (.+)$/m.exec(issue)?.[1] ?? c.title,
    body: issue.replace(/^# .+\n+/, '').trim(),
  };
};

const keys: Record<string, string> = {};
const agentKey = 'AGENTGRAPH_LLM_API_KEY_';
const isKeyName = (name: string) => name === 'AGENTGRAPH_PROXY_KEYS' || name.startsWith(agentKey);

export const readBenchKeys = (file: string) => {
  const shell = Object.entries(process.env).filter(([name]) => isKeyName(name));
  for (const [name] of shell) delete process.env[name];
  const env = { ...Object.fromEntries(shell), ...(parseEnv(readFileOrEmpty(file)) as Record<string, string>) };
  env.AGENTGRAPH_PROXY_KEYS ??= Object.entries(env)
    .flatMap(([k, v]) =>
      k.startsWith(agentKey) ? [`${k.slice(agentKey.length).toLowerCase().replaceAll('_', '-')}=${v}`] : []
    )
    .join(',');
  return Object.assign(keys, env);
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
  const m = [...readFileOrEmpty(newest ?? '').matchAll(/"primary":\{"used_percent":([\d.]+)/g)].at(-1);
  return m ? Number(m[1]) : undefined;
};

const guard = (out: string, claude: boolean) => {
  const file = join(out, 'budget.json');
  const b = JSON.parse(readFileOrEmpty(file) || '{}') as { start?: number; now?: number; at?: number };
  if (!b.at || Date.now() - b.at > 600_000) {
    const now = codexUsed();
    if (now !== undefined) Object.assign(b, { start: b.start ?? now, now });
    writeFileAtomic(file, { ...b, at: Date.now() });
  }
  if (b.now !== undefined && b.now - (b.start ?? b.now) > limits.codex)
    throw new Error(`Codex weekly use is ${b.now}%, more than ${limits.codex} points over ${b.start}%`);
  const calls = readJsonl(join(out, 'log.jsonl')).filter(
    l => l.event === 'start' && /opus|sonnet/.test(String(l.judge))
  );
  if (claude && calls.length >= limits.claude) throw new Error(`${calls.length} claude judge calls, the limit`);
};

/**
 * Points every agent of a hub at `harness:model`, by the two lines of its front matter. Every agent gets the point's
 * key, else its own, else the implementor's, so an agent a tune adds still has one.
 */
export const repoint = (hub: string, point: string) => {
  const [harness, model] = point.split(':');
  const dir = join(hub, 'agents');
  const names = existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.md')) : [];
  for (const name of names)
    writeFileAtomic(
      join(dir, name),
      readFileOrEmpty(join(dir, name)).replace(/^---\n[\s\S]*?\n---/, head =>
        head
          .replace(/^harness: .*$/m, `harness: ${harness}`)
          .replace(/^model: .*$/m, `model: ${model}`)
          .replace(/^tools:\s*\[([^\]]*)\]/m, (tools, list: string) =>
            harness === 'pi'
              ? `tools: [${list
                  .split(',')
                  .map(tool => tool.trim())
                  .filter(tool => tool && !tool.includes('('))
                  .join(', ')}]`
              : tools
          )
      )
    );
  const key = keys[`AGENTGRAPH_LLM_API_KEY_PT_${point.replace(/\W/g, '_').toUpperCase()}`];
  const own = new Map(
    (keys.AGENTGRAPH_PROXY_KEYS ?? '').split(',').flatMap(kv => {
      const at = kv.indexOf('=');
      return at > 0 ? [[kv.slice(0, at), kv.slice(at + 1)] as const] : [];
    })
  );
  const spare = key ?? own.get('implementor') ?? [...own.values()][0];
  for (const name of names.map(n => basename(n, '.md'))) if (spare && (key || !own.has(name))) own.set(name, spare);
  if (own.size) keys.AGENTGRAPH_PROXY_KEYS = [...own].map(([k, v]) => `${k}=${v}`).join(',');
};

const engineArm = async (c: Case & Commands, arm: string, at: string, repo: string) => {
  const { start } = (await import(join(engine, 'src/main.ts'))) as typeof MainModule;
  if (resolve(engine) !== resolve(agentgraphDir)) Object.assign(process.env, keys);
  const own = process.env.BENCH_HUB ?? `examples/${hubs[c.repo.split('/').pop() ?? ''] ?? 'bench'}`;
  const hub = join(at, 'hub');
  cpSync(resolve(engine, own), hub, { recursive: true });
  if (own === 'examples/bench' && c.runner) {
    writeFileAtomic(
      join(hub, 'scripts/tests.sh'),
      `set -f\nfiles=$(git ls-files -mo --exclude-standard | grep -E '[.](test|spec)[.][jt]sx?$')\n[ -z "$files" ] || ${c.runner} $files\n`
    );
    writeFileAtomic(
      join(hub, 'checks/tests.md'),
      readFileOrEmpty(join(hub, 'checks/tests.md')).replace('npm test', 'sh "$AGENTGRAPH_HUB/scripts/tests.sh"')
    );
    if (c.setup)
      writeFileAtomic(
        join(hub, 'hub.yaml'),
        `setup: ${JSON.stringify(c.setup)}\n${readFileOrEmpty(join(hub, 'hub.yaml'))}`
      );
  }
  if (own === 'examples/bench' && !c.runner) {
    rmSync(join(hub, 'checks'), { recursive: true });
    writeFileAtomic(
      join(hub, 'workflows/issue.md'),
      readFileOrEmpty(join(hub, 'workflows/issue.md')).replace(/^ {4}checks: \[tests\]\n/m, '')
    );
  }
  const raw = readFileOrEmpty(join(hub, 'hub.yaml'));
  if (/^setup: pnpm install/m.test(raw)) writeFileAtomic(join(hub, 'hub.yaml'), raw.replace(/^setup: .*\n/m, ''));
  const limit = (yaml: string, key: string, value: number) =>
    new RegExp(`^ {2}${key}:`, 'm').test(yaml)
      ? yaml.replace(new RegExp(`^( {2}${key}:).*$`, 'm'), `$1 ${value}`)
      : /^limits:/m.test(yaml)
        ? yaml.replace(/^limits:/m, `limits:\n  ${key}: ${value}`)
        : `${yaml}limits:\n  ${key}: ${value}\n`;
  writeFileAtomic(
    join(hub, 'hub.yaml'),
    limit(limit(readFileOrEmpty(join(hub, 'hub.yaml')), 'parallel', 1), 'sessions', 3)
  );
  if (arm === 'floor') {
    rmSync(join(hub, 'workflows'), { recursive: true });
    for (const d of ['agents', 'skills']) rmSync(join(hub, d), { recursive: true, force: true });
    rmSync(join(hub, 'checks'), { recursive: true, force: true });
    cpSync(join(agentgraphDir, 'bench/floor'), hub, { recursive: true });
  }
  if (options.point) repoint(hub, options.point);
  const dir = join(at, 'forge');
  sh('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git')]);
  sh('git', ['-C', repo, 'push', '-q', join(dir, 'origin.git'), `${c.base}:refs/heads/main`]);
  await writeIssueFile(dir, { title: c.title, author: 'maintainer', labels: [] }, c.body.trim());
  await writeComment(dir, 'maintainer', 1, '/agent');
  process.env.AGENTGRAPH_FORGE = dir;
  let answers = 0;
  let status: string | undefined;
  let reason: string | undefined;
  for (let pass = 0; pass < 6; pass++) {
    const [run] = await start({ hub, issue: 1, data: join(at, 'data') }, undefined, keys);
    status = run?.status;
    reason = run?.reason;
    if (!run || run.status === 'done' || run.status === 'stopped') break;
    if (run.status !== 'waiting') continue;
    if (!run.reason || answers) break;
    await writeComment(dir, 'maintainer', 1, answer);
    answers++;
  }
  const origin = join(dir, 'origin.git');
  const pull = readdirSync(dir)
    .map(n => join(dir, n, 'pull.json'))
    .find(existsSync);
  const branch = ['--git-dir', origin, 'rev-parse', '-q', '--verify', 'refs/heads/agentgraph/1'];
  const head = pull
    ? (JSON.parse(readFileOrEmpty(pull)) as { head: string }).head
    : spawnSync('git', branch, { encoding: 'utf8' }).stdout.trim();
  const diff = head ? sh('git', ['--git-dir', origin, 'diff', c.base, head]) : '';
  return { answers, status, ...(reason && { reason: reason.slice(0, 500) }), diff };
};

/** Why an arm attempt broke on its environment, not on the agent: the engine stopped on a runner error. */
export const runnerError = (reason = '') =>
  /runner error|^(SandboxError|SessionStop|ForgeError)\b/.test(reason) ? reason.slice(0, 200) : undefined;

/**
 * Why an arm's run says nothing about the arm, when its environment failed it: a recorded environment failure, a
 * failed setup or a run that never finished. A run that changed nothing is the agent's result, not infra.
 */
export const infra = (s: { infra?: string; setup?: { ok: boolean }; status?: string | undefined }) =>
  (s.infra === 'empty diff' ? undefined : s.infra) ??
  (s.setup?.ok === false ? 'setup fails' : s.status === 'running' ? 'run did not finish' : undefined);

/** The hub an arm of the case starts from: `BENCH_HUB` when set, else the example hub of its repo. */
const hubOf = (c: Pick<Case, 'repo'>) =>
  process.env.BENCH_HUB ?? join(engine, 'examples', hubs[c.repo.split('/').pop() ?? ''] ?? 'bench');

/** Where an arm run is kept: by case, arm, engine, hub (`BENCH_HUB` when set) and commands, and the point and repeat when given. */
export const armSlot = (
  c: Pick<Case & Commands, 'id' | 'base' | 'repo' | 'runner' | 'setup' | 'toolchain'>,
  arm: string,
  {
    point,
    repeat,
    tree = spawnSync('git', ['-C', engine, 'rev-parse', 'HEAD:./src'], { encoding: 'utf8' }).stdout.trim(),
  }: Pick<typeof options, 'point' | 'repeat'> & { tree?: string } = options
) =>
  slot(
    'arm',
    c.id,
    c.base,
    arm,
    tree,
    treeText(hubOf(c)),
    arm === 'floor' ? treeText(join(agentgraphDir, 'bench/floor')) : '',
    c.runner,
    c.setup,
    ...(c.toolchain ? [c.toolchain] : []),
    ...(point || repeat > 1 ? [point ?? '', repeat] : [])
  );

/** Publishes a cached arm at `at` and notes in its `meta.json` which slot it came from. */
export const reuse = (kept: string, at: string) => {
  copyDirIfAbsentAtomic(kept, at);
  writeFileAtomic(join(at, 'meta.json'), {
    ...JSON.parse(readFileOrEmpty(join(at, 'meta.json')) || '{}'),
    reusedFrom: kept,
  });
};

/** The harness's last words when the run's last session ended in an error, as when it cannot reach the proxy. */
export const harnessError = (data: string) => {
  const ends = (existsSync(data) ? readdirSync(data) : [])
    .flatMap(id => readJsonl(join(data, id, 'trace.jsonl')))
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
 * Runs one arm of a case once. Done means `diff.patch` exists, written last. A run that never finished is tried
 * twice, then done as infra; a run that changed nothing is done as the agent's result. A run its environment broke
 * (proxy, docker, a runner error, the machine asleep) waits for the environment and is tried again, and stays undone
 * until it works or fails `patience` times.
 */
const runArm = async (arm: string, caseDir: string, out: string, repo: string) => {
  const c = loadCase(caseDir);
  const at = join(out, c.id, arm);
  if (!benched(c.repo)) throw new Error(`${c.repo} is never benched`);
  if (existsSync(join(at, 'diff.patch'))) return;
  const missing = unpriced(arm, hubOf(c));
  if (missing.length) throw new Error(`no list price for ${missing.join(', ')}: add it to prices.json with its source`);
  if (!keys.AGENTGRAPH_PROXY_KEYS) throw new Error('no model keys: pass --keys <env file>');
  const log = logger(out, { case: c.id, arm });
  if (!claim(at)) return log({ event: 'busy' });
  onStop(signal => {
    log({ event: 'paused', signal });
    removeSandboxContainersMountingDir(at);
    release(at);
  });
  try {
    removeSandboxContainersMountingDir(at);
    if (await prepare(c, out, repo)) return;
    const aside = () => {
      const to = moveDirToAttic(at);
      if (to) log({ event: 'attic', to });
    };
    aside();
    const kept = armSlot(c, arm);
    if (reusable(kept)) return reuse(kept!, at);
    const failed = () =>
      readJsonl(join(out, 'log.jsonl')).filter(l => l.event === 'infra' && l.case === c.id && l.arm === arm);
    for (let attempt = 0, empty = 0; ; attempt++) {
      await waitWhileServicesDown(log, false, net => down(net, { dir: out, ...(cache && { image, volume: cache }) }));
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
      const nothing = ran && infra(meta);
      const env =
        broke ??
        runnerError(ran?.reason) ??
        harnessError(join(at, 'data')) ??
        (nothing || !diff.trim() ? ((await down()) ?? (time.missed() ? 'the machine slept' : undefined)) : undefined);
      writeFileAtomic(join(at, 'meta.json'), {
        ...meta,
        ms: Date.now() - started - time.missed(),
        ...(time.missed() && { slept: time.missed() }),
        ...((env ?? nothing) && { infra: env ?? nothing }),
      });
      if (env) {
        log({ event: 'infra', why: env, attempt });
        if (failed().length < patience) {
          await sleep(Math.min(60_000 * 2 ** attempt, 900_000));
          continue;
        }
      }
      if (!env && nothing && ++empty < 2) continue;
      writeFileAtomic(join(at, 'usage.json'), readArmUsageOverAttempts(at));
      writeFileAtomic(join(at, 'diff.patch'), diff);
      if (!env && !nothing) keep(at, kept);
      return;
    }
  } finally {
    release(at);
  }
};

/** The changed files of a unified diff, each with its part of the diff. */
const splitUnifiedDiffByFile = (diff: string) =>
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
  const changed = splitUnifiedDiffByFile(diff).filter(f => !noise.test(f.path));
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
    overlap: union.size ? getRounded(mine.filter(p => human.includes(p)).length / union.size) : 1,
  };
};
let image = Effect.runSync(hostSettings.image);

/** The id of the image a tag names now, so a bench keeps one sandbox even when the tag moves or goes. */
const imageId = (tag: string) =>
  spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], { encoding: 'utf8' }).stdout?.trim() ||
  undefined;
const cache = process.env.AGENTGRAPH_CACHE_VOLUME ?? 'agentgraph-cache';
const scoreSize = { memory: '8g', cpus: '4', pids: '2048' };

/** One score command in its own container on the tree at `/work`, with no network unless `open`. */
const exec = (
  cmd: string,
  tree: string,
  box: CheckoutContainerSpec,
  from: string,
  network: 'none' | 'open' = 'none'
) => {
  const started = Date.now();
  const name = `agentgraph-score-${randomBytes(6).toString('hex')}`;
  const c = { cmd: 'sh', args: ['-c', cmd], dir: tree, env: { NODE_OPTIONS: '' }, network, minutes: 60 };
  const r = spawnSync('docker', dockerArgs(c, from, name, box, cache, scoreSize), {
    encoding: 'utf8',
    timeout: 3_600_000,
    maxBuffer: 1 << 28,
  });
  if (r.error) spawnSync('docker', ['rm', '-f', name]);
  if (r.error) throw new Error(`infra: score container did not finish: ${r.error.message}`);
  if (
    r.status === 125 ||
    /Cannot connect to the Docker daemon|^docker: Error response from daemon/m.test(r.stderr ?? '')
  )
    throw new Error(`docker could not start a score container: ${r.stderr.slice(-2000)}`);
  return { ok: r.status === 0, ms: Date.now() - started, tail: `${r.stdout}${r.stderr}`.slice(-8000) };
};

const coupled =
  /Cannot find module|Failed to resolve import|is not a function|is not exported|does not provide an export|No matching export|is not defined|is not a constructor|TS\d{4}|Cannot destructure|Cannot read propert/i;

/** Passed and total counts a jest, vitest, cargo or node test run printed last. */
const counts = (tail = '') => {
  const text = stripVTControlCharacters(tail);
  const cargo = [...text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)];
  if (cargo.length)
    return cargo.reduce((n, m) => ({ passed: n.passed + +m[1]!, total: n.total + +m[1]! + +m[2]! }), {
      passed: 0,
      total: 0,
    });
  const line = text.match(/^\s*Tests:?\s+.*$/gm)?.at(-1) ?? '';
  const total = /(\d+) total|\((\d+)\)/.exec(line);
  if (total) return { passed: +(/(\d+) passed/.exec(line)?.[1] ?? 0), total: +(total[1] ?? total[2]!) };
  const [pass, fail] = [/^# pass (\d+)/m.exec(text), /^# fail (\d+)/m.exec(text)];
  return pass && fail ? { passed: +pass[1]!, total: +pass[1]! + +fail[1]! } : undefined;
};

type Run = { ok: boolean; tail?: string };

/** The share of the hidden tests base fails that a run passes; pass or fail when the run printed no counts. */
export const hiddenShare = (run?: Run, base?: Run) => {
  if (!run) return undefined;
  const [r, b] = [counts(run.tail), base && counts(base.tail)];
  if (run.ok || !r) return +run.ok;
  const fixed = b?.total === r.total ? b.passed : 0;
  return r.total > fixed ? getRounded(Math.max(0, r.passed - fixed) / (r.total - fixed)) : 0;
};

/** Whether a failed hidden run broke on the human's names and signatures (coupled) or on a result (behaviour). */
export const failureClass = (tail: string) => (coupled.test(tail) ? 'coupled' : 'behaviour');

/**
 * Scores a diff in the case's sandbox setup: setup runs again only when the diff touches a manifest or the sandbox setup could not hold
 * everything setup made, else only `build`, and nothing for an empty diff. Hidden tests reach the tree after the sandbox setup exists.
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
  if (cache) await ensureFreeDisk({ dir: tree, image: start, volume: cache });
  const env = cache
    ? await readSandboxSetup({
        repo: c.repo,
        image: start,
        git,
        base: c.base,
        cache,
        ...(c.setup && { setup: c.setup }),
        ...(c.toolchain && { toolchain: c.toolchain }),
      })
    : undefined;
  const sharedMounts = cache
    ? await createSharedMounts(
        env ?? { image: start, outputs: [] },
        randomBytes(6).toString('hex'),
        tree,
        await dependencyDirs(git, c.base),
        cache
      )
    : [];
  const box = { mounts: [{ src: git, dst: git, readonly: true }], sharedMounts };
  const from = env?.image ?? start;
  const scored = () => {
    const again = !env?.complete || splitUnifiedDiffByFile(diff).some(f => manifest.test(f.path));
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
    const relaxed = readFileOrEmpty(join(c.dir, 'hidden.relaxed.diff'));
    if (relaxed && spawnSync('git', ['-C', tree, 'apply', '-'], { input: relaxed }).status)
      throw new Error(`${c.id}: hidden.relaxed.diff does not apply to the hidden tests`);
    const run = exec(c.test, tree, box, from);
    return { ...result, hidden: run.ok ? run : { ...run, class: failureClass(run.tail) } };
  };
  try {
    const result = scored();
    const writes = await written(sharedMounts, from);
    return { ...result, ...(writes !== undefined && { cache: writes }) };
  } finally {
    await discard(sharedMounts);
  }
};
/**
 * Sessions, reported cost and tokens by model of an arm's traces; input counts only uncached tokens. `split` is session,
 * tool, hub setup and check time in ms; sessions running at once each count.
 */
const effort = (data: string) => {
  const traces = existsSync(data) ? readdirSync(data).flatMap(id => readJsonl(join(data, id, 'trace.jsonl'))) : [];
  const sessions = traces.flatMap(t => (t.session ? [t.session as { usd: number }] : []));
  const models: Record<string, string> = {};
  const tokens: Record<string, { input: number; cacheRead: number; cacheWrite: number; output: number }> = {};
  const split = { agent: 0, tools: 0, setup: 0, checks: 0 };
  const opened: Record<string, number> = {};
  for (const t of traces) {
    const e = (t.event ?? {}) as Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'ms', number>> & {
      type?: string;
      model?: string;
    };
    const key = String(t.key);
    split.setup += (t.setup as { ms?: number } | undefined)?.ms ?? 0;
    split.checks += (t.check as { ms?: number } | undefined)?.ms ?? 0;
    if (e.type === 'tool') split.tools += e.ms ?? 0;
    const when = Date.parse(String(t.at));
    if (e.type === 'start') opened[key] = when;
    if (t.session && Number.isFinite(when - opened[key]!)) split.agent += when - opened[key]!;
    if (e.type === 'start' && e.model) models[key] = e.model;
    if (e.type !== 'usage') continue;
    const [read, write] = [e.cacheRead ?? 0, e.cacheWrite ?? 0];
    const sum = (tokens[models[key] ?? 'unknown'] ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
    sum.input += (e.input ?? 0) - read - write;
    sum.cacheRead += read;
    sum.cacheWrite += write;
    sum.output += e.output ?? 0;
  }
  return { sessions: sessions.length, usd: getRounded(sessions.reduce((a, s) => a + s.usd, 0)), tokens, split };
};

/** The earlier attempts of the arm at `at`: older `<arm>.<ms>` dirs beside it and `.attic/<arm>-<time>` dirs. */
const earlier = (at: string) => {
  const within = (dir: string, name: RegExp) =>
    existsSync(dir) ? readdirSync(dir).flatMap(n => (name.test(n) ? [join(dir, n)] : [])) : [];
  return [
    ...within(dirname(at), new RegExp(`^${basename(at)}\\.\\d+$`)),
    ...within(join(dirname(at), '.attic'), new RegExp(`^${basename(at)}-\\d{4}-`)),
  ];
};

/** Wall time of one attempt: its `meta.json` ms, else the span of its traces. */
const took = (dir: string) => {
  const ms = (JSON.parse(readFileOrEmpty(join(dir, 'meta.json')) || '{}') as { ms?: number }).ms;
  if (typeof ms === 'number') return ms;
  const data = join(dir, 'data');
  const at = (existsSync(data) ? readdirSync(data) : [])
    .flatMap(id => readJsonl(join(data, id, 'trace.jsonl')))
    .flatMap(t => (typeof t.at === 'string' ? [Date.parse(t.at)] : []));
  return at.length ? Math.max(...at) - Math.min(...at) : 0;
};

/** Sessions, cost, tokens and wall time summed over every attempt of an arm, with each attempt's own numbers. */
export const readArmUsageOverAttempts = (at: string) => {
  const attempts = [...earlier(at), ...(existsSync(at) ? [at] : [])].map(dir => {
    const { infra } = JSON.parse(readFileOrEmpty(join(dir, 'meta.json')) || '{}') as { infra?: string };
    return { dir: relative(dirname(at), dir), ms: took(dir), ...(infra && { infra }), ...effort(join(dir, 'data')) };
  });
  const tokens: ReturnType<typeof effort>['tokens'] = {};
  for (const a of attempts)
    for (const [model, t] of Object.entries(a.tokens)) {
      const sum = (tokens[model] ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
      for (const k of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) sum[k] += t[k];
    }
  const total = (k: 'sessions' | 'usd' | 'ms') => getRounded(attempts.reduce((n, a) => n + a[k], 0));
  const part = (k: keyof ReturnType<typeof effort>['split']) => attempts.reduce((n, a) => n + a.split[k], 0);
  const split = {
    agent: part('agent'),
    tools: part('tools'),
    setup: part('setup'),
    checks: part('checks'),
    infra: attempts.reduce((n, a) => n + (a.infra ? a.ms : 0), 0),
  };
  return { sessions: total('sessions'), usd: total('usd'), ms: total('ms'), tokens, split, attempts };
};

/** An arm's usage over all its attempts: recounted from its records when they are here, else its `usage.json`. */
const usage = (at: string): Partial<ReturnType<typeof readArmUsageOverAttempts>> =>
  existsSync(join(at, 'data')) || earlier(at).length
    ? readArmUsageOverAttempts(at)
    : (JSON.parse(readFileOrEmpty(join(at, 'usage.json')) || '{}') as Partial<
        ReturnType<typeof readArmUsageOverAttempts>
      >);

/** Writes an arm's usage beside it, then copies it to `kept` without its data, forge, hub or attic dirs. */
export const keep = (at: string, kept: string | undefined) => {
  if (!existsSync(join(at, 'usage.json'))) writeFileAtomic(join(at, 'usage.json'), readArmUsageOverAttempts(at));
  if (kept) copyDirIfAbsentAtomic(at, kept, p => !/\/(data|forge|hub|\.attic)$/.test(p));
};

const scoreArms = async (c: Case & Commands, out: string, repo: string, which: string[]) => {
  const root = join(out, c.id);
  const merged = readFileOrEmpty(join(c.dir, 'merged.diff'));
  if (!existsSync(join(root, 'human/diff.patch'))) writeFileAtomic(join(root, 'human/diff.patch'), merged);
  if (!existsSync(join(root, 'base/diff.patch'))) writeFileAtomic(join(root, 'base/diff.patch'), '');
  writeFileAtomic(join(root, 'case.json'), readFileOrEmpty(join(c.dir, 'case.json')));
  const human = splitUnifiedDiffByFile(merged).map(f => f.path);
  const hidden = human.filter(p => testPath.test(p) && !noise.test(p));
  const tree = join(root, 'tree');
  while (!claim(tree)) await sleep(5000);
  try {
    if (!existsSync(tree)) sh('git', ['clone', '-q', '--shared', '--no-checkout', resolve(repo), tree]);
    for (const arm of which) {
      const at = join(root, arm);
      if (!existsSync(join(at, 'diff.patch')) || existsSync(join(at, 'score.json'))) continue;
      const diff = readFileOrEmpty(join(at, 'diff.patch'));
      const meta = JSON.parse(readFileOrEmpty(join(at, 'meta.json')) || '{}') as { answers?: number; ms?: number };
      const tests = await step(out, { step: 'score', case: c.id, arm }, () =>
        c.test || c.suite || c.typecheck ? check(c, tree, diff, c.hasTests === false ? [] : hidden, resolve(repo)) : {}
      );
      const offline = (tests as Tests).setup?.ok === false && (await down(true));
      if (offline) throw new Error(`infra: setup failed while ${offline}, ${c.id}/${arm} stays unscored`);
      writeFileAtomic(join(at, 'score.json'), { ...tests, ...stats(diff, human), ...meta, ...usage(at) });
    }
  } finally {
    rmSync(tree, { recursive: true, force: true });
    release(tree);
  }
};

/** Removes the scoring trees under `out`, nested runs included, that no live process holds. */
const reapTrees = (out: string) => {
  for (const tree of findBuildDirs(out))
    if (basename(tree) === 'tree' && !isLockedByOtherProcess(tree)) rmSync(tree, { recursive: true, force: true });
};

type Tests = {
  applied?: boolean;
  setup?: { ok: boolean };
  suite?: { ok: boolean };
  typecheck?: { ok: boolean };
  hidden?: { ok: boolean };
};

/** Why a case cannot tell arms apart, when it cannot: the hidden tests must fail on base and pass on the human. */
export const invalid = (base: Tests, human: Tests, tested = false) => {
  if (human.applied === false) return 'the human diff does not apply to base';
  if (base.setup?.ok === false || human.setup?.ok === false) return 'setup fails';
  if (!base.hidden || !human.hidden)
    return tested ? 'no hidden tests run' : human.typecheck?.ok === false ? 'the human fails the typecheck' : undefined;
  if (base.hidden.ok) return 'base already passes the hidden tests';
  if (!human.hidden.ok) return 'the human fails the hidden tests';
  if (human.suite?.ok === false) return 'the human fails the suite';
  if (human.typecheck?.ok === false && base.typecheck?.ok !== false) return 'the human fails the typecheck';
  return undefined;
};

/** The base commit's file list, a file's text, and whether a word occurs anywhere in it. */
type Base = { files: string[]; text: (path: string) => string; has: (word: string) => boolean };

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
  const parts = splitUnifiedDiffByFile(diff).filter(f => !noise.test(f.path));
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
const scorer = () =>
  (tools ??= hash(
    [check, invalid, exec, image].join('\0') +
      spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8' }).stdout
  ));

const prepare = async (c: Case & Commands, out: string, repo: string) => {
  const file = join(out, c.id, 'valid.json');
  if (!existsSync(file) && !existsSync(join(c.dir, 'hidden.relaxed.diff'))) {
    const coupled = couplings(
      readFileOrEmpty(join(c.dir, 'merged.diff')),
      `${c.title}\n${c.body}`,
      baseOf(repo, c.base)
    );
    if (coupled.length) writeFileAtomic(file, { invalid: 'coupled', coupled });
  }
  const kept = slot(
    'valid',
    c.id,
    c.base,
    c.merged,
    c.runner,
    c.setup,
    c.test,
    ...(c.toolchain ? [c.toolchain] : []),
    ...[readFileOrEmpty(join(c.dir, 'hidden.relaxed.diff'))].filter(Boolean),
    ...(c.image ? [c.image] : []),
    ...(c.typecheck ? [c.typecheck] : []),
    scorer()
  );
  if (!existsSync(file) && reusable(kept)) {
    cpSync(kept!, join(out, c.id), { recursive: true, filter: p => !p.endsWith('/valid.json') });
    writeFileAtomic(file, readFileOrEmpty(join(kept!, 'valid.json')));
  }
  if (!existsSync(file)) {
    await scoreArms(c, out, repo, ['base', 'human']);
    const tests = (arm: string) => JSON.parse(readFileOrEmpty(join(out, c.id, arm, 'score.json')) || '{}') as Tests;
    const why = invalid(tests('base'), tests('human'), c.bucket === 'tests' || Boolean(c.test));
    writeFileAtomic(file, { invalid: why });
    if (kept && why !== 'setup fails')
      copyDirIfAbsentAtomic(
        join(out, c.id),
        kept,
        p => !/\/(tree|v2|floor|judge|\.attic)$/.test(p) && !p.endsWith('.lock')
      );
  }
  return (JSON.parse(readFileOrEmpty(file)) as { invalid?: string }).invalid;
};

/** Removes the sandbox setup images a case's scores ran in and their dependency volumes; docker keeps one a container still uses. */
const dropEnvs = (root: string) => {
  const used = readdirSync(root).flatMap(arm => {
    const env = (JSON.parse(readFileOrEmpty(join(root, arm, 'score.json')) || '{}') as { env?: string }).env;
    return env ? [env] : [];
  });
  for (const image of new Set(used)) spawnSync('docker', ['rmi', image], { stdio: 'ignore' });
};

const score = async (caseDir: string, out: string, repo: string, drop = false) => {
  const c = loadCase(caseDir);
  if (!(await prepare(c, out, repo))) await scoreArms(c, out, repo, bots);
  if (drop && existsSync(join(out, c.id))) dropEnvs(join(out, c.id));
  if (cache) await collect();
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
  for (const { path, part } of splitUnifiedDiffByFile(diff))
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

/** A diff for a judge: no lockfiles, changelogs, build info, git hooks or changesets, no index lines, issue numbers and the given names masked. */
export const scrub = (text: string, names: string[] = []) => {
  const who = new RegExp(`\\b(${['agentgraph', ...names.filter(n => /^[\w-]+$/.test(n))].join('|')})\\b`, 'gi');
  const kept = text.startsWith('diff --git')
    ? splitUnifiedDiffByFile(text)
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
export const parseBenchJudgeVerdict = (text: string): Verdict | undefined => {
  try {
    const v = JSON.parse([...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1] ?? '') as Verdict;
    return ['A', 'B', 'tie'].includes(v.prefer) ? v : undefined;
  } catch {
    return undefined;
  }
};

type Tokens = ReturnType<typeof effort>['tokens'][string];
type Answer = { text: string; tokens?: Tokens; usd?: number };

/** A judge's reply with its tokens and cost when reported, from claude's JSON output or a chat completion. */
export const parseBenchJudgeResponse = (raw: unknown): Answer => {
  let r = raw as {
    result?: string;
    total_cost_usd?: number;
    usage?: Partial<Record<string, number>> & { prompt_tokens_details?: { cached_tokens?: number } };
    choices?: { message: { content: string } }[];
  };
  if (typeof raw === 'string')
    try {
      r = JSON.parse(raw) as typeof r;
    } catch {
      return { text: raw };
    }
  const u = r.usage;
  if (typeof r.result === 'string')
    return {
      text: r.result,
      ...(u && {
        tokens: {
          input: u.input_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
          output: u.output_tokens ?? 0,
        },
      }),
      ...(r.total_cost_usd !== undefined && { usd: r.total_cost_usd }),
    };
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    text: r.choices?.[0]?.message.content ?? '',
    ...(u && {
      tokens: {
        input: (u.prompt_tokens ?? 0) - cached,
        cacheRead: cached,
        cacheWrite: 0,
        output: u.completion_tokens ?? 0,
      },
    }),
  };
};

const claude = (model: string) => (prompt: string, cwd: string) =>
  new Promise<Answer>((done, fail) => {
    const args = ['-p', '--model', model, '--tools', '', '--no-session-persistence', '--output-format', 'json'];
    const child = execFile('claude', args, { cwd, maxBuffer: 1 << 26, timeout: 1_800_000 }, (e, out) =>
      e ? fail(e) : done(parseBenchJudgeResponse(out))
    );
    child.stdin?.end(prompt);
  });
const proxied = (model: string) => async (prompt: string) => {
  const r = await fetch('http://127.0.0.1:4000/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${keys.AGENTGRAPH_LLM_API_KEY_REVIEWER}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
  });
  return parseBenchJudgeResponse(await r.json());
};
const judges: Record<string, (prompt: string, cwd: string) => Promise<Answer>> = {
  opus: claude('opus'),
  sonnet: claude('sonnet'),
  sol: proxied('smart'),
  gemini: proxied('gemini'),
};
const judgeModels: Record<string, string> = {
  opus: 'claude-opus',
  sonnet: 'claude-sonnet',
  sol: 'smart',
  gemini: 'gemini',
};
const priceTable = JSON.parse(readFileOrEmpty(join(agentgraphDir, 'infra/local/prices.json')) || '{}') as Prices;
const upstream = priceTable.aliases;

/** The models an arm's agents run on, at `point` when given, that the engine's price table has no list price for. */
export const unpriced = (arm: string, hub: string, point = options.point) => {
  const dir = join(arm === 'floor' ? join(agentgraphDir, 'bench/floor') : hub, 'agents');
  const named = (existsSync(dir) ? readdirSync(dir) : [])
    .filter(n => n.endsWith('.md'))
    .map(n => /^model: *(\S+)/m.exec(readFileOrEmpty(join(dir, n)))?.[1] ?? 'default');
  const prices = JSON.parse(
    readFileOrEmpty(process.env.AGENTGRAPH_PRICES ?? join(engine, 'infra/local/prices.json')) || '{}'
  ) as Prices;
  return [...new Set(point ? [point.split(':')[1]!] : named)].filter(m => !getModelPrice(prices, [m]));
};

/**
 * What an arm's usage cost and where the number comes from: recorded by the run, else its tokens at today's list
 * price. A subscription's cost is a list-price estimate either way.
 */
export const getBenchUsageCost = (
  u: { usd?: number; tokens?: ReturnType<typeof effort>['tokens'] },
  harness = '',
  prices = priceTable
) => {
  const models = Object.keys(u.tokens ?? {});
  const sub = (m: string) => (prices.subscriptions ?? []).some(p => (prices.aliases?.[m] ?? m).startsWith(p));
  const estimate = harness === 'claude-sub' || models.some(sub);
  if (u.usd || !models.length)
    return { usd: u.usd ?? 0, usdSource: estimate ? 'list-price estimate' : 'recorded' } as const;
  const listed = models.map(m => [getModelPrice(prices, [m]), u.tokens![m]!] as const);
  if (listed.some(([p]) => !p)) return { usd: 0, usdSource: 'unpriced' } as const;
  const usd = listed.reduce(
    (sum, [p, t]) =>
      sum +
      (t.input * p!.input +
        t.cacheRead * (p!.cached ?? p!.input) +
        t.cacheWrite * (p!.cacheWrite ?? p!.input) +
        t.output * p!.output) /
        1e6,
    0
  );
  return { usd: getRounded(usd), usdSource: estimate ? 'list-price estimate' : 'list price' } as const;
};

/** The maker of a proxy alias or model, from its upstream name: openai, anthropic, google, z-ai, x-ai and so on. */
export const getModelMakerFromUpstreamName = (model: string, aliases = upstream ?? {}) => {
  const name = (aliases[model] ?? model).replace(/^openrouter\//, '');
  if (/^(chatgpt|openai)\/|^gpt-/.test(name)) return 'openai';
  if (/^(anthropic\/)?claude/.test(name)) return 'anthropic';
  return name.includes('/') ? name.split('/')[0]! : name;
};

/** The panel with each judge of the contestant's family swapped for the first of sol, gemini, opus from another one. */
export const makeCrossMakerJudgePanel = (
  chosen: Record<string, number>,
  contestant: string,
  aliases = upstream ?? {}
) => {
  const own = getModelMakerFromUpstreamName(contestant, aliases);
  const other = (name: string) => getModelMakerFromUpstreamName(judgeModels[name]!, aliases) !== own;
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
  if ((JSON.parse(readFileOrEmpty(join(root, 'valid.json')) || '{}') as { invalid?: string }).invalid) return;
  const names = [c.author ?? '', c.repo.split('/')[0] ?? ''];
  const human = readFileOrEmpty(join(root, 'human/diff.patch'));
  if (c.control) {
    const changed = c.control === 'bug' ? plant(human) : pad(human);
    if (!changed) throw new Error(`${c.id}: no comparison to flip in the human diff`);
    writeFileAtomic(join(root, 'control/diff.patch'), changed);
  }
  const have = c.control
    ? ['human', 'control']
    : arms.filter(a => a !== 'control' && readFileOrEmpty(join(root, a, 'diff.patch')).trim());
  const block = (label: string, arm: string) =>
    `## Candidate ${label}\n\n\`\`\`diff\n${scrub(readFileOrEmpty(join(root, arm, 'diff.patch')), names)}\n\`\`\``;
  const issue = scrub(`# ${c.title}\n\n${c.body}`, names);
  for (const [i, x] of have.entries())
    for (const y of have.slice(i + 1).filter(y => options.pairs === 'all' || x === 'human' || y === 'human'))
      for (const [at, [a, b]] of (
        [
          [x, y],
          [y, x],
        ] as const
      ).entries()) {
        const prompt = `${readFileOrEmpty(join(agentgraphDir, 'bench/judge.md'))}\n## Issue\n\n${issue}\n\n${block('A', a)}\n\n${block('B', b)}\n`;
        const dir = join(root, 'judge', `${a}-${b}`);
        writeFileAtomic(join(dir, 'prompt.md'), prompt);
        await Promise.all(
          Object.entries(makeCrossMakerJudgePanel(panel, options.point?.split(':')[1] ?? 'smart'))
            .filter(([, n]) => orders(n, `${c.id}/${x}-${y}`).includes(at))
            .map(async ([name]) => {
              const ask = judges[name]!;
              const kept = slot('judge', name, prompt);
              for (let attempt = 0; attempt < 3 && !existsSync(join(dir, `${name}.json`)); attempt++) {
                const hit = reusable(kept);
                if (!hit) guard(out, getModelMakerFromUpstreamName(judgeModels[name]!) === 'anthropic');
                const started = Date.now();
                const got: Answer = hit
                  ? { text: readFileOrEmpty(kept!) }
                  : await step(out, { step: 'judge', case: c.id, pair: `${a}-${b}`, judge: name }, () =>
                      ask(prompt, tmpdir())
                    ).catch(() => ({ text: '' }));
                const raw = got.text;
                writeFileAtomic(join(dir, `${name}.${attempt}.raw.md`), raw);
                if (!hit) {
                  const tokens = got.tokens && { [judgeModels[name]!]: got.tokens };
                  const cost = { ms: Date.now() - started, ...(tokens && { tokens }) };
                  writeFileAtomic(join(dir, `${name}.${attempt}.cost.json`), {
                    ...cost,
                    ...getBenchUsageCost(
                      { ...cost, ...(got.usd !== undefined && { usd: got.usd }) },
                      getModelMakerFromUpstreamName(judgeModels[name]!) === 'anthropic' ? 'claude-sub' : ''
                    ),
                  });
                }
                const v = parseBenchJudgeVerdict(raw);
                if (v) writeFileAtomic(join(dir, `${name}.json`), { judge: name, order: [a, b], ...v });
                if (v && kept && !hit) writeFileAtomic(kept, raw);
              }
            })
        );
      }
};

/** The 95% interval of the mean of `xs` over resampled sets of the same size. */
export const bootstrap = (xs: number[], n = 2000): [number, number] => {
  const means = Array.from({ length: n }, () => getMean(xs.map(() => xs[Math.floor(Math.random() * xs.length)]!)));
  means.sort((a, b) => a - b);
  return [getRounded(means[Math.floor(n * 0.025)]!), getRounded(means[Math.floor(n * 0.975)]!)];
};

const metrics = (s: Record<string, unknown>): Record<string, number> =>
  Object.fromEntries(
    Object.entries(s).flatMap(([k, v]): [string, number][] => {
      if (k === 'ms' && typeof v === 'number') return [['min', getRounded(v / 60_000)]];
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
  const c = JSON.parse(readFileOrEmpty(join(out, id, 'case.json')) || '{}') as Record<string, unknown>;
  const strata = Object.fromEntries(
    strataKeys.flatMap(k => (c[k] === undefined || typeof c[k] === 'object' ? [] : [[k, String(c[k])]]))
  );
  if (c.repo) strata.issue = Array.isArray(c.flags) && c.flags.includes('no-issue-pr-body') ? 'pr-body' : 'issue';
  const scores = Object.fromEntries(
    ['base', ...arms].flatMap(arm => {
      const s = readFileOrEmpty(join(out, id, arm, 'score.json'));
      return s ? [[arm, JSON.parse(s) as Record<string, unknown>]] : [];
    })
  );
  if (scores.human) strata.tests = scores.human.hidden ? 'hidden' : 'judge-only';
  const skipped = Object.fromEntries(
    bots.flatMap(arm => {
      const reason = scores[arm] && infra(scores[arm]);
      return reason ? [[arm, reason]] : [];
    })
  );
  const rows = Object.entries(scores)
    .filter(([arm]) => !(arm in skipped))
    .map(([arm, s]): [string, Record<string, number>] => {
      const u = { ...s, ...usage(join(out, id, arm)) };
      return [arm, metrics({ ...u, usd: getBenchUsageCost(u).usd })];
    });
  const failures = bots.flatMap(arm => {
    const h = (scores[arm] as { hidden?: { ok: boolean; tail: string; class?: string } } | undefined)?.hidden;
    return h && !h.ok && !(arm in skipped) ? [`${id}/${arm}: ${h.class ?? failureClass(h.tail)}`] : [];
  });
  const judged = join(out, id, 'judge');
  const verdicts = (existsSync(judged) ? readdirSync(judged) : [])
    .flatMap(pair =>
      readdirSync(join(judged, pair))
        .filter(f => /^\w+\.json$/.test(f))
        .map(f => JSON.parse(readFileOrEmpty(join(judged, pair, f))) as Judged)
    )
    .filter(v => !v.order.some(arm => arm in skipped));
  const { invalid } = JSON.parse(readFileOrEmpty(join(out, id, 'valid.json')) || '{}') as { invalid?: string };
  return { id, ...(invalid && { invalid }), infra: skipped, strata, rows, failures, verdicts };
};

/**
 * One row per case and arm run of an out dir, keyed by its point. A dir without `point.json` reads as opencode:smart,
 * repeat 1, engine unknown, with the dir name as its set.
 */
export const readBenchRows = (out: string, repos?: string[]) => {
  const p = {
    harness: 'opencode',
    model: 'smart',
    engine: 'unknown',
    set: basename(resolve(out)),
    repeat: 1,
    hubs: {} as Record<string, string>,
    ...(JSON.parse(readFileOrEmpty(join(out, 'point.json')) || '{}') as object),
  };
  const ok = (v: unknown) => (v && typeof v === 'object' && 'ok' in v ? (+Boolean(v.ok) as 0 | 1) : undefined);
  return readdirSync(out)
    .filter(id => existsSync(join(out, id, 'human')))
    .map(id => loadScored(out, id))
    .filter(c => !c.invalid && benched(c.strata.repo) && (!repos || repos.includes(c.strata.repo ?? '')))
    .flatMap(c => {
      const base = JSON.parse(readFileOrEmpty(join(out, c.id, 'base', 'score.json')) || '{}') as Record<
        string,
        unknown
      >;
      return ['human', ...bots].flatMap(arm => {
        const s = JSON.parse(readFileOrEmpty(join(out, c.id, arm, 'score.json')) || 'null') as Record<
          string,
          unknown
        > | null;
        if (!s) return [];
        const seen = c.verdicts.filter(v => v.order.includes(arm));
        const byJudge: Record<string, number[]> = {};
        for (const v of seen.filter(v => arm !== 'human' && v.order.includes('human')))
          (byJudge[v.judge] ??= []).push(v.prefer === 'tie' ? 0.5 : +(v.order[+(v.prefer === 'B')] === arm));
        const found = (severity: string) =>
          seen.length
            ? getMean(
                seen.map(
                  v => (v[v.order[0] === arm ? 'A' : 'B']?.findings ?? []).filter(f => f.severity === severity).length
                )
              )
            : 0;
        const spent = { ...s, ...usage(join(out, c.id, arm)) };
        const [hidden, typecheck] = [ok(s.hidden), ok(s.typecheck)];
        const suite = ok(base.suite) === 0 ? undefined : ok(s.suite);
        const share = hiddenShare(s.hidden as Run | undefined, base.hidden as Run | undefined);
        return [
          {
            point: `${p.harness}:${p.model}/${arm}@${p.engine}/${p.hubs[arm] ?? ''}/${p.set}`,
            case: c.id,
            repeat: p.repeat,
            strata: c.strata,
            ...(c.infra[arm] && { infra: c.infra[arm] }),
            ...(!c.infra[arm] && arm !== 'human' && s.files === 0 && { outcome: 'no-change' as const }),
            ...(hidden !== undefined && { hidden }),
            ...(share !== undefined && { hiddenShare: share }),
            ...(suite !== undefined && { suite }),
            ...(typecheck !== undefined && { typecheck }),
            vsHuman: Object.fromEntries(Object.entries(byJudge).map(([j, ps]) => [j, getMean(ps)])),
            findings: { critical: found('critical'), high: found('high') },
            answers: Number(s.answers ?? 0),
            minutes: Number(spent.ms ?? 0) / 60_000,
            tokens: spent.tokens ?? {},
            ...(spent.split && { split: spent.split }),
            ...getBenchUsageCost(spent, p.harness),
          },
        ];
      });
    });
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
      (wins[pair] ??= []).push(getMean(Object.values(byJudge).flat()));
      const calls = Object.values(byJudge).map(ps => (ps.every(p => p === ps[0]) ? ps[0] : 0.5));
      agreed.push(calls.length > 1 && calls.every(p => p === calls[0]));
    }
  }
  const winRows: [string, Record<string, number | string>][] = Object.entries(wins).map(([pair, ws]) => [
    pair,
    { cases: ws.length, 'first wins': getRounded(getMean(ws)), '95% CI': bootstrap(ws).join(' to ') },
  ]);
  const means: [string, Record<string, number>][] = Object.entries(perArm).map(([arm, rs]) => [
    arm,
    Object.fromEntries(
      [...new Set(rs.flatMap(Object.keys))].map(k => [k, getRounded(getMean(rs.flatMap(r => (k in r ? [r[k]!] : []))))])
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

/** Calls, cost and minutes of every judge call under `out`, cached ones left out. */
const judging = (out: string, ids: string[]) => {
  const calls = ids.flatMap(id => {
    const dir = join(out, id, 'judge');
    return (existsSync(dir) ? readdirSync(dir) : []).flatMap(pair =>
      readdirSync(join(dir, pair))
        .filter(f => f.endsWith('.cost.json'))
        .map(f => JSON.parse(readFileOrEmpty(join(dir, pair, f))) as { ms: number; usd: number })
    );
  });
  const sum = (k: 'ms' | 'usd') => calls.reduce((n, c) => n + (c[k] ?? 0), 0);
  return calls.length
    ? [`Judges: ${calls.length} calls, $${getRounded(sum('usd'))}, ${Math.round(sum('ms') / 60_000)} min.`, '']
    : [];
};

const headline = (cases: Scored[], valid: Scored[]) => {
  const infras = valid.flatMap(c => Object.entries(c.infra).map(([arm, why]) => `${c.id}/${arm}: ${why}`));
  const invalids = cases.flatMap(c => (c.invalid ? [`${c.id}: ${c.invalid}`] : []));
  const rate = ([arm, passes]: [string, number[]]): [string, Record<string, number>] => [
    arm,
    { passed: passes.reduce((a, p) => a + p, 0), of: passes.length, rate: getRounded(getMean(passes)) },
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
  const json = (path: string) => JSON.parse(readFileOrEmpty(path) || '{}') as Record<string, unknown>;
  const state = (u: Unit) => {
    const at = join(u.out, u.case, u.arm);
    if (existsSync(join(at, 'diff.patch'))) return json(join(at, 'meta.json')).infra ? 'infra' : 'done';
    if (json(join(u.out, u.case, 'valid.json')).invalid) return 'invalid';
    return isLockedByOtherProcess(at) ? 'running' : 'left';
  };
  const states = units.map(u => ({ ...u, state: state(u) }));
  const count = (k: string) => states.filter(u => u.state === k).length;
  const logs = [...new Set(units.map(u => u.out))].flatMap(out => readJsonl(join(out, 'log.jsonl')));
  logs.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const last = logs.filter(l => ['wait', 'resume', 'start', 'end', 'paused'].includes(String(l.event))).at(-1);
  const ms = states.flatMap(u =>
    u.state === 'done' ? [Number(json(join(u.out, u.case, u.arm, 'meta.json')).ms) || []].flat() : []
  );
  const minutes = ms.length ? getMean(ms) / 60_000 : undefined;
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
  const planned = JSON.parse(readFileOrEmpty(join(out, 'units.json')) || 'null') as {
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
  const all = ids.map(id => loadScored(out, id)).filter(c => benched(c.strata.repo));
  const cases = all.filter(c => !c.invalid);
  const md = [
    '# Bench report',
    '',
    ...headline(all, cases),
    ...judging(
      out,
      cases.map(c => c.id)
    ),
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
      judges: { type: 'string', default: 'opus:1,sonnet:2' },
      point: { type: 'string' },
      repeat: { type: 'string', default: '1' },
      pairs: { type: 'string', default: 'all' },
      'drop-env': { type: 'boolean', default: false },
    },
  });
  const [command, a, b, c] = positionals;
  const out = command === 'run' ? c : ['score', 'judge'].includes(command ?? '') ? b : undefined;
  const sandbox = out && command !== 'judge' && !image.startsWith('sha256:') ? imageId(image) : undefined;
  const env = out
    ? ensureRunSettingsPinned(join(resolve(out), 'env.json'), {
        ...readBenchResultEnv(),
        ...(values.keys && { keys: resolve(values.keys) }),
        ...(values.point && { point: values.point }),
        ...(sandbox && { image: sandbox }),
      })
    : {};
  for (const [k, v] of Object.entries(env)) if (k.startsWith('BENCH_')) process.env[k] ??= v;
  if (env.image) process.env.AGENTGRAPH_IMAGE = image = env.image;
  engine = process.env.BENCH_ENGINE ?? engine;
  if (out && command !== 'judge') reapTrees(resolve(out));
  if (cache && command !== 'judge') await removeOrphanedVolumes();
  const point = env.point ?? values.point ?? process.env.BENCH_POINT;
  if (point && !/^[\w-]+:[\w.-]+$/.test(point)) throw new Error(`bad --point ${point}`);
  if (!['all', 'human'].includes(values.pairs)) throw new Error(`bad --pairs ${values.pairs}`);
  Object.assign(options, { point, repeat: Number(values.repeat), pairs: values.pairs });
  Object.assign(limits, { codex: Number(values['max-codex']), claude: Number(values['max-claude-calls']) });
  panel = parsePanel(values.judges);
  readBenchKeys(env.keys ?? values.keys ?? join(agentgraphDir, 'infra/local/.keys.env'));
  if (command === 'run' && a && bots.includes(a) && b && c && values.repo) await runArm(a, b, resolve(c), values.repo);
  else if (command === 'score' && a && b && values.repo) await score(a, resolve(b), values.repo, values['drop-env']);
  else if (command === 'judge' && a && b) await judge(a, resolve(b));
  else if (command === 'report' && a) {
    writeFileAtomic(join(a, 'report.md'), report(a));
    console.log(readFileOrEmpty(join(a, 'report.md')));
  } else if (command === 'status' && a) {
    const { units, parallel } = unitsOf(resolve(a));
    console.log(statusText(progress(units, parallel)));
  } else {
    console.error('usage: node bin/bench.ts (run (v2|floor) <case> <out> | score <case> <out>) --repo <clone>');
    console.error('       node bin/bench.ts judge <case> <out> | report <out> | status <out>');
    process.exit(2);
  }
}
