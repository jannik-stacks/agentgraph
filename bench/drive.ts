// node bench/drive.ts: runs every case of <OUT>/set.json on v2 and floor at one point, REPEATS times, through
// bin/bench.ts of the engine checked out at <OUT>/<SHA>/engine/agentgraph (ENGINE overrides it).
// Layout as bin/bench-run.ts: <out>/<sha>/<harness>-<model>/r<k>. Every score runs in the case's env container.
// Live knobs in <out>: `parallel` (worker count), `PAUSE` (take no new job). Done jobs leave done/<sha>/r<k>/<id>.
// Each job is judged as it finishes with JUDGES (default opus:1,sonnet:2, human pairs only); JUDGES=none skips it,
// and a later run with a panel judges only the jobs not yet judged.
// jobs.jsonl records every job's start and end with the active count and host load.
// Exits 1 while jobs are left (the Codex cap), so a queue tries again later.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { basename, join } from 'node:path';

/** The node on PATH now, so a toolchain upgrade during a long bench does not break later spawns. */
export const nodePath = (fallback = process.execPath) =>
  spawnSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout?.trim() || fallback;

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
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    child.on('error', e => {
      log(`spawn: ${e.message}`);
      stream.end();
      done(1);
    });
    child.on('close', code => {
      stream.end();
      done(code ?? 1);
    });
  });

if (import.meta.main) {
  const out = process.env.OUT!;
  const sha = process.env.SHA!;
  const point = process.env.POINT ?? 'opencode:luna';
  const repeats = Number(process.env.REPEATS ?? 3);
  const maxCodex = Number(process.env.MAX_CODEX ?? 45);
  const judges = process.env.JUDGES ?? 'opus:1,sonnet:2';
  const engine = process.env.ENGINE ?? join(out, sha, 'engine', 'agentgraph');
  const setName = process.env.SET ?? basename(out);
  const keys = process.env.KEYS ?? '';
  const [harness, model] = point.split(':');
  type Entry = { id: string; repo: string; split?: string; use?: boolean };
  const set = (JSON.parse(readFileSync(join(out, 'set.json'), 'utf8')) as { cases: Entry[] }).cases.filter(
    c => c.split !== 'gate' || c.use
  );
  const repoDir = (repo: string) => join(process.env.HOME ?? '', 'bothub-data/tune/repos', repo.split('/').pop()!);
  const dirOf = (k: number) => join(out, sha, `${harness}-${model}`, `r${k}`);
  const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: '',
    BENCH_ENGINE: engine,
    BENCH_CACHE: join(out, '.cache'),
  };
  for (const v of ['BENCH_PATH', 'BENCH_FRESH', 'BENCH_HUB', 'BENCH_POINT']) delete env[v];
  const bench = (args: string[], logFile: string) =>
    runLogged([join(engine, 'bin/bench.ts'), ...args, '--keys', keys], logFile, env, log);

  const { codexUsed } = (await import(join(engine, 'bin/bench.ts'))) as { codexUsed: () => number | undefined };
  const reading = (label: string) => {
    const now = codexUsed();
    appendFileSync(
      join(out, 'budget-log.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), label, codex: now })}\n`
    );
    log('codex', label, now);
    return now;
  };
  const budget = (k: number): { now?: number; at?: string; start?: number } => {
    try {
      return JSON.parse(readFileSync(join(dirOf(k), 'budget.json'), 'utf8')) as {
        now?: number;
        at?: string;
        start?: number;
      };
    } catch {
      return {};
    }
  };
  // The newest weekly Codex reading any repeat dir's bench guard took.
  const latest = () => {
    let best: ReturnType<typeof budget> | undefined;
    for (let k = 1; k <= repeats; k++) {
      const b = budget(k);
      if (b.now !== undefined && (!best || (b.at ?? '') > (best.at ?? ''))) best = b;
    }
    return best?.now;
  };

  type Job = { k: number; c: Entry };
  const jobs: Job[] = [];
  for (let k = 1; k <= repeats; k++) for (const c of set) jobs.push({ k, c });
  const total = jobs.length;
  const marker = (j: Job) => join(out, 'done', sha, `r${j.k}`, j.c.id);
  const finished = (j: Job) => {
    try {
      const m = JSON.parse(readFileSync(marker(j), 'utf8')) as { judged?: boolean };
      return judges === 'none' || m.judged !== false;
    } catch {
      return false;
    }
  };
  const doneCount = () => jobs.filter(finished).length;
  const queue = jobs.filter(j => !finished(j));
  const milestones = [0.25, 0.5, 0.75, 1].map(f => Math.ceil(f * total));
  const seen = new Set(
    readFileSync(join(out, 'budget-log.jsonl'), { encoding: 'utf8', flag: 'a+' })
      .split('\n')
      .filter(Boolean)
      .map(l => (JSON.parse(l) as { label: string }).label)
  );
  let active = 0;
  const note = (j: Job, event: string, more = {}) =>
    appendFileSync(
      join(out, 'jobs.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), job: `r${j.k}/${j.c.id}`, event, active, load: loadavg()[0], ...more })}\n`
    );

  const runJob = async ({ k, c }: Job) => {
    const dir = dirOf(k);
    mkdirSync(join(out, 'logs'), { recursive: true });
    const logFile = join(out, 'logs', `r${k}-${c.id}.log`);
    const caseDir = join(out, 'cases', c.id);
    const common = [caseDir, dir, '--repo', repoDir(c.repo)];
    const paid = ['--max-codex', cap(k), '--max-claude-calls', '400'];
    const t0 = Date.now();
    await bench(['score', ...common], logFile);
    const validFile = join(dir, c.id, 'valid.json');
    if (!existsSync(validFile)) return log(`r${k} ${c.id} no validity, not marked done`);
    const valid = JSON.parse(readFileSync(validFile, 'utf8') || '{}') as { invalid?: string };
    if (valid.invalid) log(`r${k} ${c.id} invalid: ${valid.invalid}`);
    else {
      for (const arm of ['v2', 'floor']) {
        const code = await bench(['run', arm, ...common, '--point', point, '--repeat', String(k), ...paid], logFile);
        log(`r${k} ${c.id} ${arm} exit ${code}`);
      }
      const missing = ['v2', 'floor'].filter(arm => !existsSync(join(dir, c.id, arm, 'diff.patch')));
      if (missing.length) return log(`r${k} ${c.id} no ${missing.join(', ')} diff, not marked done`);
      const scored = await bench(['score', ...common], logFile);
      const judged =
        judges === 'none'
          ? 0
          : await bench(['judge', caseDir, dir, '--judges', judges, '--pairs', 'human', ...paid], logFile);
      log(`r${k} ${c.id} score exit ${scored} judge exit ${judged}`);
      if (scored || judged) return log(`r${k} ${c.id} not marked done`);
    }
    mkdirSync(join(out, 'done', sha, `r${k}`), { recursive: true });
    const min = Math.round((Date.now() - t0) / 60000);
    writeFileSync(marker({ k, c }), `${JSON.stringify({ min, judged: judges !== 'none' })}\n`);
    const n = doneCount();
    log(`done ${n}/${total}`);
    for (const m of milestones)
      if (n >= m && !seen.has(`done ${m}/${total}`)) {
        seen.add(`done ${m}/${total}`);
        reading(`done ${m}/${total}`);
      }
  };

  const tree = (path: string) =>
    spawnSync('git', ['-C', engine, 'rev-parse', `HEAD:./${path}`], { encoding: 'utf8' }).stdout.trim();
  const hubs = { v2: tree('examples'), floor: tree('bench/floor') };
  for (let k = 1; k <= repeats; k++) {
    const dir = dirOf(k);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, 'point.json')))
      writeFileSync(
        join(dir, 'point.json'),
        `${JSON.stringify({ harness, model, engine: sha, hubs, set: setName, repeat: k, at: new Date().toISOString() }, null, 2)}\n`
      );
  }
  const first = reading(seen.has('start') ? 'restart' : 'start');
  // The bench guard counts points over the dir's first reading; this keeps its stop at `maxCodex` absolute.
  const cap = (k: number) => String(Math.max(0, maxCodex - (budget(k).start ?? first ?? maxCodex - 10)));

  let stopped = false;
  const width = () => {
    try {
      return Number(readFileSync(join(out, 'parallel'), 'utf8').trim()) || 3;
    } catch {
      return 3;
    }
  };
  await new Promise<void>(finish => {
    const tick = () => {
      if (!stopped) {
        const now = latest();
        if (now !== undefined && now > maxCodex) {
          stopped = true;
          log(`stop: Codex weekly ${now}% is over ${maxCodex}%`);
        }
      }
      while (!stopped && !existsSync(join(out, 'PAUSE')) && active < width() && queue.length) {
        const j = queue.shift()!;
        active++;
        note(j, 'start');
        log(`start r${j.k} ${j.c.id} (active ${active}, queued ${queue.length})`);
        const t0 = Date.now();
        runJob(j)
          .catch(e => log(`r${j.k} ${j.c.id} error ${e}`))
          .finally(() => {
            active--;
            note(j, 'end', { min: Math.round((Date.now() - t0) / 60000), done: finished(j) });
          });
      }
      if (active === 0 && (stopped || !queue.length)) return finish();
      setTimeout(tick, 15_000);
    };
    tick();
  });
  for (let k = 1; k <= repeats; k++) await bench(['report', dirOf(k)], join(out, 'logs', `report-r${k}.log`));
  reading('end');
  log(`finished: ${doneCount()}/${total} done`);
  process.exitCode = doneCount() === total ? 0 : 1;
}
