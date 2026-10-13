// Latency of recall: summary build, index build, keyword query, decision batch and end to end.
// Usage: node infra/local/bench/recall.ts --data dir,dir [--hub examples/acme-app] [--scale 1,10,50]
//   [--live] [--summarize-model qwen3.5:4b] [--url http://127.0.0.1:11434]
// --data takes bothub data dirs (each with runs/<id>/events.jsonl); they are copied, never written.
import { cp, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseIssue } from '../../../src/issues-local.ts';
import { parseMarkdown } from '../../../src/markdown.ts';
import { index, issueDocs, noteDocs, recall, summaryDocs, synonyms, type Doc } from '../../../src/recall.ts';
import type { EventRecord } from '../../../src/store.ts';
import { items, loadSummaries, modelLine, summarizeRun, Summarizer } from '../../../src/summaries.ts';
import type { Config } from '../../../src/config.ts';
import { decide } from '../../../src/decide.ts';
import { NoteKind } from '../../../src/schema.ts';

let asked = 0;
const loud: typeof decide = request => (
  (asked = Object.keys(request.questions).length),
  decide(request).catch(e => {
    console.log(`  ${(e as Error).message.slice(0, 200)}`);
    throw e;
  })
);

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .split('--')
    .filter(Boolean)
    .map(a => {
      const [k, ...v] = a.trim().split(/\s+/);
      return [k!, v.join(' ') || 'true'];
    })
);
const here = new URL('.', import.meta.url).pathname;
const hub = resolve(here, '../../..', args.hub ?? 'examples/acme-app');
const url = args.url ?? 'http://127.0.0.1:11434';
const scales = (args.scale ?? '1,10,50').split(',').map(Number);

const time = async <T>(fn: () => Promise<T> | T) => {
  const t = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t };
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const notes: Config['notes'] = [];
for (const kind of NoteKind.options)
  for (const file of await readdir(join(hub, 'notes', kind)).catch(() => [])) {
    const path = join(hub, 'notes', kind, file);
    const { data, body } = parseMarkdown(await readFile(path, 'utf8'));
    notes.push({ ...(data as { title: string }), kind, name: file.replace(/\.md$/, ''), path, body });
  }
const issues = await Promise.all(
  (await readdir(join(hub, 'issues')).catch(() => [])).map(async f =>
    parseIssue(f, await readFile(join(hub, 'issues', f), 'utf8'))
  )
);

const work = await mkdtemp(join(tmpdir(), 'recall-bench-'));
let events = 0;
let runCount = 0;
const summarize = await time(async () => {
  for (const dir of (args.data ?? '').split(',').filter(Boolean))
    for (const id of await readdir(join(dir, 'runs')).catch(() => [])) {
      const src = join(dir, 'runs', id);
      const dst = join(work, 'runs', `${runCount}-${id}`);
      await cp(join(src, 'events.jsonl'), join(dst, 'events.jsonl')).catch(() => undefined);
      await cp(join(src, 'run.json'), join(dst, 'run.json')).catch(() => undefined);
      events += (await readFile(join(dst, 'events.jsonl'), 'utf8').catch(() => '')).split('\n').length - 1;
      await summarizeRun(work, `${runCount}-${id}`, Summarizer.parse({ granularity: ['item', 'turn'] }));
      runCount++;
    }
});
const records = await loadSummaries(work, () => 'hub');
console.log(`runs ${runCount}, events ${events}, summaries ${records.length}, summarize ${summarize.ms.toFixed(1)} ms`);

const base: Doc[] = [...noteDocs(notes), ...issueDocs(issues), ...summaryDocs(records)];
const words = synonyms([
  ['pr', 'pull request', 'merge request'],
  ['test', 'spec', 'vitest'],
  ['bigint', 'integer', 'amount'],
  ['error', 'failure', 'fail', 'crash'],
]);
const queries = [
  'bigint amounts json',
  'cvToJson clarity types golden vectors',
  'vitest missing dependency error',
  'open pull request after checks',
  'smoke test public index exports',
  'hex without 0x prefix',
];

for (const scale of scales) {
  const docs = Array.from({ length: scale }, (_, s) => base.map(d => ({ ...d, id: `${d.id}~${s}` }))).flat();
  const built = await time(() => index(docs, words));
  const q: number[] = [];
  for (let r = 0; r < 20; r++) for (const query of queries) q.push((await time(() => built.value.search(query))).ms);
  console.log(
    `scale ${scale}: ${docs.length} docs, index ${built.ms.toFixed(1)} ms, query median ${median(q).toFixed(3)} ms, max ${Math.max(...q).toFixed(3)} ms`
  );
}

if (args.live) {
  const idx = index(base, words);
  const task =
    'Issue #6: Add cvToJson in kit/src/clarity/json.ts for every Clarity type, with tests against the golden vectors. The last attempt failed because vitest was missing.';
  for (const top of [10, 20, 50]) {
    const ms: number[] = [];
    let kept = 0;
    let candidates = 0;
    for (let r = 0; r < 4; r++) {
      const fresh = `${task} (attempt ${top}-${r}-${Math.random().toString(36).slice(2, 8)})`;
      const out = await time(() =>
        recall({ index: idx, task: fresh, query: 'cvToJson clarity golden vectors vitest missing', top, cutoff: 0.5, budget: 4000, url, decide: loud, bot: 'implementor' })
      );
      ms.push(out.ms);
      kept = out.value.length;
      if (out.value.some(h => h.p === undefined)) console.log('  decision model unavailable, keyword order kept');
      candidates = asked;
    }
    const all = await recall({ index: idx, task, query: 'cvToJson clarity golden vectors vitest missing', top, cutoff: 0, budget: 1e9, url, bot: 'implementor' });
    for (const h of [...all.slice(0, 3), ...all.slice(-3)]) console.log(`  p ${h.p?.toFixed(2)} ${h.doc.kind} ${h.doc.title}: ${h.doc.text.slice(0, 90).replace(/\s+/g, ' ')}`);
    console.log(
      `recall top ${top}: ${candidates} candidates, kept ${kept}, first ${ms[0]!.toFixed(0)} ms, median of rest ${median(ms.slice(1)).toFixed(0)} ms`
    );
  }
}

if (args['summarize-model']) {
  const settings = Summarizer.parse({ mode: 'model', model: args['summarize-model'], 'max-bytes': 512 });
  const sample: string[] = [];
  for (const dir of (args.data ?? '').split(',').filter(Boolean))
    for (const id of await readdir(join(dir, 'runs')).catch(() => [])) {
      const text = await readFile(join(dir, 'runs', id, 'events.jsonl'), 'utf8').catch(() => '');
      const recs = text.split('\n').filter(Boolean).map(l => JSON.parse(l) as EventRecord);
      for (const item of items(recs)) if (Buffer.byteLength(item.source) > 512) sample.push(item.source);
    }
  const ms: number[] = [];
  for (const source of sample.slice(0, 12)) {
    const out = await time(() => modelLine(settings, { url: `${url}/v1`, timeoutMs: 120_000 }, source));
    ms.push(out.ms);
    console.log(`  ${out.ms.toFixed(0)} ms, ${Buffer.byteLength(out.value)} bytes: ${out.value.slice(0, 160)}`);
  }
  console.log(`model summaries with ${settings.model}: ${sample.length} sources over 512 bytes, median ${median(ms).toFixed(0)} ms, max ${Math.max(...ms).toFixed(0)} ms`);
}
