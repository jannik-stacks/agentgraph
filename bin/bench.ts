/**
 * Replays merged pull requests as bench runs and scores them. Each command works on one slot of a set: the case, arm,
 * repeat, point and graph pick it. Every try of it is an attempt with a private graph and tracker under
 * `<set>/attempts/<n>`, and its run is an ordinary run in the set's store, `<set>/data`.
 * Usage: node bin/bench.ts run (v2|floor) <case dir> <set> --repo <clone> [--point harness:model] [--repeat k] [--graph dir]
 *        node bin/bench.ts import (human|base|control) <case dir> <set> --repo <clone> [--repeat k]
 *        node bin/bench.ts score <arm> <case dir> <set> --repo <clone> [same slot flags]
 *        node bin/bench.ts judge <arm> <case dir> <set> [same slot flags] [--judges opus:1,sonnet:2]
 * Scores and judgements are later results on the slot's run, versioned by what produced them, so a rerun skips a
 * current one. Paid steps stop past --max-codex weekly Codex percent, or after --max-claude-calls judge calls. Model
 * keys come from --keys, infra/local/.keys.env by default.
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { getSha } from '../src/hash.ts';
import { parseArgs, parseEnv, stripVTControlCharacters } from 'node:util';
import { dockerArgs, readImage, type CheckoutContainerSpec } from '../src/docker.ts';
import { isModelPriced, readPrices, type TokenCounts } from '../src/prices.ts';
import { dependencyDirs, discard, readSandboxSetup, createSharedMounts, manifest, written } from '../src/env.ts';
import { collect, ensureFreeDisk, readEnvRefs, writeEnvRefs } from '../src/disk.ts';
import { getMean, getRounded } from '../src/stats.ts';
import { getRunOrigin } from '../src/meta.ts';
import type * as MainModule from '../src/main.ts';
import { writeIssueFile } from '../src/tracker.ts';
import { addGraphArgs } from '../src/git.ts';
import { ConfigProvider, Effect } from 'effect';
import { writeComment } from '../src/instance.ts';
import { makeEngineHost, type Submission } from '../src/engine.ts';
import { appendJsonlRows, readJsonlRows, writeFileAtomic } from '../src/store.ts';
import { parseLabelPatch, parseLabels } from '../src/labels.ts';
import { parseNamePairs } from '../src/harnesses.ts';
import {
  agentgraphDir,
  appendJsonl,
  claim,
  clock,
  down,
  readJsonl,
  onStop,
  release,
  waitWhileServicesDown,
  readFileOrEmpty,
  removeSandboxContainersMountingDir,
  getHostProxyUrl,
} from './resume.ts';
import { waitForLock } from '../src/owner.ts';
import { parseGraphSettings } from '../src/folder.ts';
import { parse, stringify } from 'yaml';
import { hostSettings, makeTrackerSetup, settings } from '../src/services.ts';
import {
  type BenchInput,
  findSlotLock,
  getBenchSlot,
  getBenchUsageCost,
  makeBenchAttempt,
  readBenchSlots,
  readLatestRunChecks,
  readRunChange,
  readSlotRun,
  referenceArms,
} from '../bench/runs.ts';
import { type CheckEntry, type CheckResult } from '../src/types.ts';

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
  why?: string;
  test?: string;
  suite?: string;
  typecheck?: string;
  setup?: string;
  /** Extra toolchain installs, run before setup under the cache's toolchain lock. */
  toolchain?: string;
  /** The part of setup that builds from the repo's files, run again on every scored diff. */
  build?: string;
  runner?: string;
  image?: string;
};
type Verdict = {
  A?: { findings?: { severity: string; category: string; text: string }[] };
  B?: Verdict['A'];
  prefer: 'A' | 'B' | 'tie';
  why?: string;
};

export const bots = ['v2', 'floor'];
const graphAliases: Record<string, string> = { 'agentgraph-sandbox': 'sandbox' };
const findExampleGraphName = (repo: string) => {
  const name = repo.split('/').pop() ?? '';
  const graph = graphAliases[name] ?? name;
  return existsSync(join(agentgraphDir, 'examples', graph, 'settings.yaml')) ? graph : 'bench';
};
const answer = '/agent No more information. Use your judgment.';
const limits = { codex: 90, claude: 60 };
const options = {
  point: undefined as string | undefined,
  repeat: 1,
  graph: undefined as string | undefined,
  labels: parseLabels({}),
};
let panel: Record<string, number> = { opus: 1, sonnet: 2, sol: 2 };
const testPath = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.\w+$|_tests?\.\w+$/;
const noise =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|CHANGELOG[^/]*|[^/]*\.tsbuildinfo)$|(^|\/)\.(husky|changeset)\//;
const caseStart = /^\s*(?:(?:it|test)(?:\.\w+)*\s*\(|#\[(?:tokio::)?test\]|def test_|func Test)/;
const branches = /\b(?:if|for|while|match|case|catch|loop)\b|&&|\|\|/g;
const comment = /^\s*(\/\/|\/\*|\*|#(?!\[))/;

const hash = (text: string) => getSha(text, 20);
const sh = (cmd: string, args: string[], o: { cwd?: string; env?: Record<string, string> } = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...o, env: { ...process.env, ...o.env } });
const graphTrees = join(tmpdir(), 'agentgraph-graph-trees');
export const readGraphTree = (dir: string) => {
  if (!existsSync(join(graphTrees, 'objects'))) sh('git', ['init', '-q', '--bare', graphTrees]);
  const env = { GIT_DIR: graphTrees, GIT_WORK_TREE: dir, GIT_INDEX_FILE: join(graphTrees, `index-${randomUUID()}`) };
  try {
    sh('git', addGraphArgs, { cwd: dir, env });
    return sh('git', ['write-tree'], { cwd: dir, env }).trim();
  } finally {
    rmSync(env.GIT_INDEX_FILE, { force: true });
  }
};
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
    : {};
};

/** Each repo's typecheck and the setup it needs, run on every case whether or not it has hidden tests. */
const typechecks: Record<string, Commands> = {
  explorer: { setup: install('10.28.2'), typecheck: 'node_modules/.bin/tsc --noEmit' },
  'stacks.js': {
    setup: npmCi,
    typecheck: 'npm run typecheck --workspaces',
  },
  clarinet: { typecheck: 'cargo check --tests' },
};

/** The test command, the typecheck and their setup, from the repo and the test files a merged change touches. */
export const pickBenchTestCommands = (repo: string, tests: string[], fields: Commands = {}): Commands => {
  const recipe = tested(repo, tests);
  const commands = { ...typechecks[repo.split('/').pop() ?? ''], ...recipe, ...fields };
  delete commands.why;
  if (fields.hasTests === false) return { ...commands, why: 'case disables hidden tests' };
  if (commands.test?.trim()) return commands;
  if (!tests.some(p => testPath.test(p) && !noise.test(p)) && fields.hasTests !== true)
    return { ...commands, hasTests: false, why: 'case touches no test files' };
  return { ...commands, why: `no test command for ${repo}: set case.test for ${tests.join(', ') || 'declared tests'}` };
};

const tested = (repo: string, tests: string[]): Commands => {
  const name = repo.split('/').pop();
  const js = [...new Set(tests.map(p => p.replace(/^(.*\/)__snapshots__\/(.+)\.snap$/, '$1$2')))].filter(p =>
    /\.(test|spec)\.[jt]sx?$/.test(p)
  );
  const files = js.map(quote).join(' ');
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
      : {};
  }
  if (name !== 'clarinet') return {};
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
    : {};
};

export const readBenchCase = (dir: string): Case & Commands => {
  const c = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')) as Omit<Case, 'id' | 'dir' | 'body'> &
    Commands & { tests?: unknown };
  const issue = readFileSync(join(dir, 'issue.md'), 'utf8');
  const tests = splitUnifiedDiffByFile(readFileSync(join(dir, 'merged.diff'), 'utf8')).map(f => f.path);
  if (
    c.tests !== undefined &&
    typeof c.tests !== 'string' &&
    (!Array.isArray(c.tests) || !c.tests.every(p => typeof p === 'string'))
  )
    throw new Error('case.tests must be a command or an array of paths');
  return {
    ...c,
    ...pickBenchTestCommands(
      c.repo,
      [...new Set([...tests, ...(Array.isArray(c.tests) ? (c.tests as string[]) : [])])],
      {
        ...c,
        ...(typeof c.tests === 'string' && !c.test && { test: c.tests }),
        ...(c.bucket === 'no-tests' &&
          c.hasTests === undefined &&
          !c.test &&
          typeof c.tests !== 'string' && { hasTests: false }),
        ...(c.bucket === 'tests' && c.hasTests === undefined && { hasTests: true }),
      }
    ),
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

/** Stops paid work once the weekly Codex use, read at most every ten minutes, passes --max-codex percent. */
const guard = (set: string, claude: boolean) => {
  const file = join(set, 'budget.json');
  const b = JSON.parse(readFileOrEmpty(file) || '{}') as { now?: number; at?: number };
  if (!b.at || Date.now() - b.at > 600_000) {
    const now = codexUsed();
    if (now === undefined || !Number.isFinite(now)) throw new Error('Codex usage unreadable; no paid work started');
    Object.assign(b, { now, at: Date.now() });
    writeFileAtomic(file, b);
  }
  if (b.now !== undefined && b.now > limits.codex)
    throw new Error(`Codex weekly use is ${b.now}%, over ${limits.codex}%`);
  const calls = readJsonl(join(set, 'log.jsonl')).filter(
    l => l.event === 'start' && /opus|sonnet/.test(String(l.judge))
  );
  if (claude && calls.length >= limits.claude) throw new Error(`${calls.length} claude judge calls, the limit`);
};

const readPointKeys = (point: string) => {
  const key = keys[`AGENTGRAPH_LLM_API_KEY_PT_${point.replace(/\W/g, '_').toUpperCase()}`];
  const own = new Map(Object.entries(parseNamePairs(keys.AGENTGRAPH_PROXY_KEYS ?? '')));
  return { key, own, spare: key ?? own.get('implementor') ?? [...own.values()][0] };
};

/**
 * Points every agent of a graph at `harness:model`, by the two lines of its front matter. Every agent gets the point's
 * key, else its own, else the implementor's, so an agent a tune adds still has one.
 */
export const repoint = (graph: string, point: string) => {
  const [harness, model] = point.split(':');
  const dir = join(graph, 'agents');
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
  const { key, own, spare } = readPointKeys(point);
  for (const name of names.map(n => basename(n, '.md'))) if (spare && (key || !own.has(name))) own.set(name, spare);
  if (own.size) keys.AGENTGRAPH_PROXY_KEYS = [...own].map(([k, v]) => `${k}=${v}`).join(',');
};

/** The identity of an arm's run: a reference takes its case and repeat, an agent arm adds its point, graph and labels. */
export const makeBenchInput = (
  c: Pick<Case, 'id' | 'repo'>,
  arm: string,
  repeat: number,
  o: Partial<Record<'point' | 'graph', string | undefined>> & { labels?: Record<string, string> } = {}
): BenchInput =>
  referenceArms.includes(arm) || arm === 'control'
    ? { case: c.id, arm, repeat }
    : {
        case: c.id,
        arm,
        repeat,
        ...(o.point && { point: o.point }),
        graph: readGraphTree(
          arm === 'floor' ? join(agentgraphDir, 'bench/floor') : (o.graph ?? join(agentgraphDir, 'examples'))
        ),
        ...(o.labels && Object.keys(o.labels).length && { labels: o.labels }),
      };

const readInput = (c: Pick<Case, 'id' | 'repo'>, arm: string, repeat = options.repeat) =>
  makeBenchInput(c, arm, repeat, options);

/** The first repeat of a reference arm, which gates the case and is what agent runs are judged against. */
const readGateRun = (set: string, c: Pick<Case, 'id'>, arm: string) => readSlotRun(set, { case: c.id, arm, repeat: 1 });

const makeArmRunLabels = (set: string, input: BenchInput) => {
  const [harness, model] = input.point?.split(':') ?? [];
  return parseLabels({
    set: basename(set),
    case: input.case,
    arm: input.arm,
    ...(harness && model && { harness, model }),
    repeat: String(input.repeat),
    ...(input.attempt !== undefined && { attempt: String(input.attempt) }),
    ...options.labels,
  });
};

const submitBenchRun = (set: string, input: BenchInput, submission: Submission) =>
  makeEngineHost('bench', [{ name: basename(set), data: join(set, 'data') }], true).submit(
    basename(set),
    {
      job: basename(set),
      version: hash(readFileSync(new URL(import.meta.url), 'utf8')),
      input,
      labels: makeArmRunLabels(set, input),
    },
    submission
  );

/** A case's scoring dir in its set: its image pin, environment refs and score tree. */
const findCaseWorkDir = (set: string, c: Pick<Case, 'id'>) => join(set, 'work', c.id);

type SlotRun = NonNullable<ReturnType<typeof readSlotRun>>;

/** Appends a later bench result to a run, as `agi check --runs` appends one. */
export const appendBenchResults = (
  found: SlotRun,
  checks: (Omit<CheckResult, 'ms'> & Partial<Pick<CheckResult, 'ms'>>)[],
  version: string,
  usd = 0
) =>
  Effect.runPromise(
    appendJsonlRows(
      join(found.data, found.run.id, 'checks.jsonl'),
      checks.map((check, i) => ({
        at: new Date().toISOString(),
        step: 'bench',
        check: { ms: 0, ...check },
        version,
        usd: i ? 0 : usd,
        later: true as const,
      })) satisfies CheckEntry[]
    )
  );

const setLimit = (yaml: string, key: string, value: number) =>
  new RegExp(`^ {2}${key}:`, 'm').test(yaml)
    ? yaml.replace(new RegExp(`^( {2}${key}:).*$`, 'm'), `$1 ${value}`)
    : /^limits:/m.test(yaml)
      ? yaml.replace(/^limits:/m, `limits:\n  ${key}: ${value}`)
      : `${yaml}limits:\n  ${key}: ${value}\n`;

/** Writes the graph an arm's attempt runs, pinned to the case's image and pointed at `--point`. */
export const writeArmGraph = (c: Case & Commands, arm: string, at: string) => {
  const graph = join(at, 'graph');
  cpSync(findCaseGraphDir(c), graph, { recursive: true });
  if (!options.graph && findExampleGraphName(c.repo) === 'bench' && c.runner) {
    writeFileAtomic(
      join(graph, 'scripts/tests.sh'),
      `set -f\nfiles=$(git ls-files -mo --exclude-standard | grep -E '[.](test|spec)[.][jt]sx?$')\n[ -z "$files" ] || ${c.runner} $files\n`
    );
    writeFileAtomic(
      join(graph, 'checks/tests.md'),
      readFileOrEmpty(join(graph, 'checks/tests.md')).replace('npm test', 'sh "$AGENTGRAPH_DIR/scripts/tests.sh"')
    );
    if (c.setup)
      writeFileAtomic(
        join(graph, 'settings.yaml'),
        `setup: ${JSON.stringify(c.setup)}\n${readFileOrEmpty(join(graph, 'settings.yaml'))}`
      );
  }
  if (!options.graph && findExampleGraphName(c.repo) === 'bench' && !c.runner) {
    rmSync(join(graph, 'checks'), { recursive: true });
    writeFileAtomic(
      join(graph, 'workflows/issue.md'),
      readFileOrEmpty(join(graph, 'workflows/issue.md')).replace(/^ {4}checks: \[tests\]\n/m, '')
    );
  }
  const raw = readFileOrEmpty(join(graph, 'settings.yaml'));
  if (/^setup: pnpm install/m.test(raw))
    writeFileAtomic(join(graph, 'settings.yaml'), raw.replace(/^setup: .*\n/m, ''));
  writeFileAtomic(
    join(graph, 'settings.yaml'),
    setLimit(setLimit(readFileOrEmpty(join(graph, 'settings.yaml')), 'parallel', 1), 'sessions', 3)
  );
  if (arm === 'floor') {
    rmSync(join(graph, 'workflows'), { recursive: true });
    for (const d of ['agents', 'skills']) rmSync(join(graph, d), { recursive: true, force: true });
    rmSync(join(graph, 'checks'), { recursive: true, force: true });
    cpSync(join(agentgraphDir, 'bench/floor'), graph, { recursive: true });
  }
  writeFileAtomic(
    join(graph, 'settings.yaml'),
    stringify({ ...parse(readFileOrEmpty(join(graph, 'settings.yaml'))), image: c.image })
  );
  if (options.point) repoint(graph, options.point);
  return graph;
};

const engineArm = async (c: Case & Commands, arm: string, at: string, repo: string, set: string, input: BenchInput) => {
  const { readInstanceEnv } = (await import(join(agentgraphDir, 'src/main.ts'))) as typeof MainModule;
  const graph = writeArmGraph(c, arm, at);
  const dir = join(at, 'tracker');
  sh('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git')]);
  sh('git', ['-C', repo, 'push', '-q', join(dir, 'origin.git'), `${c.base}:refs/heads/main`]);
  const issue = await writeIssueFile(
    dir,
    { title: c.title, author: 'maintainer', labels: [] },
    c.body.trim(),
    input.attempt
  );
  await writeComment(dir, 'maintainer', issue, '/agent');
  const scope = await readInstanceEnv(undefined, {}, keys, {
    AGENTGRAPH_REPO: c.repo,
    AGENTGRAPH_TRACKER: dir,
    AGENTGRAPH_DIR: graph,
  });
  const current = await Effect.runPromise(
    settings.pipe(Effect.provideService(ConfigProvider.ConfigProvider, scope.config))
  );
  const setup = { ...scope, tracker: await makeTrackerSetup(current) };
  let answers = 0;
  let status: string | undefined;
  let reason: string | undefined;
  for (let pass = 0; pass < 6; pass++) {
    const [run] = await submitBenchRun(set, input, { graph, issue, setup });
    status = run?.status;
    reason = run?.reason;
    if (!run || run.status === 'done' || run.status === 'stopped') break;
    if (run.status !== 'waiting') continue;
    if (!run.reason || answers) break;
    await writeComment(dir, 'maintainer', issue, answer);
    answers++;
  }
  return { answers, status, ...(reason && { reason: reason.slice(0, 500) }) };
};

/** Why an arm attempt broke on its environment, not on the agent: the engine stopped on a runner error. */
export const runnerError = (reason = '') =>
  /runner error|^(SandboxError|SessionStop|TrackerError)\b/.test(reason) ? reason.slice(0, 200) : undefined;

/** The graph an arm of the case starts from: `--graph` when given, else the example graph of its repo. */
const findCaseGraphDir = (c: Pick<Case, 'repo'>, graph = options.graph) =>
  graph ?? join(agentgraphDir, 'examples', findExampleGraphName(c.repo));

export const readCaseImage = async (c: Case & Commands, set: string, graph = findCaseGraphDir(c)) => {
  const file = join(findCaseWorkDir(set, c), 'image.json');
  const release = await waitForLock(`bench-image-${hash(file)}`);
  try {
    const saved = JSON.parse(readFileOrEmpty(file) || '{}') as Pick<Commands, 'image'>;
    if (existsSync(file) && (typeof saved.image !== 'string' || !saved.image.startsWith('sha256:')))
      throw new Error(`invalid image pin in ${file}`);
    let selected = saved.image;
    if (!selected) {
      if (!existsSync(graph)) throw new Error(`case graph is missing: ${graph}`);
      const problems: string[] = [];
      const settings = parseGraphSettings(readFileOrEmpty(join(graph, 'settings.yaml')), m => problems.push(m));
      if (!settings || problems.length) throw new Error(`invalid case graph: ${problems.join('; ')}`);
      selected = (await Effect.runPromise(readImage(settings, image, c.image))).id;
      writeFileAtomic(file, { image: selected });
    } else {
      await Effect.runPromise(readImage({ image: selected }));
    }
    return { ...c, image: selected };
  } finally {
    await release();
  }
};

/** The harness's last words when the run's last session ended in an error, as when it cannot reach the proxy. */
export const harnessError = (data: string, id: string) => {
  const ends = readJsonl(join(data, id, 'trace.jsonl')).flatMap(t => {
    const e = t.event as { type?: string; ended?: string; final?: string } | undefined;
    return e?.type === 'end' ? [e] : [];
  });
  const last = ends.at(-1);
  return last?.ended === 'error' ? `harness error: ${String(last.final ?? '').slice(0, 160)}` : undefined;
};

/** Environment failures an arm may have before it counts as infra. */
const patience = 6;

export const writeAttemptImport = async (
  set: string,
  at: string,
  input: BenchInput,
  o: { repo: string; base: string; change: string; issue?: string }
) => {
  const tracker = join(at, 'tracker');
  if (!existsSync(join(tracker, 'origin.git')))
    sh('git', ['init', '-q', '--bare', '-b', 'main', join(tracker, 'origin.git')]);
  const [run] = await submitBenchRun(set, input, {
    import: { checkout: resolve(o.repo), tracker, change: o.change, from: o.base, ...(o.issue && { issue: o.issue }) },
  });
  return run!.id;
};

/**
 * Runs one arm of a case into its slot, each try in a new attempt dir, until an attempt ends with a `bench/arm` result.
 * A run that never finished is tried twice, then ends as infra; a run that changed nothing is the agent's result. A run
 * its environment broke (proxy, docker, a runner error, the machine asleep) waits for the environment and is tried
 * again, up to `patience` attempts, then ends as infra.
 */
const runArm = async (arm: string, caseDir: string, set: string, repo: string) => {
  const c = await readCaseImage(readBenchCase(caseDir), set);
  const input = readInput(c, arm);
  const ended = () => {
    const found = readSlotRun(set, input);
    return found && readLatestRunChecks(found.data, found.run.id).has('bench/arm');
  };
  if (ended()) return;
  const missing = unpriced(arm, findCaseGraphDir(c));
  if (missing.length) throw new Error(`no list price for ${missing.join(', ')}: add it to infra/local/aliases.json`);
  if (!keys.AGENTGRAPH_PROXY_KEYS) throw new Error('no model keys: pass --keys <env file>');
  const slot = getBenchSlot(input);
  const lock = findSlotLock(set, input);
  const log = logger(set, { case: c.id, arm, slot });
  if (!claim(lock)) return log({ event: 'busy' });
  const attempts = () => readBenchSlots(set).get(slot) ?? [];
  const removeStray = () => {
    for (const a of attempts()) removeSandboxContainersMountingDir(a.at);
  };
  onStop(signal => {
    log({ event: 'paused', signal });
    removeStray();
    release(lock);
  });
  const work = findCaseWorkDir(set, c);
  try {
    removeStray();
    for (let empty = 0; ;) {
      await waitWhileServicesDown(log, false, net =>
        down(net, { dir: work, eligible: readEnvRefs(work), ...(cache && { image: c.image }) })
      );
      guard(set, false);
      const { at, input: pinned } = makeBenchAttempt(set, input);
      const started = Date.now();
      const time = clock();
      let ran: Awaited<ReturnType<typeof engineArm>> | undefined;
      let broke: string | undefined;
      try {
        ran = await step(set, { step: 'run', case: c.id, arm }, () =>
          engineArm(c, arm, at, resolve(repo), set, pinned)
        );
      } catch (e) {
        broke = String(e).slice(0, 200);
      }
      time.stop();
      const slots = readBenchSlots(set);
      const found = readSlotRun(set, input, slots);
      const mine = found?.at === at ? found : undefined;
      const change = mine ? readRunChange(at, mine.run) : '';
      const nothing = ran?.status === 'running' ? 'run did not finish' : undefined;
      const env =
        broke ??
        (mine ? undefined : 'the attempt started no run') ??
        runnerError(ran?.reason) ??
        (mine && harnessError(mine.data, mine.run.id)) ??
        (nothing || !change.trim() ? ((await down()) ?? (time.missed() ? 'the machine slept' : undefined)) : undefined);
      if (env) log({ event: 'infra', why: env, attempt: pinned.attempt });
      const tries = slots.get(slot)?.length ?? 0;
      if (env && tries < patience) {
        await sleep(Math.min(60_000 * 2 ** tries, 900_000));
        continue;
      }
      if (!env && nothing && ++empty < 2) continue;
      if (!mine) await writeAttemptImport(set, at, pinned, { repo, base: c.base, change: c.base });
      const why = env ?? nothing;
      return await appendBenchResults(
        readSlotRun(set, input)!,
        [
          {
            check: 'bench/arm',
            pass: !why,
            ...(why && { findings: why }),
            value: {
              answers: ran?.answers ?? 0,
              ms: Date.now() - started - time.missed(),
              ...(time.missed() && { slept: time.missed() }),
            },
          },
        ],
        hash(readFileSync(new URL(import.meta.url), 'utf8'))
      );
    }
  } finally {
    release(lock);
  }
};

/** Records a reference run of a case: the merged change (`human`), no change (`base`) or a planted control. */
export const writeReferenceRun = async (
  arm: string,
  caseDir: string,
  set: string,
  repo: string,
  repeat = options.repeat
) => {
  const c = readBenchCase(caseDir);
  const input = readInput(c, arm, repeat);
  const lock = findSlotLock(set, input);
  while (!claim(lock)) await sleep(5000);
  try {
    if (readSlotRun(set, input)) return;
    const { at, input: pinned } = makeBenchAttempt(set, input);
    writeFileAtomic(join(at, 'issue.md'), `${c.title}\n\n${c.body}\n`);
    const human = readFileOrEmpty(join(c.dir, 'merged.diff'));
    const change =
      arm === 'base'
        ? undefined
        : arm === 'human'
          ? human
          : c.control === 'bug'
            ? plant(human)
            : c.control && pad(human);
    if (change === undefined && arm !== 'base') throw new Error(`${c.id}: no ${arm} change for this case`);
    if (change !== undefined) writeFileAtomic(join(at, 'change.patch'), change.endsWith('\n') ? change : `${change}\n`);
    await writeAttemptImport(set, at, pinned, {
      repo,
      base: c.base,
      change: change === undefined ? c.base : join(at, 'change.patch'),
      issue: join(at, 'issue.md'),
    });
  } finally {
    release(lock);
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
  const r = spawnSync('docker', dockerArgs(c, from, name, box, scoreSize), {
    encoding: 'utf8',
    timeout: 3_600_000,
    maxBuffer: 1 << 28,
  });
  if (r.error) spawnSync('docker', ['rm', '-f', name]);
  if (r.error) throw new Error(`infra: score container did not finish: ${r.error.message}`);
  if (r.status === null) throw new Error(`infra: score container stopped by ${r.signal ?? 'an unknown signal'}`);
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

/** The share of the hidden tests base fails that a run passes; pass or fail when the run printed no counts. */
export const hiddenShare = (run?: Pick<ReturnType<typeof exec>, 'ok' | 'tail'>, base?: typeof run) => {
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
    }).status !== 0
  )
    return { applied: false };
  const git = existsSync(join(repo, '.git')) ? join(repo, '.git') : repo;
  const start = c.image!;
  const found = spawnSync('docker', ['image', 'inspect', start], { encoding: 'utf8' });
  if (found.status !== 0)
    throw new Error(`score needs docker and the ${start} image: ${found.error?.message ?? found.stderr.trim()}`);
  if (cache) await ensureFreeDisk({ dir: dirname(tree), image: start });
  const { cache: repoCache, env } = cache
    ? await readSandboxSetup({
        repo: c.repo,
        origin: resolve(git),
        image: start,
        git,
        base: c.base,
        cache,
        trusted: ['refs/remotes/origin/HEAD'],
        ...(c.setup && { setup: c.setup }),
        ...(c.toolchain && { toolchain: c.toolchain }),
      })
    : { cache: '', env: undefined };
  writeEnvRefs(dirname(tree), [...(repoCache ? [repoCache] : []), ...(env ? [env.image] : [])]);
  const sharedMounts = repoCache
    ? await createSharedMounts(
        env ?? { image: start, outputs: [] },
        randomBytes(6).toString('hex'),
        tree,
        await dependencyDirs(git, c.base),
        repoCache
      )
    : [];
  const box = { mounts: [{ src: git, dst: git, readonly: true }], sharedMounts, cache: repoCache };
  const from = env?.image ?? start;
  const scored = () => {
    const again = !env?.complete || splitUnifiedDiffByFile(diff).some(f => manifest.test(f.path));
    const prep = again ? c.setup : diff.trim() ? c.build : undefined;
    const suite = c.suite ?? c.test;
    const result = {
      applied: true,
      image: start,
      ...(env && { env: env.image }),
      ...(prep && { setup: exec(prep, tree, box, from, 'open') }),
      ...(suite && { suite: exec(suite, tree, box, from) }),
      ...(c.typecheck && { typecheck: exec(c.typecheck, tree, box, from) }),
    };
    if (!c.test || c.hasTests === false) return result;
    for (const path of hidden) {
      if (sh('git', ['-C', tree, 'ls-tree', '--name-only', c.merged, '--', path]).trim())
        sh('git', ['-C', tree, 'checkout', c.merged, '--', path]);
      else rmSync(join(tree, path), { force: true });
    }
    const relaxed = readFileOrEmpty(join(c.dir, 'hidden.relaxed.diff'));
    if (relaxed && spawnSync('git', ['-C', tree, 'apply', '-'], { input: relaxed }).status !== 0)
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

export type Tests = {
  applied?: boolean;
  setup?: { ok: boolean };
  suite?: { ok: boolean };
  typecheck?: { ok: boolean };
  hidden?: Pick<ReturnType<typeof exec>, 'ok'> & Partial<Pick<ReturnType<typeof exec>, 'tail'>>;
};

/** Why a case cannot tell arms apart, when it cannot: the hidden tests must fail on base and pass on the human. */
export const invalid = (base: Tests, human: Tests, tested = true) => {
  if (human.applied === false) return 'the human diff does not apply to base';
  if (base.setup?.ok === false || human.setup?.ok === false) return 'setup fails';
  if (!base.hidden || !human.hidden) {
    if (tested || base.hidden || human.hidden) return 'no hidden tests run';
    if (human.suite?.ok === false) return 'the human fails the suite';
    return human.typecheck?.ok === false ? 'the human fails the typecheck' : undefined;
  }
  if (base.hidden.ok) return 'base already passes the hidden tests';
  if (!human.hidden.ok) return 'the human fails the hidden tests';
  if (human.suite?.ok === false) return 'the human fails the suite';
  if (human.typecheck?.ok === false && base.typecheck?.ok !== false) return 'the human fails the typecheck';
  return undefined;
};

/** The base commit's file list, a file's text, and whether a word occurs anywhere in it. */
type Base = { files: string[]; text: (path: string) => string; has: (word: string) => boolean };

const readRepoBase = (repo: string, base: string): Base => ({
  files: sh('git', ['-C', repo, 'ls-tree', '-r', '--name-only', base]).split('\n').filter(Boolean),
  text: path => sh('git', ['-C', repo, 'show', `${base}:${path}`]),
  has: word => {
    const result = spawnSync('git', ['-C', repo, 'grep', '-q', '-w', '-F', word, base], { encoding: 'utf8' });
    if (result.status !== 0 && result.status !== 1)
      throw new Error(`git grep failed: ${result.error?.message ?? result.stderr}`);
    return result.status === 0;
  },
});

export const readBenchSetupLabels = (repo: string, base: string): Record<string, string> => {
  const { files } = readRepoBase(repo, base);
  return {
    'agents-md': String(files.some(p => /(^|\/)AGENTS\.md$/.test(p))),
    'claude-md': String(files.some(p => /(^|\/)CLAUDE\.md$/.test(p))),
    skills: String(
      files.some(p => /(^|\/)(\.(claude|agents)\/skills|\.cursor\/rules|\.github\/skills)(?:\/|$)/.test(p))
    ),
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

/** Hidden test paths of a case: the test files its merged change touches. */
const findHiddenTests = (c: Case & Commands) =>
  c.hasTests === false
    ? []
    : splitUnifiedDiffByFile(readFileOrEmpty(join(c.dir, 'merged.diff')))
        .map(f => f.path)
        .filter(p => testPath.test(p) && !noise.test(p));

const scorer = (c: Case & Commands) =>
  hash(
    [
      pickBenchTestCommands,
      check,
      invalid,
      exec,
      c.image,
      readFileOrEmpty(join(c.dir, 'case.json')),
      readFileOrEmpty(join(c.dir, 'merged.diff')),
      readFileOrEmpty(join(c.dir, 'hidden.relaxed.diff')),
    ].join('\0')
  );

const wantedResults = (c: Commands) => [
  'bench/setup',
  'bench/size',
  'bench/hidden',
  ...(c.suite || c.test ? ['bench/suite'] : []),
  ...(c.typecheck ? ['bench/typecheck'] : []),
];

const isCurrent = (found: SlotRun, names: string[], version: string) => {
  const latest = readLatestRunChecks(found.data, found.run.id);
  return names.every(name => latest.get(name)?.version === version);
};

const isArmScorable = (found: SlotRun) => {
  const armed = readLatestRunChecks(found.data, found.run.id).get('bench/arm');
  return armed ? armed.check.pass : found.run.workflow === 'import';
};

/** A score run as the results it writes; a failed run keeps its output's tail as findings. */
export const makeBenchResults = (
  c: Case & Commands,
  tests: object,
  diff: string,
  labels: Record<string, string>,
  base?: Tests
): CheckResult[] => {
  type Ran = ReturnType<typeof exec>;
  const t = tests as Partial<Record<'setup' | 'suite' | 'typecheck' | 'hidden', Ran>> &
    Partial<Record<'applied', boolean> & Record<'env', string> & Record<'cache', number>>;
  const ran = (name: string, r: Ran): CheckResult => ({
    check: name,
    pass: r.ok,
    ms: r.ms,
    ...(!r.ok && { findings: r.tail }),
  });
  const human = splitUnifiedDiffByFile(readFileOrEmpty(join(c.dir, 'merged.diff'))).map(f => f.path);
  const why =
    t.applied === false ? 'the change does not apply to base' : t.setup?.ok === false ? t.setup.tail : undefined;
  const share = t.hidden && hiddenShare(t.hidden, base?.hidden && { ok: base.hidden.ok, tail: base.hidden.tail ?? '' });
  const hidden: CheckResult =
    c.hasTests === false || !c.test
      ? { check: 'bench/hidden', pass: true, na: true, ms: 0, findings: c.why ?? 'the case has no hidden tests' }
      : !t.hidden
        ? { check: 'bench/hidden', pass: false, na: true, ms: 0, findings: 'no hidden tests run' }
        : {
            ...ran('bench/hidden', t.hidden),
            ...(share !== undefined && { share }),
            ...(!t.hidden.ok && { value: { class: failureClass(t.hidden.tail) } }),
          };
  return [
    {
      check: 'bench/setup',
      pass: !why,
      ms: t.setup?.ms ?? 0,
      value: {
        applied: t.applied !== false,
        labels,
        ...(t.setup && { setup: t.setup.ok }),
        ...(c.image && { image: c.image }),
        ...(t.env && { env: t.env }),
        ...(t.cache !== undefined && { cache: t.cache }),
      },
      ...(why && { findings: why }),
    },
    { check: 'bench/size', pass: true, ms: 0, value: stats(diff, human) },
    ...(t.suite ? [ran('bench/suite', t.suite)] : []),
    ...(t.typecheck ? [ran('bench/typecheck', t.typecheck)] : []),
    hidden,
  ];
};

/** A run's score results read back as the test outcomes `invalid` compares. */
const readTests = (found: SlotRun): Tests => {
  const latest = readLatestRunChecks(found.data, found.run.id);
  const ok = (name: string) => {
    const e = latest.get(name);
    return e && !e.check.na ? { ok: e.check.pass, tail: e.check.findings ?? '' } : undefined;
  };
  const setup = latest.get('bench/setup')?.check.value as { applied?: boolean; setup?: boolean } | undefined;
  const [suite, typecheck, hidden] = [ok('bench/suite'), ok('bench/typecheck'), ok('bench/hidden')];
  return {
    ...(setup?.applied !== undefined && { applied: setup.applied }),
    ...(setup?.setup !== undefined && { setup: { ok: setup.setup } }),
    ...(suite && { suite }),
    ...(typecheck && { typecheck }),
    ...(hidden && { hidden }),
  };
};

/** Scores the slot runs of `inputs` in the case's scoring tree, each once per scorer version. */
const scoreRuns = async (c: Case & Commands, set: string, repo: string, inputs: BenchInput[]) => {
  const version = scorer(c);
  const work = findCaseWorkDir(set, c);
  const tree = join(work, 'tree');
  const labels = readBenchSetupLabels(repo, c.base);
  while (!claim(tree)) await sleep(5000);
  try {
    for (const wanted of inputs) {
      const found = readSlotRun(set, wanted);
      if (!found || isCurrent(found, wantedResults(c), version)) continue;
      const diff = readRunChange(found.at, found.run);
      const input = getRunOrigin(found.run.meta)?.input as BenchInput;
      if (!existsSync(tree)) sh('git', ['clone', '-q', '--shared', '--no-checkout', resolve(repo), tree]);
      const tests = await step(set, { step: 'score', case: c.id, arm: input.arm, slot: getBenchSlot(input) }, () =>
        c.test || c.suite || c.typecheck ? check(c, tree, diff, findHiddenTests(c), resolve(repo)) : {}
      );
      const offline = (tests as Tests).setup?.ok === false && (await down(true));
      if (offline) throw new Error(`infra: setup failed while ${offline}, ${getBenchSlot(input)} stays unscored`);
      const base = readGateRun(set, c, 'base');
      const results = makeBenchResults(
        c,
        tests,
        diff,
        labels,
        input.arm === 'base' || !base ? undefined : readTests(base)
      );
      await appendBenchResults(found, results, version);
    }
  } finally {
    rmSync(tree, { recursive: true, force: true });
    release(tree);
  }
};

/**
 * Records on the human run whether the case can tell runs apart: its hidden tests must fail on base and pass on the
 * human's change, and the issue must name what the hidden tests call.
 */
const writeCaseValid = async (c: Case & Commands, set: string, repo: string) => {
  const [base, human] = referenceArms.map(arm => readGateRun(set, c, arm));
  if (!base || !human) throw new Error(`${c.id}: reference runs are missing`);
  const version = scorer(c);
  if (!isCurrent(human, ['bench/valid'], version)) {
    const coupled =
      c.why || existsSync(join(c.dir, 'hidden.relaxed.diff'))
        ? []
        : couplings(readFileOrEmpty(join(c.dir, 'merged.diff')), `${c.title}\n${c.body}`, readRepoBase(repo, c.base));
    const why =
      (c.hasTests !== false && c.why) ||
      (coupled.length ? 'coupled' : invalid(readTests(base), readTests(human), c.hasTests !== false));
    await appendBenchResults(
      human,
      [
        {
          check: 'bench/valid',
          pass: !why,
          ...(why && { findings: why }),
          ...(coupled.length && { value: { coupled } }),
        },
      ],
      version
    );
  }
  const valid = readLatestRunChecks(human.data, human.run.id).get('bench/valid')!.check;
  const states = [base, human]
    .map(found => {
      const tests = readTests(found);
      const names = (['hidden', 'suite', 'typecheck'] as const).map(
        name => `${name}=${tests[name] ? (tests[name].ok ? 'pass' : 'fail') : 'not run'}`
      );
      const measured = tests.hidden ? counts(tests.hidden.tail) : { passed: 0, total: 0 };
      return `${(getRunOrigin(found.run.meta)?.input as BenchInput | undefined)?.arm} ${names.join(' ')} tests=${JSON.stringify(measured ?? 'unreported')}`;
    })
    .join(', ');
  const skipped = c.hasTests === false && c.why;
  console.log(
    `gate ${c.id}: ${valid.pass ? (skipped ? 'skipped' : 'valid') : 'invalid'}: ${valid.findings ?? (skipped || 'hidden tests distinguish base and human')}; ${states}; skips=${Number(Boolean(skipped))}`
  );
  return valid.pass;
};

/** Imports and scores the case's reference runs, gates the case, then scores `arm`'s run when the case is valid. */
const score = async (arm: string, caseDir: string, set: string, repo: string, drop = false) => {
  const c = await readCaseImage(readBenchCase(caseDir), set);
  for (const ref of referenceArms) await writeReferenceRun(ref, caseDir, set, repo, 1);
  if (!c.why || c.hasTests === false)
    await scoreRuns(
      c,
      set,
      repo,
      referenceArms.map(arm => ({ case: c.id, arm, repeat: 1 }))
    );
  if ((await writeCaseValid(c, set, repo)) && arm !== 'control') {
    const input = readInput(c, arm);
    const found = readSlotRun(set, input);
    if (found && isArmScorable(found)) await scoreRuns(c, set, repo, [input]);
  }
  if (cache) await collect({ eligible: readEnvRefs(findCaseWorkDir(set, c)), ...(drop && { limit: 0 }) });
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

type Answer = { text: string; tokens?: TokenCounts; usd?: number };

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
const ask = (model: string, key: string | undefined, prompt: string, ms = 1_800_000) =>
  fetch(`${getHostProxyUrl()?.href.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(ms),
  });
const proxied = (model: string) => async (prompt: string) =>
  parseBenchJudgeResponse(await (await ask(model, keys.AGENTGRAPH_LLM_API_KEY_REVIEWER, prompt)).json());
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
const prices = readPrices();

/** The models an arm's agents run on, at `point` when given, that the engine's price table has no list price for. */
export const unpriced = (arm: string, graph: string, point = options.point) => {
  const dir = join(arm === 'floor' ? join(agentgraphDir, 'bench/floor') : graph, 'agents');
  const named = (existsSync(dir) ? readdirSync(dir) : [])
    .filter(n => n.endsWith('.md'))
    .map(n => /^model: *(\S+)/m.exec(readFileOrEmpty(join(dir, n)))?.[1] ?? 'default');
  return [...new Set(point ? [point.split(':')[1]!] : named)].filter(m => !isModelPriced(prices, m));
};

export const whyPointUnready = async (point: string) => {
  const model = point.split(':')[1]!;
  if (!isModelPriced(prices, model)) return `${point}: no list price for ${model}`;
  const r = await ask(model, readPointKeys(point).spare, 'Reply with exactly: ok', 120_000).catch(
    (e: unknown) => e as Error
  );
  if (r instanceof Error) return `${point}: model proxy unreachable: ${r.message}`;
  if (!r.ok) return `${point}: the proxy answered ${r.status}: ${(await r.text()).slice(0, 200)}`;
  return undefined;
};

/** The maker of a proxy alias or model, from its upstream name: openai, anthropic, google, z-ai, x-ai and so on. */
export const getModelMakerFromUpstreamName = (model: string, aliases = prices.aliases) => {
  const name = (aliases[model] ?? model).replace(/^openrouter\//, '');
  if (/^(chatgpt|openai)\/|^gpt-/.test(name)) return 'openai';
  if (/^(anthropic\/)?claude/.test(name)) return 'anthropic';
  return name.includes('/') ? name.split('/')[0]! : name;
};

/** The panel with each judge of the contestant's family swapped for the first of sol, gemini, opus from another one. */
export const makeCrossMakerJudgePanel = (
  chosen: Record<string, number>,
  contestant: string,
  aliases = prices.aliases
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

/**
 * Judges `arm`'s run of a valid case against the human's first repeat: each judge of the panel reads both changes, in
 * one or both orders, and the run gets a `bench/judge` result with how often it was preferred and the findings on
 * each side.
 */
export type JudgedVerdict = Verdict & { judge: string; order: [string, string] };

export const makeBenchJudgeResult = (verdicts: JudgedVerdict[], arm: string, human: string) => {
  const byJudge: Record<string, number[]> = {};
  for (const v of verdicts)
    (byJudge[v.judge] ??= []).push(v.prefer === 'tie' ? 0.5 : +(v.order[+(v.prefer === 'B')] === arm));
  const count = (side: string, severity: string) =>
    getMean(
      verdicts.map(
        v => (v[v.order[0] === side ? 'A' : 'B']?.findings ?? []).filter(f => f.severity === severity).length
      )
    );
  const severities = (side: string) => ({ critical: count(side, 'critical'), high: count(side, 'high') });
  const vsHuman = Object.fromEntries(Object.entries(byJudge).map(([j, ps]) => [j, getMean(ps)]));
  return {
    check: 'bench/judge',
    pass: getMean(Object.values(vsHuman)) >= 0.5,
    value: {
      vsHuman,
      findings: severities(arm),
      against: severities('human'),
      human,
      verdicts: verdicts.map(({ judge, order, prefer, why }) => ({ judge, order, prefer, ...(why && { why }) })),
    },
  };
};

const judge = async (arm: string, caseDir: string, set: string) => {
  const c = await readCaseImage(readBenchCase(caseDir), set);
  const human = readGateRun(set, c, 'human');
  const valid = human && readLatestRunChecks(human.data, human.run.id).get('bench/valid');
  if (!human || !valid?.check.pass) return;
  const found = readSlotRun(set, readInput(c, arm));
  if (!found) throw new Error(`${c.id}/${arm}: no run to judge`);
  if (!isArmScorable(found)) return;
  const names = [c.author ?? '', c.repo.split('/')[0] ?? ''];
  const changes = { human: readRunChange(human.at, human.run), [arm]: readRunChange(found.at, found.run) };
  if (!changes[arm]!.trim()) {
    if (!isCurrent(found, ['bench/judge'], 'no-change'))
      await appendBenchResults(
        found,
        [{ check: 'bench/judge', pass: false, na: true, findings: 'no change to judge' }],
        'no-change'
      );
    return;
  }
  const block = (label: string, side: string) =>
    `## Candidate ${label}\n\n\`\`\`diff\n${scrub(changes[side]!, names)}\n\`\`\``;
  const issue = scrub(`# ${c.title}\n\n${c.body}`, names);
  const chosen = makeCrossMakerJudgePanel(panel, options.point?.split(':')[1] ?? 'smart');
  const asks = Object.entries(chosen).flatMap(([name, n]) =>
    orders(n, `${c.id}/human-${arm}`).map(at => {
      const [a, b] = at ? [arm, 'human'] : ['human', arm];
      const prompt = `${readFileOrEmpty(join(agentgraphDir, 'bench/judge.md'))}\n## Issue\n\n${issue}\n\n${block('A', a)}\n\n${block('B', b)}\n`;
      return { name, order: [a, b] as [string, string], prompt };
    })
  );
  const version = hash(JSON.stringify(asks));
  if (isCurrent(found, ['bench/judge'], version)) return;
  const file = join(found.data, found.run.id, 'checks.jsonl');
  const calls = () => (readJsonlRows(file) as CheckEntry[]).filter(e => e.item && e.version === version);
  const kept = calls();
  const verdicts = await Promise.all(
    asks.map(async ({ name, order, prompt }) => {
      const item = `${name}:${order.join('-')}`;
      const saved = kept.find(e => e.item === item && e.check.pass)?.check.value as JudgedVerdict | undefined;
      if (saved) return saved;
      for (let attempt = 0; attempt < 3; attempt++) {
        guard(set, getModelMakerFromUpstreamName(judgeModels[name]!) === 'anthropic');
        const got = await step(set, { step: 'judge', case: c.id, arm, judge: name, order }, () =>
          judges[name]!(prompt, tmpdir())
        ).catch(() => ({ text: '' }) as Answer);
        const tokens = got.tokens && { [judgeModels[name]!]: got.tokens };
        const usd = getBenchUsageCost({
          ...(got.usd !== undefined && { usd: got.usd }),
          ...(tokens && { tokens }),
        }).usd;
        const parsed = parseBenchJudgeVerdict(got.text);
        const v = parsed && { judge: name, order, ...parsed };
        await Effect.runPromise(
          appendJsonlRows(file, [
            {
              at: new Date().toISOString(),
              step: 'bench',
              check: { check: 'bench/judge', pass: Boolean(v), ms: 0, ...(v && { value: v }) },
              item,
              version,
              usd,
              later: true,
            } satisfies CheckEntry,
          ])
        );
        if (v) return v;
        logger(set, { step: 'judge', case: c.id, arm, judge: name })({
          event: 'invalid',
          reason: 'judge returned no valid verdict',
          attempt,
        });
      }
      throw new Error(`${c.id}/${arm}/${name}: no valid judge verdict after 3 attempts`);
    })
  );
  await appendBenchResults(
    found,
    [makeBenchJudgeResult(verdicts, arm, human.run.id)],
    version,
    getRounded(calls().reduce((n, e) => n + e.usd, 0))
  );
};

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      keys: { type: 'string' },
      'max-codex': { type: 'string', default: '90' },
      'max-claude-calls': { type: 'string', default: '60' },
      judges: { type: 'string', default: 'opus:1,sonnet:2' },
      point: { type: 'string' },
      repeat: { type: 'string', default: '1' },
      graph: { type: 'string' },
      'drop-env': { type: 'boolean', default: false },
      label: { type: 'string', multiple: true },
    },
  });
  const [command, arm, caseDir, out] = positionals;
  if (values.point && !/^[\w-]+:[\w.-]+$/.test(values.point)) throw new Error(`bad --point ${values.point}`);
  Object.assign(options, {
    point: values.point,
    repeat: Number(values.repeat),
    graph: values.graph && resolve(values.graph),
    labels: parseLabels(parseLabelPatch(values.label ?? [])),
  });
  Object.assign(limits, { codex: Number(values['max-codex']), claude: Number(values['max-claude-calls']) });
  panel = parsePanel(values.judges);
  readBenchKeys(values.keys ?? join(agentgraphDir, 'infra/local/.keys.env'));
  if (command !== 'judge' && !image.startsWith('sha256:'))
    process.env.AGENTGRAPH_IMAGE = image = imageId(image) ?? image;
  const set = out && resolve(out);
  const dir = caseDir && resolve(caseDir);
  if (command === 'run' && arm && bots.includes(arm) && dir && set && values.repo)
    await runArm(arm, dir, set, values.repo);
  else if (command === 'import' && arm && dir && set && values.repo)
    await writeReferenceRun(arm, dir, set, values.repo);
  else if (command === 'score' && arm && dir && set && values.repo)
    await score(arm, dir, set, values.repo, values['drop-env']);
  else if (command === 'judge' && arm && dir && set) await judge(arm, dir, set);
  else {
    console.error(
      'usage: node bin/bench.ts (run|import|score|judge) <arm> <case dir> <set> --repo <clone> [slot flags]'
    );
    process.exit(2);
  }
}
