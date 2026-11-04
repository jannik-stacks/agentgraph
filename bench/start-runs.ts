/**
 * Starts the bench runs a plan names and skips the ones already on disk. The plan is every case of `<set>/set.json`
 * times each arm, point and repeat; each unit gates its case on the reference runs, then runs, scores and judges its
 * slot through bin/bench.ts.
 * Usage: node bench/start-runs.ts <set> [--cases a,b] [--arms v2,floor] [--points opencode:luna] [--repeats 3]
 *        [--graph dir] [--label key=value]... [--parallel 3] [--max-codex 90] [--cap usd --per usd --orenv file]
 *        [--keys file] [--judges opus:1,sonnet:2|none] [--repos dir] [--dry]
 * Exits 1 while units are left, so a queue tries again later.
 */
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { claim, onStop, readFileOrEmpty, release, startChildProcess } from '../bin/resume.ts';
import type * as BenchModule from '../bin/bench.ts';
import { isBenchCaseValid, isBenchUnitDone } from './runs.ts';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/** The node on PATH now, so a toolchain upgrade during a long bench does not break later spawns. */
export const nodePath = (fallback = process.execPath) =>
  spawnSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout?.trim() || fallback;

/**
 * Runs `args` with node into `logFile` in its own process group; a spawn or log write error ends it with exit 1
 * instead of the driver.
 */
export const runLogged = (
  args: string[],
  logFile: string,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void = console.error
) =>
  new Promise<number>(done => {
    let failed = false;
    const stream = createWriteStream(logFile, { flags: 'a' });
    stream.on('error', e => {
      failed = true;
      log(`log ${logFile}: ${e.message}`);
      child.kill('SIGTERM');
    });
    stream.write(`\n### ${new Date().toISOString()} ${args.slice(1, 3).join(' ')}\n`);
    const child = startChildProcess(nodePath(), args, { env });
    child.stdout?.pipe(stream, { end: false });
    child.stderr?.pipe(stream, { end: false });
    child.on('error', e => {
      log(`spawn: ${e.message}`);
      stream.end(() => done(1));
    });
    child.on('close', code => stream.end(() => done(failed ? 1 : (code ?? 1))));
  });

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

type Entry = { id: string; repo: string; split?: string; use?: boolean };
type Unit = { c: Entry; arm: string; point: string; repeat: number };

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
    console.error('usage: node bench/start-runs.ts <set dir with set.json> [plan flags]');
    process.exit(2);
  }
  const repeats = Number(values.repeats);
  const parallel = Number(values.parallel);
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('--repeats must be a positive integer');
  if (!Number.isInteger(parallel) || parallel < 1) throw new Error('--parallel must be a positive integer');
  const graph = values.graph && resolve(values.graph);
  const bench: typeof BenchModule = await import('../bin/bench.ts');
  const graphHash = graph && bench.getBenchGraphHash(graph);
  const picked = list(values.cases);
  const cases = (JSON.parse(readFileSync(join(set, 'set.json'), 'utf8')) as { cases: Entry[] }).cases.filter(
    c => (c.split !== 'gate' || c.use) && (!picked.length || picked.includes(c.id))
  );
  const units = list(values.points).flatMap(point =>
    Array.from({ length: repeats }, (_, i) => i + 1).flatMap(repeat =>
      cases.flatMap(c => list(values.arms).map(arm => ({ c, arm, point, repeat })))
    )
  );
  const judged = values.judges !== 'none';
  const done = (u: Unit) =>
    isBenchUnitDone(
      set,
      { case: u.c.id, arm: u.arm, repeat: u.repeat, point: u.point, ...(graphHash && { graph: graphHash }) },
      judged
    );
  const queue = units.filter(u => !done(u));
  log(`planned ${units.length}, on disk ${units.length - queue.length}, starting ${queue.length}`);
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
    const orKey = values.orenv
      ? readFileOrEmpty(values.orenv)
          .split('\n')
          .find(l => l.startsWith('OPENROUTER_API_KEY='))
          ?.slice(19)
          .trim()
          .replace(/^"|"$/g, '')
      : undefined;
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
    const runUnit = async (u: Unit) => {
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
      const labels = values.label.flatMap(l => ['--label', l]);
      const ran = await step('run', ...labels);
      if (ran) return `run exit ${ran}`;
      const scored = await step('score');
      if (scored) return `score exit ${scored}`;
      if (!judged) return undefined;
      const judging = await step('judge', '--judges', values.judges);
      return judging ? `judge exit ${judging}` : undefined;
    };
    let active = 0;
    const failed: string[] = [];
    let stopped: string | undefined;
    await new Promise<void>(finish => {
      const next = async () => {
        while (!stopped && active < parallel && queue.length) {
          stopped = await spend?.check(active);
          if (stopped) log(`stop: ${stopped}`);
          if (stopped) break;
          const u = queue.shift()!;
          active++;
          const name = `${u.c.id}/${u.arm}/${u.point}/r${u.repeat}`;
          log(`start ${name} (active ${active}, queued ${queue.length})`);
          void runUnit(u)
            .catch((e: unknown) => `error ${String(e).slice(0, 300)}`)
            .then(why => {
              active--;
              if (why) failed.push(name);
              else spend?.finished();
              log(why ? `${name} not done: ${why}` : `done ${name}`);
              void next();
            });
        }
        if (active === 0 && (stopped || !queue.length)) finish();
      };
      void next();
    });
    const left = units.filter(u => !done(u)).length;
    log(
      `finished: ${units.length - left}/${units.length} done${failed.length ? `, failed: ${failed.join(', ')}` : ''}`
    );
    process.exitCode = left ? 1 : 0;
  } finally {
    release(lock);
  }
}
