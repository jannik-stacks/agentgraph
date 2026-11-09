/**
 * Starts a run for every case of `<set>/set.json` times each arm, point and repeat, and skips the ones already on
 * disk; each gates its case on the reference runs, then runs, scores and judges its slot through bin/bench.ts.
 * Usage: node bench/start-runs.ts <set> [--cases a,b] [--arms v2,floor] [--points opencode:luna] [--repeats 3]
 *        [--graph dir] [--label key=value]... [--parallel 3] [--max-codex 90] [--cap usd --per usd --orenv file]
 *        [--keys file] [--judges opus:1,sonnet:2|none] [--repos dir] [--dry]
 * Exits 1 while runs are left, so a queue tries again later.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { claim, onStop, readFileOrEmpty, release, startChildProcess } from '../bin/resume.ts';
import type * as BenchModule from '../bin/bench.ts';
import { Effect } from 'effect';
import { parseLabelPatch, parseLabels } from '../src/labels.ts';
import { readEngineVersions } from '../src/git.ts';
import { readImage, sandboxImage } from '../src/docker.ts';
import { readHarnessSettings } from '../src/harnesses.ts';
import type { RunRecord } from '../src/types.ts';
import { isBenchCaseValid, isBenchRunDone, readBenchSlots, readSlotRun } from './runs.ts';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/** The node on PATH now, so a toolchain upgrade during a long bench does not break later spawns. */
export const nodePath = (fallback = process.execPath) =>
  spawnSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout?.trim() || fallback;

/**
 * Runs `args` with node into `logFile` in its own process group; a spawn or log write error ends it with exit 1
 * instead of the driver.
 */
export const runLogged = async (
  args: string[],
  logFile: string,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void = console.error
) => {
  let fd: number;
  try {
    fd = openSync(logFile, 'a');
    writeSync(fd, `\n### ${new Date().toISOString()} ${args.slice(1, 3).join(' ')}\n`);
  } catch (e) {
    log(`log ${logFile}: ${(e as Error).message}`);
    return 1;
  }
  return new Promise<number>(done => {
    const end = (code: number) => {
      closeSync(fd);
      done(code);
    };
    const child = startChildProcess(nodePath(), args, { env, stdio: ['ignore', fd, fd] });
    child.once('error', e => {
      log(`spawn: ${e.message}`);
      child.removeAllListeners('close');
      end(1);
    });
    child.once('close', code => end(code ?? 1));
  });
};

export const runQueue = async <T>(
  items: T[],
  parallel: number,
  run: (item: T) => Promise<void>,
  why: (active: number) => Promise<string | undefined> = async () => undefined
) => {
  let active = 0;
  let stopped: string | undefined;
  let turn = Promise.resolve();
  const take = () => {
    const next = turn.then(async () => {
      if (stopped || !items.length) return [];
      stopped = await why(active);
      if (stopped) return [];
      active++;
      return [items.shift()!];
    });
    turn = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };
  const work = async () => {
    for (let [item] = await take(); item !== undefined; [item] = await take())
      try {
        await run(item);
      } finally {
        active--;
      }
  };
  await Promise.all(Array.from({ length: parallel }, work));
  return stopped;
};

/**
 * Takes this run's baseline from `usage`. `check` says why no new job may start: a failed or over two minutes old
 * reading, or this run's spend, plus a job for each in flight and the next, passing `cap`. A job costs this run's
 * spend over the jobs `finished` in it, at least `per`.
 */
export const spendGuard = async (cap: number, per: number, usage: () => Promise<number>, clock = Date.now) => {
  let last: { at: number; total: number } | undefined;
  let failed: string | undefined;
  let done = 0;
  const read = async () => {
    if (last && !failed && clock() - last.at < 60_000) return;
    const at = clock();
    try {
      last = { at, total: await usage() };
      failed = undefined;
    } catch (e) {
      failed = String(e);
    }
  };
  await read();
  const baseline = last?.total;
  const first = failed;
  const check = async (active: number) => {
    if (baseline === undefined) return `OpenRouter usage unreadable: ${first}`;
    await read();
    if (failed || !last) return `OpenRouter usage unreadable: ${failed}`;
    const age = clock() - last.at;
    if (age > 120_000) return `OpenRouter usage is ${Math.round(age / 1000)}s old`;
    const run = last.total - baseline;
    const each = Math.max(per, done ? run / done : 0);
    if (run + (active + 1) * each > cap)
      return `run spend $${run.toFixed(2)} with ${active} in flight at ~$${each.toFixed(2)} a job would pass $${cap}`;
    return undefined;
  };
  return { check, finished: () => void done++ };
};

export const formatStaleSlots = (
  done: { point: string; versions: RunRecord['versions'] }[],
  now: Required<Pick<NonNullable<RunRecord['versions']>, 'engine' | 'harnesses'>>
) => {
  const lines = done.flatMap(({ point, versions }) => {
    const harness = point.split(':')[0] ?? '';
    const [engine, ran, has] = [
      versions?.engine ?? 'unknown',
      versions?.harnesses?.[harness] ?? 'unknown',
      now.harnesses[harness] ?? 'unknown',
    ];
    return [
      ...(engine === now.engine ? [] : [`ran engine ${engine}, this checkout is ${now.engine}`]),
      ...(ran === has ? [] : [`ran ${harness}@${ran}, ${sandboxImage} has ${has}`]),
    ];
  });
  return Object.entries(Object.groupBy(lines, line => line)).map(
    ([line, all]) => `${all!.length} done slots ${line}; pass --label to run them again`
  );
};

const readCurrentVersions = Effect.gen(function* () {
  const { engine } = yield* readEngineVersions;
  const { packages } = yield* readImage();
  const { harnesses } = yield* readHarnessSettings;
  return { engine, harnesses: Object.fromEntries(harnesses.map(h => [h.name, packages[h.package] ?? 'unknown'])) };
});

const list = (text: string) => text.split(',').filter(Boolean);

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cases: { type: 'string', default: '' },
      arms: { type: 'string', default: 'v2,floor' },
      points: { type: 'string', default: 'opencode:luna' },
      repeats: { type: 'string', default: '3' },
      graph: { type: 'string' },
      label: { type: 'string', multiple: true, default: [] },
      parallel: { type: 'string', default: '3' },
      'max-codex': { type: 'string', default: '90' },
      'max-claude-calls': { type: 'string', default: '2000' },
      cap: { type: 'string' },
      per: { type: 'string', default: '0.3' },
      orenv: { type: 'string' },
      keys: { type: 'string' },
      judges: { type: 'string', default: 'opus:1,sonnet:2' },
      repos: { type: 'string', default: join(homedir(), '.agentgraph/tune/repos') },
      dry: { type: 'boolean', default: false },
    },
  });
  const set = resolve(positionals[0] ?? '');
  if (!existsSync(join(set, 'set.json'))) {
    console.error('usage: node bench/start-runs.ts <set dir with set.json> [flags]');
    process.exit(2);
  }
  const repeats = Number(values.repeats);
  const parallel = Number(values.parallel);
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('--repeats must be a positive integer');
  if (!Number.isInteger(parallel) || parallel < 1) throw new Error('--parallel must be a positive integer');
  const graph = values.graph && resolve(values.graph);
  const bench: typeof BenchModule = await import('../bin/bench.ts');
  const picked = list(values.cases);
  const cases = (
    JSON.parse(readFileSync(join(set, 'set.json'), 'utf8')) as {
      cases: { id: string; repo: string; split?: string; use?: boolean }[];
    }
  ).cases.filter(c => (c.split !== 'gate' || c.use) && (!picked.length || picked.includes(c.id)));
  const wanted = list(values.points).flatMap(point =>
    Array.from({ length: repeats }, (_, i) => i + 1).flatMap(repeat =>
      cases.flatMap(c => list(values.arms).map(arm => ({ c, arm, point, repeat })))
    )
  );
  const judged = values.judges !== 'none';
  const labels = parseLabels(parseLabelPatch(values.label));
  const findLeft = (slots = readBenchSlots(set)) =>
    wanted.filter(
      u =>
        !isBenchRunDone(
          set,
          bench.makeBenchInput(u.c, u.arm, u.repeat, { point: u.point, graph, labels }),
          judged,
          slots
        )
    );
  const slots = readBenchSlots(set);
  const queue = findLeft(slots);
  log(`planned ${wanted.length}, on disk ${wanted.length - queue.length}, starting ${queue.length}`);
  const done = wanted.flatMap(u => {
    const input = bench.makeBenchInput(u.c, u.arm, u.repeat, { point: u.point, graph, labels });
    const found = input.point && !queue.includes(u) && readSlotRun(set, input, slots);
    return found ? [{ point: u.point, versions: found.run.versions }] : [];
  });
  if (done.length)
    await Effect.runPromise(readCurrentVersions).then(
      now => formatStaleSlots(done, now).forEach(line => log(line)),
      (e: unknown) => log(`1 skipped stale slot check: ${String(e).slice(0, 300)}`)
    );
  if (values.dry) process.exit(0);
  const lock = join(set, 'start-runs');
  if (!claim(lock)) {
    log(`another start-runs works on ${set} as pid ${readFileOrEmpty(`${lock}.lock`)}`);
    process.exit(1);
  }
  onStop(() => release(lock));
  try {
    bench.readBenchKeys(values.keys ?? join(import.meta.dirname, '../infra/local/.keys.env'));
    const unready = (await Promise.all([...new Set(queue.map(u => u.point))].map(bench.whyPointUnready))).filter(
      Boolean
    );
    if (unready.length) throw new Error(`points not ready:\n${unready.join('\n')}`);
    const orKey = values.orenv ? parseEnv(readFileOrEmpty(values.orenv)).OPENROUTER_API_KEY : undefined;
    const usage = async () => {
      const r = await fetch('https://openrouter.ai/api/v1/credits', {
        headers: { authorization: `Bearer ${orKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      const d = ((await r.json()) as { data?: { total_usage?: number } }).data;
      if (typeof d?.total_usage !== 'number') throw new Error(`credits answered ${r.status} without usage`);
      return d.total_usage;
    };
    const spend =
      values.cap === undefined ? undefined : await spendGuard(Number(values.cap), Number(values.per), usage);
    const env = { ...process.env, NODE_OPTIONS: '' };
    mkdirSync(join(set, 'logs'), { recursive: true });
    const paid = [
      '--max-codex',
      values['max-codex'],
      '--max-claude-calls',
      values['max-claude-calls'],
      ...(values.keys ? ['--keys', resolve(values.keys)] : []),
    ];
    const runOne = async (u: (typeof wanted)[number]) => {
      const name = `${u.c.id}-${u.arm}-${u.point.replace(':', '-')}-r${u.repeat}`;
      const caseDir = join(set, 'cases', u.c.id);
      const slot = [
        '--point',
        u.point,
        '--repeat',
        String(u.repeat),
        '--repo',
        join(values.repos, u.c.repo.split('/').pop()!),
        ...(graph ? ['--graph', graph] : []),
        ...values.label.flatMap(l => ['--label', l]),
      ];
      const step = (command: string, ...more: string[]) =>
        runLogged(
          [join(import.meta.dirname, '../bin/bench.ts'), command, u.arm, caseDir, set, ...slot, ...paid, ...more],
          join(set, 'logs', `${name}.log`),
          env,
          log
        );
      const gate = await step('score');
      if (gate) return `gate score exit ${gate}`;
      if (isBenchCaseValid(set, u.c.id) === false) return undefined;
      const ran = await step('run');
      if (ran) return `run exit ${ran}`;
      const scored = await step('score');
      if (scored) return `score exit ${scored}`;
      if (!judged) return undefined;
      const judging = await step('judge', '--judges', values.judges);
      return judging ? `judge exit ${judging}` : undefined;
    };
    const failed: string[] = [];
    const stopped = await runQueue(
      queue,
      parallel,
      async u => {
        const name = `${u.c.id}/${u.arm}/${u.point}/r${u.repeat}`;
        log(`start ${name} (queued ${queue.length})`);
        const why = await runOne(u).catch((e: unknown) => `error ${String(e).slice(0, 300)}`);
        if (why) failed.push(name);
        else spend?.finished();
        log(why ? `${name} not done: ${why}` : `done ${name}`);
      },
      async active => spend?.check(active)
    );
    if (stopped) log(`stop: ${stopped}`);
    const left = findLeft().length;
    log(
      `finished: ${wanted.length - left}/${wanted.length} done${failed.length ? `, failed: ${failed.join(', ')}` : ''}`
    );
    process.exitCode = left ? 1 : 0;
  } finally {
    release(lock);
  }
}
