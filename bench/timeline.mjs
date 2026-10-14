// Prints the whole story of one issue from a data directory: every run with the engine and hub that ran it, where
// its wall time went, its checks, human waits, cost and the diff each attempt left, then totals for the issue.
//   node bench/timeline.mjs DATA ISSUE [--repo OWNER/REPO]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { runSpans } from '../src/spans.ts';
import { openStore } from '../src/store.ts';

const ms = iso => Date.parse(iso);
const min = n => `${(n / 60_000).toFixed(1)}m`;
const short = (id = '') => id.slice(0, 8);

/** The hub's own `time-kinds`, read from the hub version the run recorded. */
const patternsOf = (data, hub) => {
  const file = hub && join(data, 'hubs', `${hub}.json`);
  if (!file || !existsSync(file)) return undefined;
  const yaml = JSON.parse(readFileSync(file, 'utf8'))['hub.yaml'];
  return yaml ? parse(yaml)?.['time-kinds'] : undefined;
};

/** Total length of the union of `[start, end]` intervals. */
const covered = intervals => {
  let total = 0;
  let end = -Infinity;
  for (const [s, e] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (e <= end) continue;
    total += e - Math.max(s, end);
    end = e;
  }
  return total;
};

/** The gaps between `[start, end]` intervals inside their own span. */
const gaps = intervals => {
  const out = [];
  let end;
  for (const [s, e] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (end !== undefined && s > end) out.push([end, s]);
    end = Math.max(end ?? e, e);
  }
  return out;
};

const clip = (intervals, [s, e]) =>
  intervals.map(([a, b]) => [Math.max(a, s), Math.min(b, e)]).filter(([a, b]) => b > a);

const diffOf = (data, run, outcome) => {
  const head = run.head ?? outcome?.results?.findLast(r => r.kind === 'push' && r.sha)?.sha;
  if (!run.base || !head) return undefined;
  try {
    const mirror = join(data, 'repos', `${run.event.repo}.git`);
    return execFileSync('git', ['-C', mirror, 'diff', '--shortstat', run.base, head], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
};

export const timeline = async (data, issue, repo) => {
  const store = openStore(data);
  const all = await store.list();
  const byId = new Map(all.map(r => [r.id, r]));
  const root = r => (r.parent && byId.has(r.parent) ? root(byId.get(r.parent)) : r);
  const runs = all
    .filter(r => root(r).event.number === issue && (!repo || r.event.repo === repo))
    .sort((a, b) => a.id.localeCompare(b.id));
  const out = [];
  const totals = {};
  const add = (bucket, n) => (totals[bucket] = (totals[bucket] ?? 0) + n);
  const intervals = [];
  const waits = [];
  const scripts = [];
  let cost = 0;
  let untimed = 0;
  for (const run of runs) {
    if (!run.startedAt || !run.endedAt) {
      out.push(
        `${run.id.slice(11, 19)} ${run.workflow}/${run.job} ${run.status}${run.reason ? `: ${run.reason}` : ''}`
      );
      continue;
    }
    const wall = ms(run.endedAt) - ms(run.startedAt);
    intervals.push([ms(run.startedAt), ms(run.endedAt)]);
    cost += run.costUsd ?? 0;
    const outcome = await store.outcome(run.id);
    const spans = runSpans(run, await store.events(run.id), outcome, { patterns: patternsOf(data, run.hub) });
    for (const s of spans.filter(s => s.name === 'human_wait')) waits.push([ms(s.start), ms(s.end)]);
    for (const s of spans.filter(s => s.name === 'check' && s.attributes['bothub.time.kind']))
      scripts.push([ms(s.start), ms(s.end)]);
    if (run.check) {
      add(`check: ${run.check}`, wall);
      continue;
    }
    const kinds = {};
    const inside = [];
    for (const s of spans) {
      const kind = s.attributes['bothub.time.kind'];
      if (!kind || !s.end || s.name === 'check' || s.name === 'human_wait') continue;
      if (s.attributes['bothub.timing'] === 'unknown') untimed++;
      const [a, b] = [ms(s.start), ms(s.end)];
      kinds[kind] = (kinds[kind] ?? 0) + (b - a);
      inside.push([a, b]);
    }
    kinds['startup and wrap-up'] = Math.max(0, wall - covered(inside));
    for (const [k, v] of Object.entries(kinds)) add(k, v);
    add(`job: ${run.job}`, wall);
    const engine = run.engine ? `${short(run.engine.commit) || run.engine.src}${run.engine.dirty ? '*' : ''}` : '-';
    out.push(
      [
        run.id.slice(11, 19),
        `${run.workflow}/${run.job}`,
        run.bot,
        run.attempt ? `a${run.attempt}` : '',
        `${run.status}${run.closure ? `/${run.closure}` : ''}`,
        `wall ${min(wall)}`,
        `$${(run.costUsd ?? 0).toFixed(2)}`,
        `engine ${engine} hub ${short(run.hub) || '-'}`,
        run.previous ? `prev ${run.previous.slice(11, 19)}` : '',
      ]
        .filter(Boolean)
        .join('  ')
    );
    const parts = Object.entries(kinds)
      .filter(([, v]) => v >= 1000)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${min(v)}`);
    if (parts.length) out.push(`   ${parts.join(', ')}`);
    const verdicts = outcome?.checks ?? [];
    const skipped = verdicts.filter(v => v.skipped).length;
    const checks = verdicts
      .filter(v => !v.skipped)
      .map(
        v =>
          `${v.check} ${v.blocked ? 'blocked' : v.skipped ? 'skipped' : v.pass ? 'pass' : 'fail'}${v.durationMs === undefined ? '' : ` ${(v.durationMs / 1000).toFixed(0)}s`}${v.runs?.length ? ` (${v.runs.length} runs)` : ''}`
      );
    if (skipped) checks.push(`${skipped} skipped`);
    if (checks.length) out.push(`   checks: ${checks.join(', ')}`);
    for (const s of spans.filter(s => s.name === 'ask'))
      out.push(`   asked a human ${s.attributes['bothub.url'] ?? ''}`.trimEnd());
    for (const s of spans.filter(s => s.name === 'human_wait'))
      out.push(`   answered by @${s.attributes['bothub.human.by'] ?? '?'} after ${min(ms(s.end) - ms(s.start))}`);
    const diff = diffOf(data, run, outcome);
    if (diff) out.push(`   diff: ${diff}`);
  }
  const span = intervals.length ? Math.max(...intervals.map(i => i[1])) - Math.min(...intervals.map(i => i[0])) : 0;
  let idle = 0;
  for (const gap of gaps(intervals)) {
    const wait = covered(clip(waits, gap));
    const script = covered(clip(scripts, gap));
    add('idle: human wait', wait);
    add('idle: script checks', script);
    idle += gap[1] - gap[0];
    add('idle: queue', Math.max(0, gap[1] - gap[0] - covered([...clip(waits, gap), ...clip(scripts, gap)])));
  }
  out.push(
    `issue #${issue}: ${runs.length} runs, span ${min(span)}, idle between runs ${min(idle)}, cost $${cost.toFixed(2)}`
  );
  for (const [k, v] of Object.entries(totals).sort((a, b) => b[1] - a[1]))
    if (v >= 1000) out.push(`   ${k.padEnd(28)} ${min(v).padStart(8)}`);
  const buildTest = (totals.build ?? 0) + (totals.test ?? 0) + covered(scripts);
  out.push(`   ${'wall minus build/test'.padEnd(28)} ${min(span - buildTest).padStart(8)}`);
  if (untimed) out.push(`   ${untimed} tool calls carry no harness timing; their time counts as model time`);
  return out;
};

if (import.meta.main) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { repo: { type: 'string' } } });
  const [data, issue] = positionals;
  if (!data || !issue) {
    console.error('usage: node bench/timeline.mjs DATA ISSUE [--repo OWNER/REPO]');
    process.exit(2);
  }
  for (const line of await timeline(data, Number(issue), values.repo)) console.log(line);
}
