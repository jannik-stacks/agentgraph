// node bench/drive.ts [resume] <dir>: runs every case of <dir>/set.json on v2 and floor at each point and repeat,
// through bin/bench.ts of the engine checked out at <dir>/<SHA>/engine. Layout as bin/bench-run.ts:
// <dir>/<sha>/<harness>-<model>/r<k>. The first start records its settings in drive.json; `resume <dir>` needs none.
// Live knobs in <dir>: `parallel` (worker count), `PAUSE` (take no new job). events.jsonl logs every start, stop,
// pause and job. Exits 1 while jobs are left, so a queue tries again later.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { append, busy, claim, jsonl, onStop, pin, release, sleep, write } from '../bin/resume.ts';

/** The node on PATH now, so a toolchain upgrade during a long bench does not break later spawns. */
export const nodePath = (fallback = process.execPath) =>
  spawnSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout?.trim() || fallback;

const children = new Set<ChildProcess>();

/** Runs `args` with node into `logFile`; a spawn or log write error ends it with exit 1 instead of the driver. */
export const runLogged = (
  args: string[],
  logFile: string,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void = console.error
) =>
  new Promise<number>(done => {
    const stream = createWriteStream(logFile, { flags: 'a' });
    stream.on('error', e => log(`log ${logFile}: ${e.message}`));
    stream.write(`\n### ${new Date().toISOString()} ${args.slice(1, 3).join(' ')}\n`);
    const child = spawn(nodePath(), args, { env });
    children.add(child);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    child.on('error', e => {
      log(`spawn: ${e.message}`);
      children.delete(child);
      stream.end();
      done(1);
    });
    child.on('close', code => {
      children.delete(child);
      stream.end();
      done(code ?? 1);
    });
  });

const read = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};
const json = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

/** Settings that give a dir's results their meaning, fixed after the first start. */
const fixed = ['SHA', 'POINTS', 'REPEATS', 'REPEAT', 'JUDGES', 'KEYS', 'SET', 'ENGINE', 'REPOS'];
/** Budgets, kept too, that a resume may change. */
const budgets = ['MAX_CODEX', 'CAP', 'PER', 'ORENV'];
type Settings = Record<string, string>;

const pick = (from: Record<string, string | undefined>, keys: string[]) => {
  const { POINT, ...rest } = from;
  const all: Record<string, string | undefined> = { ...rest, ...(POINT && !rest.POINTS && { POINTS: POINT }) };
  return Object.fromEntries(keys.flatMap(k => (all[k] === undefined ? [] : [[k, all[k]!]]))) as Settings;
};

/** The env assignments of a dir's overnight queue, for a dir started before drive.json. */
const queued = (dir: string) =>
  Object.fromEntries(
    read(join(dir, 'queue.txt'))
      .split('\n')
      .filter(l => !l.trimStart().startsWith('#'))
      .flatMap(l => [...l.matchAll(/\b([A-Z_]+)=(\S+)/g)].map(m => [m[1]!, m[2]!]))
  ) as Settings;

const defaults = (dir: string, sha = '') => ({
  POINTS: 'opencode:luna',
  REPEATS: '3',
  JUDGES: 'opus:1,sonnet:2',
  SET: basename(dir),
  ENGINE: ['agentgraph', 'bothub'].map(n => join(dir, sha, 'engine', n)).find(p => existsSync(p)) ?? '',
  REPOS: join(process.env.HOME ?? '', 'bothub-data/tune/repos'),
});

/** The settings `dir` was driven with, from drive.json or its queue, without writing anything. */
export const recorded = (dir: string): Settings => {
  const was = existsSync(join(dir, 'drive.json'))
    ? json<Settings>(join(dir, 'drive.json'), {})
    : pick(queued(dir), [...fixed, ...budgets]);
  return { ...defaults(dir, was.SHA), ...was };
};

/**
 * Records and answers the settings to drive `dir` with. Given fixed settings must match the record; given budgets
 * replace it.
 */
export const configure = (dir: string, env: Record<string, string | undefined> = process.env) => {
  const file = join(dir, 'drive.json');
  const was = existsSync(file) ? json<Settings>(file, {}) : pick(queued(dir), [...fixed, ...budgets]);
  const given = pick(env, fixed);
  const sha = given.SHA ?? was.SHA;
  if (!sha) throw new Error(`no SHA for ${dir}: start it with SHA=<engine commit>`);
  write(file, { ...was, ...pick(env, budgets) });
  return pin(file, given, defaults(dir, sha));
};

type Entry = { id: string; repo: string; split?: string; use?: boolean };
type Job = { point: string; k: number; c: Entry };
const arms = ['v2', 'floor'];

export const jobsOf = (dir: string, s: Settings): Job[] => {
  const cases = json<{ cases: Entry[] }>(join(dir, 'set.json'), { cases: [] }).cases.filter(
    c => c.split !== 'gate' || c.use
  );
  const points = s.POINTS!.split(',').map(p => (p.includes(':') ? p : `opencode:${p}`));
  const repeats = s.REPEAT ? [Number(s.REPEAT)] : Array.from({ length: Number(s.REPEATS) }, (_, i) => i + 1);
  return points.flatMap(point => repeats.flatMap(k => cases.map(c => ({ point, k, c }))));
};

const slot = (j: Job) => j.point.replace(':', '-');
export const runDir = (dir: string, s: Settings, j: Job) => join(dir, s.SHA!, slot(j), `r${j.k}`);
const nameOf = (j: Job) => `${slot(j)}/r${j.k}/${j.c.id}`;
const marker = (dir: string, j: Job) => join(dir, 'done', slot(j), `r${j.k}`, j.c.id);
/** Done markers older drivers wrote: by engine for one point, by model for several. */
const markers = (dir: string, s: Settings, j: Job) => [
  marker(dir, j),
  ...(s.POINTS!.includes(',') ? [] : [join(dir, 'done', s.SHA!, `r${j.k}`, j.c.id)]),
  join(dir, 'done', j.point.split(':')[1]!, `r${j.k}`, j.c.id),
];

/**
 * Whether a job's results are all on disk: its case is invalid, or both arms ran and were scored, and, when a panel
 * judges, a done marker says it judged them.
 */
export const finished = (dir: string, s: Settings, j: Job) => {
  const at = join(runDir(dir, s, j), j.c.id);
  const valid = json<{ invalid?: string } | null>(join(at, 'valid.json'), null);
  if (!valid) return false;
  if (valid.invalid) return true;
  if (!arms.every(a => existsSync(join(at, a, 'diff.patch')) && existsSync(join(at, a, 'score.json')))) return false;
  return s.JUDGES === 'none' || markers(dir, s, j).some(m => json(m, { judged: false }).judged !== false);
};

/** Where a driven bench dir stands, for the studio and `status`. */
export type DriveState = {
  dir: string;
  status: 'running' | 'paused' | 'stopped' | 'crashed' | 'finished';
  reason?: string | undefined;
  at?: string | undefined;
  done: number;
  total: number;
  partial: number;
};

export const stateOf = (dir: string): DriveState => {
  const s = recorded(dir);
  const jobs = s.SHA ? jobsOf(dir, s) : [];
  const done = jobs.filter(j => finished(dir, s, j)).length;
  const partial = jobs.filter(j => !finished(dir, s, j) && existsSync(join(runDir(dir, s, j), j.c.id))).length;
  const base = { dir, done, total: jobs.length, partial };
  const last = jsonl<{ event: string; at: string; reason?: string; error?: string }>(join(dir, 'events.jsonl'))
    .filter(e => !String(e.event).startsWith('job') && e.event !== 'busy')
    .at(-1);
  const paused = existsSync(join(dir, 'PAUSE'));
  if (busy(join(dir, 'drive')))
    return { ...base, status: paused ? 'paused' : 'running', ...(paused && { reason: 'PAUSE file' }), at: last?.at };
  if (jobs.length && done === jobs.length) return { ...base, status: 'finished', at: last?.at };
  if (paused) return { ...base, status: 'paused', reason: 'PAUSE file, driver not running', at: last?.at };
  if (!last) {
    const stop = read(join(dir, 'drive.log'))
      .split('\n')
      .filter(l => / stop: /.test(l))
      .at(-1);
    return {
      ...base,
      status: 'stopped',
      reason: stop?.split(' stop: ')[1] ?? 'no driver events',
      at: stop?.split(' ')[0],
    };
  }
  if (last.event === 'stop' || last.event === 'finish')
    return { ...base, status: 'stopped', reason: last.reason, at: last.at };
  if (last.event === 'crash') return { ...base, status: 'crashed', reason: last.error, at: last.at };
  return {
    ...base,
    status: 'crashed',
    reason: 'the driver died without a stop: killed, or the machine restarted',
    at: last.at,
  };
};

if (import.meta.main) {
  const dir = resolve(process.argv.slice(2).find(a => a !== 'resume') ?? process.env.OUT ?? '');
  if (!existsSync(join(dir, 'set.json'))) {
    console.error('usage: node bench/drive.ts [resume] <dir with set.json>');
    process.exit(2);
  }
  const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
  const event = (name: string, more: object = {}) =>
    append(join(dir, 'events.jsonl'), { at: new Date().toISOString(), event: name, ...more });
  const lock = join(dir, 'drive');
  const tick = Number(process.env.DRIVE_TICK) || 15_000;
  if (!claim(lock)) {
    const pid = Number(read(`${lock}.lock`));
    log(`another driver runs ${dir} as pid ${pid}`);
    event('busy', { pid: process.pid, holder: pid });
    process.exit(1);
  }
  try {
    const s = configure(dir);
    const engine = s.ENGINE!;
    if (!existsSync(join(engine, 'bin/bench.ts')))
      throw new Error(`no engine at ${engine || join(dir, s.SHA!, 'engine')}`);
    const judges = s.JUDGES!;
    const maxCodex = s.MAX_CODEX ? Number(s.MAX_CODEX) : undefined;
    const cap = s.CAP ? Number(s.CAP) : undefined;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_OPTIONS: '',
      BENCH_ENGINE: engine,
      BENCH_CACHE: join(dir, '.cache'),
    };
    for (const v of ['BENCH_PATH', 'BENCH_FRESH', 'BENCH_HUB', 'BENCH_POINT']) delete env[v];
    const bench = (args: string[], logFile: string) =>
      runLogged([join(engine, 'bin/bench.ts'), ...args, ...(s.KEYS ? ['--keys', s.KEYS] : [])], logFile, env, log);

    const jobs = jobsOf(dir, s);
    const total = jobs.length;
    const done = () => jobs.filter(j => finished(dir, s, j)).length;
    const queue = jobs.filter(j => !finished(dir, s, j));
    const dirs = [...new Set(jobs.map(j => runDir(dir, s, j)))];
    const several = s.POINTS!.includes(',');

    const budgetLog = join(dir, 'budget-log.jsonl');
    const seen = new Set(jsonl<{ label?: string }>(budgetLog).map(l => l.label));
    const { codexUsed } =
      maxCodex === undefined
        ? { codexUsed: () => undefined }
        : ((await import(join(engine, 'bin/bench.ts'))) as { codexUsed: () => number | undefined });
    const reading = (label: string) => {
      const now = codexUsed();
      append(budgetLog, { at: new Date().toISOString(), label, codex: now });
      seen.add(label);
      log('codex', label, now);
      return now;
    };
    const budget = (at: string) => json<{ now?: number; at?: string; start?: number }>(join(at, 'budget.json'), {});
    const latest = () =>
      dirs
        .map(budget)
        .filter(b => b.now !== undefined)
        .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))[0]?.now;

    const orKey = s.ORENV
      ? read(s.ORENV)
          .split('\n')
          .find(l => l.startsWith('OPENROUTER_API_KEY='))
          ?.slice(19)
          .trim()
          .replace(/^"|"$/g, '')
      : undefined;
    let usage: { at: number; total?: number } = { at: 0 };
    const spent = async () => {
      if (Date.now() - usage.at < 60_000) return usage.total;
      try {
        const r = await fetch('https://openrouter.ai/api/v1/credits', {
          headers: { authorization: `Bearer ${orKey}` },
        });
        const d = ((await r.json()) as { data: { total_usage: number; total_credits: number } }).data;
        usage = { at: Date.now(), total: d.total_usage };
        append(budgetLog, {
          at: new Date().toISOString(),
          label: 'spend',
          usage: d.total_usage,
          credits: d.total_credits,
        });
      } catch (e) {
        log('spend read failed', String(e));
      }
      return usage.total;
    };

    let active = 0;
    let started = 0;
    const partial = queue.filter(j => existsSync(join(runDir(dir, s, j), j.c.id))).map(nameOf);
    const again = jsonl<{ event: string }>(join(dir, 'events.jsonl')).some(e => ['start', 'resume'].includes(e.event));
    event(again || existsSync(join(dir, 'drive.log')) ? 'resume' : 'start', {
      pid: process.pid,
      done: total - queue.length,
      total,
      partial,
      settings: s,
    });
    log(`${total - queue.length}/${total} done, ${partial.length} partial: ${partial.join(', ') || 'none'}`);
    onStop(signal => {
      event('stop', { reason: `signal ${signal}`, done: done(), total, active });
      for (const child of children) child.kill('SIGTERM');
      release(lock);
    });

    const tree = (path: string) =>
      spawnSync('git', ['-C', engine, 'rev-parse', `HEAD:./${path}`], { encoding: 'utf8' }).stdout.trim();
    const hubs = { v2: tree('examples'), floor: tree('bench/floor') };
    for (const j of jobs) {
      const at = runDir(dir, s, j);
      if (existsSync(join(at, 'point.json'))) continue;
      const [harness, model] = j.point.split(':');
      write(join(at, 'point.json'), {
        harness,
        model,
        engine: s.SHA,
        hubs,
        set: s.SET,
        repeat: j.k,
        at: new Date().toISOString(),
      });
    }
    const first = maxCodex === undefined ? undefined : reading(seen.has('start') ? 'restart' : 'start');
    // The bench guard counts points over a dir's first reading; this keeps its stop at MAX_CODEX absolute.
    const codexCap = (at: string) =>
      maxCodex === undefined ? '100' : String(Math.max(0, maxCodex - (budget(at).start ?? first ?? maxCodex - 10)));
    const startUsage = cap === undefined ? undefined : await spent();
    const perJob = (now: number) =>
      Math.max(Number(s.PER ?? 0.3), started && startUsage !== undefined ? (now - startUsage) / started : 0);

    const overBudget = async () => {
      const codex = maxCodex === undefined ? undefined : latest();
      if (maxCodex !== undefined && codex !== undefined && codex > maxCodex)
        return `Codex weekly ${codex}% is over ${maxCodex}%`;
      if (cap === undefined) return undefined;
      const now = await spent();
      if (now === undefined) return 'OpenRouter usage unreadable';
      if (now + (active + 1) * perJob(now) > cap)
        return `usage $${now.toFixed(2)} with ${active} in flight at ~$${perJob(now).toFixed(2)} a job would pass $${cap}`;
      return undefined;
    };

    const runJob = async (j: Job): Promise<string | undefined> => {
      const at = runDir(dir, s, j);
      const id = j.c.id;
      while (arms.some(a => busy(join(at, id, a)))) await sleep(tick);
      mkdirSync(join(dir, 'logs'), { recursive: true });
      const logFile = join(dir, 'logs', `${several ? `${j.point.split(':')[1]}-` : ''}r${j.k}-${id}.log`);
      const caseDir = join(dir, 'cases', id);
      const common = [caseDir, at, '--repo', join(s.REPOS!, j.c.repo.split('/').pop()!)];
      const paid = ['--max-codex', codexCap(at), '--max-claude-calls', '400'];
      const t0 = Date.now();
      await bench(['score', ...common], logFile);
      const valid = json<{ invalid?: string } | null>(join(at, id, 'valid.json'), null);
      if (!valid) return 'no validity: the first score failed';
      if (valid.invalid) log(`${nameOf(j)} invalid: ${valid.invalid}`);
      else {
        for (const arm of arms) {
          const code = await bench(
            ['run', arm, ...common, '--point', j.point, '--repeat', String(j.k), ...paid],
            logFile
          );
          log(`${nameOf(j)} ${arm} exit ${code}`);
        }
        const missing = arms.filter(arm => !existsSync(join(at, id, arm, 'diff.patch')));
        if (missing.length) return `no ${missing.join(', ')} diff`;
        const scored = await bench(['score', ...common], logFile);
        if (scored) return `score exit ${scored}`;
        if (judges !== 'none') {
          const judged = await bench(['judge', caseDir, at, '--judges', judges, '--pairs', 'human', ...paid], logFile);
          if (judged) return `judge exit ${judged}`;
        }
      }
      write(marker(dir, j), { min: Math.round((Date.now() - t0) / 60000), judged: judges !== 'none' });
      return undefined;
    };

    const milestones = [0.25, 0.5, 0.75, 1].map(f => Math.ceil(f * total));
    const failed: string[] = [];
    let stopped: string | undefined;
    let paused = false;
    const width = () => Number(read(join(dir, 'parallel')).trim()) || 3;
    await new Promise<void>((finish, fail) => {
      const step = async () => {
        if (existsSync(join(dir, 'PAUSE')) !== paused) {
          paused = !paused;
          event(paused ? 'pause' : 'unpause', { done: done(), total, active });
          log(paused ? 'paused: PAUSE is set, no new job starts' : 'PAUSE removed, going on');
        }
        while (!stopped && !paused && active < width() && queue.length) {
          stopped = await overBudget();
          if (stopped) {
            log(`stop: ${stopped}`);
            break;
          }
          const j = queue.shift()!;
          if (finished(dir, s, j)) continue;
          active++;
          started++;
          event('job-start', { job: nameOf(j), active, load: loadavg()[0] });
          log(`start ${nameOf(j)} (active ${active}, queued ${queue.length})`);
          const t0 = Date.now();
          void runJob(j)
            .catch((e: unknown) => `error ${String(e).slice(0, 300)}`)
            .then(why => {
              active--;
              const min = Math.round((Date.now() - t0) / 60000);
              if (why) {
                failed.push(nameOf(j));
                event('job-fail', { job: nameOf(j), reason: why, min, active });
                return log(`${nameOf(j)} not done: ${why}`);
              }
              const n = done();
              event('job-done', { job: nameOf(j), min, done: n, total, active });
              log(`done ${n}/${total}`);
              if (maxCodex !== undefined)
                for (const m of milestones)
                  if (n >= m && !seen.has(`done ${m}/${total}`)) reading(`done ${m}/${total}`);
            });
        }
        if (active === 0 && (stopped || !queue.length)) return finish();
        setTimeout(() => void step().catch(fail), tick);
      };
      step().catch(fail);
    });
    for (const at of dirs) await bench(['report', at], join(dir, 'logs', `report-${basename(at)}.log`));
    if (maxCodex !== undefined) reading('end');
    const n = done();
    if (n === total) event('finish', { done: n, total });
    else
      event('stop', {
        reason: stopped ?? `${failed.length} jobs failed: resume to retry them`,
        done: n,
        total,
        failed,
      });
    log(`finished: ${n}/${total} done`);
    process.exitCode = n === total ? 0 : 1;
  } catch (e) {
    event('crash', { error: String(e).slice(0, 500) });
    throw e;
  } finally {
    release(lock);
  }
}
