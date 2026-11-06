import { constants, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Effect } from 'effect';
import { readEnvRefs, writeEnvRefs } from '../src/disk.ts';
import { readRunLabels, writeRunLabels } from '../src/labels.ts';
import { getRunOrigin } from '../src/meta.ts';
import { writeFileAtomic } from '../src/store.ts';
import type { RunRecord } from '../src/workflow.ts';
import { readBenchRun, type BenchInput } from './runs.ts';

const clone = { recursive: true, mode: constants.COPYFILE_FICLONE };
const kept = new Set(['graph', 'tracker', 'issue.md', 'change.patch']);

const readNames = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter(n => !n.startsWith('.')) : []);

export const readFlatSetPlan = (set: string) => {
  const problems: string[] = [];
  const attempts = readNames(join(set, 'runs'))
    .toSorted()
    .flatMap(slot => {
      const ks = readNames(join(set, 'runs', slot))
        .filter(k => /^\d+$/.test(k))
        .toSorted((a, b) => Number(a) - Number(b));
      const found = ks.map(k => {
        const from = join(set, 'runs', slot, k);
        const runs = readNames(join(from, 'data')).flatMap(id => {
          const run = readBenchRun(join(from, 'data'), id);
          return run ? [run] : [];
        });
        return { slot, from, runs };
      });
      for (const run of found.flatMap(f => f.runs))
        if (!getRunOrigin(run.meta)) problems.push(`${slot}: run ${run.id} has no origin`);
      const input = found
        .flatMap(f => f.runs)
        .map(run => getRunOrigin(run.meta)?.input as BenchInput | null | undefined)
        .find(i => i?.case !== undefined);
      if (!input) problems.push(`${slot}: no run carries its bench input`);
      return input ? found.map(f => ({ ...f, input })) : [];
    })
    .map((a, i) => ({ ...a, attempt: i + 1 }));
  const ids = Map.groupBy(
    attempts.flatMap(a => a.runs.map(run => ({ id: run.id, from: a.from }))),
    r => r.id
  );
  for (const [id, rs] of ids) if (rs.length > 1) problems.push(`run ${id} is in ${rs.map(r => r.from).join(' and ')}`);
  if (existsSync(join(set, 'attempts')) || existsSync(join(set, 'data')))
    problems.push(`${set} already has attempts/ or data/`);
  return { attempts, problems };
};

export const writeFlatSet = async (set: string, plan: ReturnType<typeof readFlatSetPlan>) => {
  const out = join(set, '.flatten');
  rmSync(out, { recursive: true, force: true });
  const data = join(out, 'data');
  mkdirSync(data, { recursive: true });
  for (const a of plan.attempts) {
    const at = join(out, 'attempts', String(a.attempt));
    mkdirSync(at, { recursive: true });
    for (const name of readNames(a.from).filter(n => kept.has(n))) cpSync(join(a.from, name), join(at, name), clone);
    if (existsSync(join(a.from, 'data', 'mirror.git')))
      cpSync(join(a.from, 'data', 'mirror.git'), join(at, 'mirror.git'), clone);
    const pinned = { ...a.input, attempt: a.attempt };
    writeFileAtomic(join(at, 'input.json'), pinned);
    for (const run of a.runs) {
      const to = join(data, run.id);
      cpSync(join(a.from, 'data', run.id), to, clone);
      const origin = getRunOrigin(run.meta);
      const input = { ...(origin?.input as object), attempt: a.attempt };
      rmSync(join(to, 'run.json.zst'), { force: true });
      writeFileAtomic(join(to, 'run.json'), {
        ...run,
        meta: { ...run.meta, engine: { ...(run.meta?.engine as object), origin: { ...origin, input } } },
      } satisfies RunRecord);
      const labels = readRunLabels(data, run.id);
      await Effect.runPromise(
        writeRunLabels(data, run.id, {
          attempt: String(a.attempt),
          ...(!labels.set && { set: basename(set) }),
        })
      );
    }
    const logs = join(a.from, 'data', 'logs');
    for (const name of existsSync(logs) ? readdirSync(logs) : [])
      if (!existsSync(join(data, 'logs', name))) cpSync(join(logs, name), join(data, 'logs', name), clone);
    writeEnvRefs(data, readEnvRefs(join(a.from, 'data')));
  }
  mkdirSync(join(out, 'attempts'), { recursive: true });
  renameSync(join(out, 'attempts'), join(set, 'attempts'));
  renameSync(data, join(set, 'data'));
  rmSync(out, { recursive: true, force: true });
};

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { dry: { type: 'boolean' } } });
  if (!positionals.length) {
    console.error('usage: node bench/flatten.ts <set>... [--dry]');
    process.exit(2);
  }
  for (const set of positionals.map(p => resolve(p))) {
    const plan = readFlatSetPlan(set);
    const runs = plan.attempts.reduce((n, a) => n + a.runs.length, 0);
    console.log(`${set}: ${plan.attempts.length} attempts, ${runs} runs from runs/ into attempts/ and data/`);
    for (const p of plan.problems) console.log(`  ${p}`);
    if (plan.problems.length) process.exitCode = 1;
    else if (!values.dry) await writeFlatSet(set, plan);
  }
}
