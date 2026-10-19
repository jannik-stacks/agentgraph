/**
 * One command for a bench run at an engine commit.
 * Usage: node bin/bench-run.ts --at <sha> [--set smoke] [--fresh] [--cases-dir <dir>] [--repos-dir <dir>] [--out runs] [--parallel 3]
 * Checks the commit out as a git worktree, runs the set's cases (validity, v2, floor, score, judge) with that engine,
 * and writes <out>/<sha>/report.md and compare.md against the newest earlier report. Results are reused through
 * <out>/.cache unless --fresh; see docs/bench.md.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const git = (...args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });

/** The headline numbers of a report: table rows with a numeric last cell, keyed by section and first cell. */
export const numbers = (report: string) => {
  const out: Record<string, string> = {};
  let section = '';
  for (const line of report.split('\n')) {
    if (line.startsWith('## ')) break;
    if (/^[A-Z]/.test(line) && !line.startsWith('|')) section = line.trim();
    const cells = line
      .split('|')
      .slice(1, -1)
      .map(c => c.trim());
    if (cells.length > 1 && /^[\w./ -]+$/.test(cells[0]!) && cells[0] !== 'arm' && !/^-+$/.test(cells[0]!))
      out[`${section} / ${cells[0]}`] = cells.slice(1).join(' | ');
  }
  return out;
};

/** What changed between two reports' headline numbers, one line each. */
export const compare = (before: string, now: string) => {
  const [a, b] = [numbers(before), numbers(now)];
  return Object.keys({ ...a, ...b })
    .filter(k => a[k] !== b[k])
    .map(k => `- ${k}: ${a[k] ?? 'none'} -> ${b[k] ?? 'none'}`);
};

const run = (args: string[], env: Record<string, string>) =>
  new Promise<number>(done => {
    const child = spawn(process.execPath, [join(root, 'bin/bench.ts'), ...args], {
      stdio: 'inherit',
      env: { ...process.env, ...env, NODE_OPTIONS: '' },
    });
    child.on('close', code => done(code ?? 1));
  });

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      at: { type: 'string' },
      set: { type: 'string', default: 'smoke' },
      fresh: { type: 'boolean', default: false },
      'cases-dir': { type: 'string', default: process.env.BENCH_CASES },
      'repos-dir': { type: 'string', default: process.env.BENCH_REPOS },
      out: { type: 'string', default: 'runs' },
      parallel: { type: 'string', default: '3' },
      judges: { type: 'string' },
    },
  });
  if (!values.at || !values['cases-dir'] || !values['repos-dir'])
    throw new Error('usage: --at <sha> --cases-dir <dir> --repos-dir <dir> (or BENCH_CASES, BENCH_REPOS)');
  const sha = git('rev-parse', '--short=12', values.at).stdout.trim();
  if (!sha) throw new Error(`unknown commit ${values.at}`);
  const out = resolve(values.out!);
  const dir = join(out, sha);
  const worktree = join(dir, 'engine');
  if (!existsSync(worktree)) {
    mkdirSync(dir, { recursive: true });
    const made = git('worktree', 'add', '--detach', worktree, sha);
    if (made.status) throw new Error(made.stderr);
    const modules = join(worktree, basename(root), 'node_modules');
    if (!existsSync(modules)) symlinkSync(join(root, 'node_modules'), modules);
  }
  const set = JSON.parse(readFileSync(join(root, 'bench/sets', `${values.set}.json`), 'utf8')) as {
    cases: { id: string; repo: string; base: string }[];
  };
  const env = {
    BENCH_ENGINE: join(worktree, basename(root)),
    BENCH_CACHE: join(out, '.cache'),
    ...(values.fresh && { BENCH_FRESH: '1' }),
  };
  const queue = [...set.cases];
  const next = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const caseDir = join(values['cases-dir']!, c.id);
      const pinned = JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8')) as { base: string };
      if (pinned.base !== c.base) {
        console.error(`${c.id}: base ${pinned.base} is not the set's ${c.base}, skipped`);
        continue;
      }
      const common = [caseDir, dir, '--repo', join(values['repos-dir']!, basename(c.repo))];
      for (const arm of ['v2', 'floor']) await run(['run', arm, ...common], env);
      await run(['score', ...common], env);
      await run(['judge', caseDir, dir, ...(values.judges ? ['--judges', values.judges] : [])], env);
    }
  };
  await Promise.all(Array.from({ length: Number(values.parallel) }, next));
  await run(['report', dir], env);
  const earlier = readdirSync(out, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== sha && existsSync(join(out, e.name, 'report.md')))
    .map(e => join(out, e.name, 'report.md'))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (earlier) {
    const lines = compare(readFileSync(earlier, 'utf8'), readFileSync(join(dir, 'report.md'), 'utf8'));
    writeFileSync(
      join(dir, 'compare.md'),
      `# Compared with ${basename(join(earlier, '..'))}\n\n${lines.length ? lines.join('\n') : 'No headline number changed.'}\n`
    );
  }
}
