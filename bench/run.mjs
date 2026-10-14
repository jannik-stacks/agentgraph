// Runs hub settings over bench cases and writes one JSONL row of metrics per setting, case and repeat.
//   node bench/run.mjs split --cases DIR
//   node bench/run.mjs run --hub DIR --cases DIR --clone DIR --split validation [--set NAME=PATCH ...] [--repeats 3]
//       [--case ID ...] [--out rows.jsonl] [--env FILE] [--tests CMD] [--timeout MINUTES] [--report-only]
//   node bench/run.mjs summary rows.jsonl [--baseline NAME]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { compile } from '../src/config.ts';
import { parseItem, renderItem } from '../src/hub-files.ts';
import { localIssues } from '../src/issues-local.ts';
import { readHub } from '../src/load.ts';
import { fileDiffs } from '../src/over.ts';
import { localPulls, pullsFile } from '../src/pulls.ts';
import { serveHub } from '../src/serve.ts';
import { openStore } from '../src/store.ts';
import { sum, tally } from '../src/usage.ts';
import { compare, kindOf, runTests } from './compare.mjs';

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const sleep = ms => new Promise(done => setTimeout(done, Math.max(0, ms)));
const isRecord = v => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `patch` merged into `base`; a `null` value removes the key. */
export const merge = (base, patch) => {
  if (!isRecord(base) || !isRecord(patch)) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch))
    if (value === null) delete out[key];
    else out[key] = merge(base[key], value);
  return out;
};

/**
 * Applies an override set to the hub in `dir`: an object merges into a file's frontmatter (or `hub.yaml`), a string
 * replaces the file and `null` deletes it.
 */
export const patchHub = (dir, patch) => {
  for (const [path, value] of Object.entries(patch)) {
    const file = join(dir, path);
    if (value === null) rmSync(file, { force: true });
    else if (typeof value === 'string') writeFileSync(file, value);
    else {
      const original = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
      const { data, body } = original === undefined ? { data: {}, body: '' } : parseItem(path, original);
      writeFileSync(file, renderItem(path, { data: merge(data, value), body }, original));
    }
  }
};

/** The split a case id falls in, from its hash: six in ten train, two validation, two test. */
export const splitOf = id => {
  const bucket = createHash('sha256').update(id).digest().readUInt32BE(0) % 10;
  return bucket < 6 ? 'train' : bucket < 8 ? 'validation' : 'test';
};

/** The split of every case under `dir`, stored in `dir/splits.json`; a case keeps the split it was first given. */
export const splits = dir => {
  const file = join(dir, 'splits.json');
  const stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const ids = readdirSync(dir).filter(id => existsSync(join(dir, id, 'case.json')));
  const all = Object.fromEntries(ids.sort().map(id => [id, stored[id] ?? splitOf(id)]));
  if (JSON.stringify(all) !== JSON.stringify(stored)) writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
  return all;
};

/** A mined case: its metadata, the issue title and body from `issue.md`, and the merged diff. */
export const loadCase = dir => {
  const read = name => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : undefined);
  const issue = read('issue.md') ?? '';
  const title = /^# (.+)$/m.exec(issue)?.[1] ?? basename(dir);
  return {
    id: basename(dir),
    ...JSON.parse(read('case.json')),
    title,
    body: issue.replace(/^# .+\n+/, '').trim(),
    merged: read('merged.diff'),
    followups: JSON.parse(read('followups.json') ?? 'null'),
  };
};

const failingHolds = (outcome, modes) =>
  (outcome?.checks ?? []).filter(v => v.gating && !v.pass && !v.skipped && modes[v.check] !== 'warn');

/** Total milliseconds during which at least one run was running. */
const busy = runs => {
  const spans = runs
    .filter(r => r.startedAt && r.endedAt)
    .map(r => [Date.parse(r.startedAt), Date.parse(r.endedAt)])
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of spans) {
    total += Math.max(0, to - Math.max(from, end));
    end = Math.max(end, to);
  }
  return total;
};

/**
 * The metrics a finished flow left in its runs (`records`: run, outcome and events, oldest first): how it closed,
 * attempts, questions, false holds (held checks on an earlier attempt that passed on the job's final attempt), usage
 * and busy time.
 */
export const measure = ({ records, modes = {}, pull }) => {
  const jobs = records.filter(r => !r.run.check);
  const chains = Object.values(Object.groupBy(jobs, r => `${r.run.workflow}/${r.run.job}#${r.run.event?.number}`));
  let falseHolds = 0;
  for (const chain of chains) {
    const last = chain.at(-1);
    const settled = last.run.closure === 'done' || last.run.closure === 'handed-off';
    if (!settled || failingHolds(last.outcome, modes).length) continue;
    const passed = new Set((last.outcome?.checks ?? []).filter(v => v.pass).map(v => v.check));
    for (const r of chain.slice(0, -1))
      falseHolds += failingHolds(r.outcome, modes).filter(v => passed.has(v.check)).length;
  }
  const stuck = jobs.find(r => r.run.closure === 'blocked' || r.run.closure === 'deferred');
  const usage = sum(records.map(r => tally(r.events)));
  return {
    closure: pull ? 'merge-request' : (stuck?.run.closure ?? jobs.at(-1)?.run.closure ?? 'none'),
    attempts: jobs.length,
    maxAttempt: Math.max(0, ...jobs.map(r => r.run.attempt ?? 1)),
    questions: jobs.flatMap(r => (r.outcome?.accepted ?? []).filter(p => p.kind === 'ask')).length,
    falseHolds,
    usd: usage.usd,
    tokensIn: usage.in,
    tokensOut: usage.out,
    tokensCached: usage.cached,
    calls: usage.calls,
    busyMs: busy(records.map(r => r.run)),
  };
};

const part = (diff, tests) =>
  fileDiffs(diff)
    .filter(f => (kindOf(f.label) === 'tests') === tests)
    .map(f => `${f.text}\n`)
    .join('');

/** Size and overlap of `diff` against the merged change, with `tests` run both ways across their code and tests. */
const against = (repo, diff, kase, tests) => {
  const c = compare({ repo, a: diff, b: kase.merged, followups: kase.followups });
  const { a, b } = c.size;
  return {
    added: a.added,
    addedNoTests: a.added - a.testsAdded,
    mergedAdded: b.added,
    mergedAddedNoTests: b.added - b.testsAdded,
    files: a.files,
    fileJaccard: c.overlap.fileJaccard,
    symbolJaccard: c.overlap.symbolJaccard,
    ...(c.followups && { followupsCaught: c.followups.aCaught }),
    ...(tests && {
      ownTests: runTests(repo, diff, tests).ok ?? false,
      mergedTestsOnOurCode: runTests(repo, part(diff, false) + part(kase.merged, true), tests).ok ?? false,
      ourTestsOnMergedCode: runTests(repo, part(kase.merged, false) + part(diff, true), tests).ok ?? false,
    }),
  };
};

/**
 * Runs one case on a copy of `hub` with `patch` applied: a bare origin sharing `clone`'s objects with `main` at the
 * case's base, the case's issue filed in a fresh local tracker and started with `command`, served until nothing is
 * left to run or `timeout` ms pass. Resolves to the case's metrics; every temporary directory is removed.
 */
export const runCase = async ({
  hub,
  patch = {},
  kase,
  clone,
  env = process.env,
  command = '/bothub',
  timeout = 3_600_000,
  interval = 500,
  tests,
  log = () => {},
  adapters,
  launch,
}) => {
  const root = mkdtempSync(join(tmpdir(), 'bench-run-'));
  const started = Date.now();
  try {
    const origin = join(root, 'origin.git');
    sh('git', ['clone', '-q', '--bare', '--shared', resolve(clone), origin]);
    sh('git', ['-C', origin, 'update-ref', 'refs/heads/main', kase.base]);
    sh('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    const dir = join(root, 'hub');
    cpSync(hub, dir, { recursive: true, filter: path => !resolve(path).startsWith(resolve(hub, 'issues')) });
    patchHub(dir, patch);
    const compiled = compile(await readHub(dir));
    if (!compiled.ok) throw new Error(compiled.errors.map(e => `${e.path}: ${e.message}`).join('\n'));
    const modes = Object.fromEntries(Object.entries(compiled.config.checks).map(([name, c]) => [name, c.mode]));
    const repo = kase.repo;
    const issues = localIssues(join(dir, 'issues'), { repo, as: 'bench' });
    const { number } = await issues.create({ title: kase.title, body: kase.body });
    const data = join(root, 'data');
    let results = 0;
    const served = await serveHub({
      hub: dir,
      data,
      origin,
      repo,
      env,
      port: 0,
      interval,
      log,
      onResults: (_, r) => (results += r.length),
      ...(adapters && { adapters }),
      ...(launch && { launch }),
    });
    let timedOut = true;
    const over = () => Date.now() - started > timeout;
    try {
      await issues.comment(number, command);
      const settled = async () => {
        while (!over()) {
          if (results) break;
          await sleep(interval);
        }
        for (let seen = -1; seen !== results && !over();) {
          seen = results;
          await sleep(interval * 3);
          await served.idle();
        }
        timedOut = over();
      };
      await Promise.race([settled(), sleep(started + timeout - Date.now())]);
    } finally {
      await served.stop();
    }
    const [pull] = await localPulls({ origin, file: pullsFile(data), repo }).list({ state: 'all' });
    const diff = pull?.head ? sh('git', ['-C', origin, 'diff', `${kase.base}...${pull.head}`]) : '';
    const store = openStore(data);
    const runs = (await store.list()).reverse();
    const records = await Promise.all(
      runs.map(async run => ({
        run,
        outcome: await store.outcome(run.id),
        events: (await store.events(run.id)).map(e => e.event),
      }))
    );
    let compared = { added: 0, addedNoTests: 0, fileJaccard: 0 };
    if (diff && kase.merged) {
      const base = join(root, 'base');
      sh('git', ['clone', '-q', '--shared', '--no-checkout', origin, base]);
      sh('git', ['-C', base, 'checkout', '-q', '--detach', kase.base]);
      compared = against(base, diff, kase, tests);
    }
    return { ...measure({ records, modes, pull }), ...compared, timedOut, wallMs: Date.now() - started };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const median = values => {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const numeric = row =>
  Object.fromEntries(
    Object.entries({ ...row, mergeRequest: row.closure === 'merge-request' })
      .filter(([key, v]) => key !== 'repeat' && (typeof v === 'number' || typeof v === 'boolean'))
      .map(([key, v]) => [key, Number(v)])
  );
const collect = rows => {
  const out = {};
  for (const row of rows) for (const [key, v] of Object.entries(numeric(row))) (out[key] ??= []).push(v);
  return out;
};

/**
 * Per setting, the median, min and max of each metric over its rows; and per setting other than `baseline`, each
 * metric paired against the baseline on the same cases: the median of the per-case differences of medians, and how
 * many cases went up or down.
 */
export const summarize = (rows, baseline = 'baseline') => {
  const settings = Object.groupBy(rows, r => r.setting);
  const perCase = name => Object.groupBy(settings[name] ?? [], r => r.case);
  const base = perCase(baseline);
  const out = {};
  for (const [name, own] of Object.entries(settings)) {
    const metrics = Object.fromEntries(
      Object.entries(collect(own)).map(([key, v]) => [
        key,
        { median: median(v), min: Math.min(...v), max: Math.max(...v), n: v.length },
      ])
    );
    out[name] = { metrics };
    if (name === baseline) continue;
    const deltas = {};
    for (const [id, caseRows] of Object.entries(perCase(name))) {
      if (!base[id]) continue;
      const [ours, theirs] = [collect(caseRows), collect(base[id])];
      for (const key of Object.keys(ours))
        if (theirs[key]) (deltas[key] ??= []).push(median(ours[key]) - median(theirs[key]));
    }
    out[name].paired = Object.fromEntries(
      Object.entries(deltas).map(([key, d]) => [
        key,
        { delta: median(d), up: d.filter(x => x > 0).length, down: d.filter(x => x < 0).length, cases: d.length },
      ])
    );
  }
  return out;
};

const parseSet = value => {
  const at = value.indexOf('=');
  const text = value.slice(at + 1);
  return { name: value.slice(0, at), patch: JSON.parse(existsSync(text) ? readFileSync(text, 'utf8') : text) };
};

/** Runs every setting on every case of `split` `repeats` times, settings interleaved per case and repeat. */
export const sweep = async ({ hub, cases, clone, split, sets = [], repeats = 3, only, reportOnly, out, ...rest }) => {
  if (split === 'test' && !reportOnly) throw new Error('the test split is for reporting only: pass --report-only');
  const ids = Object.entries(splits(cases))
    .filter(([id, s]) => s === split && (!only?.length || only.includes(id)))
    .map(([id]) => id);
  const settings = [{ name: 'baseline', patch: {} }, ...sets.filter(s => s.name !== 'baseline')];
  const rows = [];
  for (const id of ids) {
    const kase = loadCase(join(cases, id));
    for (let repeat = 0; repeat < repeats; repeat++)
      for (const { name, patch } of settings) {
        const metrics = await runCase({ ...rest, hub, patch, kase, clone }).catch(e => ({ error: e.message }));
        const row = { setting: name, case: id, split, repeat, ...metrics };
        rows.push(row);
        if (out) appendFileSync(out, `${JSON.stringify(row)}\n`);
      }
  }
  return rows;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      hub: { type: 'string' },
      cases: { type: 'string' },
      clone: { type: 'string' },
      split: { type: 'string', default: 'validation' },
      set: { type: 'string', multiple: true, default: [] },
      case: { type: 'string', multiple: true, default: [] },
      repeats: { type: 'string', default: '3' },
      out: { type: 'string', default: 'bench-rows.jsonl' },
      env: { type: 'string' },
      tests: { type: 'string' },
      timeout: { type: 'string', default: '60' },
      command: { type: 'string', default: '/bothub' },
      baseline: { type: 'string', default: 'baseline' },
      'report-only': { type: 'boolean', default: false },
    },
  });
  const [mode, file] = positionals;
  if (mode === 'split') console.log(JSON.stringify(splits(values.cases), null, 2));
  else if (mode === 'summary') {
    const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    console.log(JSON.stringify(summarize(rows, values.baseline), null, 2));
  } else if (mode === 'run') {
    if (!values.hub || !values.cases || !values.clone) throw new Error('run needs --hub, --cases and --clone');
    await sweep({
      hub: values.hub,
      cases: values.cases,
      clone: values.clone,
      split: values.split,
      sets: values.set.map(parseSet),
      only: values.case,
      repeats: Number(values.repeats),
      reportOnly: values['report-only'],
      out: values.out,
      tests: values.tests,
      command: values.command,
      timeout: Number(values.timeout) * 60_000,
      env: { ...(values.env && parseEnv(readFileSync(values.env, 'utf8'))), ...process.env },
      log: line => process.stderr.write(`${line}\n`),
    });
  } else throw new Error('usage: run.mjs split|run|summary (see the header)');
}
