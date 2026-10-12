#!/usr/bin/env node
// Long-context latency and needle test for local Ollama models.
//
// Modes:
//   single    one /v1/systemone call per question set; state must fit the endpoint's 64 KiB cap
//   chunked   /v1/systemone over a long state split into chunks under the cap; yes-probability is the max over chunks
//   generate  one /api/generate call to a completion model (num_ctx set per request), answer parsed from text
//
// Usage: node infra/local/bench/tev-context.mjs --mode single --model tev1-262k:0.8b --sizes 10000,17000 --runs 3
//   [--parallel 1] [--url http://127.0.0.1:11434] [--corpus dir,dir] [--out results.json]
// /v1/systemone uses the model's num_ctx and ignores request options; tev-262k.Modelfile raises it.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .split('--')
    .filter(Boolean)
    .map(a => a.trim().split(/\s+/)),
);
const here = new URL('.', import.meta.url).pathname;
const repo = resolve(here, '../../../..');
const url = args.url ?? 'http://127.0.0.1:11434';
const mode = args.mode ?? 'single';
const model = args.model ?? (mode === 'generate' ? 'qwen3.5:4b' : 'tev1-262k:0.8b');
const sizes = (args.sizes ?? '10000,17000').split(',').map(Number);
const runs = Number(args.runs ?? 3);
const parallel = Number(args.parallel ?? 1);
const chunkBytes = 60 * 1024;
const corpusDirs = (
  args.corpus ?? `${repo}/docs/content/docs,${repo}/bothub/research,${repo}/bothub/src,${repo}/kit/src`
).split(',');

const walk = dir =>
  readdirSync(dir)
    .sort()
    .flatMap(name => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path);
      return /\.(mdx?|ts)$/.test(name) ? [path] : [];
    });
const corpus = corpusDirs
  .flatMap(walk)
  .map(p => `File: ${p.slice(repo.length + 1)}\n${readFileSync(p, 'utf8')}`)
  .join('\n\n');

const needles = {
  start: {
    fact: 'Operations note: the maintenance window for the Halvorsen relay is every Thursday at 03:40 UTC.',
    yes: 'According to the state, is the Halvorsen relay maintenance window on Thursdays?',
    no: 'According to the state, is the Halvorsen relay maintenance window on Mondays?',
  },
  middle: {
    fact: 'Operations note: the fallback signer for the Quillmoor testnet faucet is named Bramble.',
    yes: 'According to the state, is the fallback signer for the Quillmoor faucet named Bramble?',
    no: 'According to the state, is the fallback signer for the Quillmoor faucet named Juniper?',
  },
  end: {
    fact: 'Operations note: the archive bucket for the Tessaly migration keeps snapshots for 19 days.',
    yes: 'According to the state, does the Tessaly archive bucket keep snapshots for 19 days?',
    no: 'According to the state, does the Tessaly archive bucket keep snapshots for 90 days?',
  },
};
const keys = Object.keys(needles).flatMap(pos => [`${pos}_yes`, `${pos}_no`]);
const questionText = key => needles[key.split('_')[0]][key.split('_')[1]];

const post = async (path, body) => {
  const r = await fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(1_800_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text}`);
  return JSON.parse(text);
};

const runnerRss = () => {
  try {
    return execFileSync('ps', ['-axo', 'rss=,command='], { encoding: 'utf8' })
      .split('\n')
      .filter(l => l.includes('ollama runner'))
      .reduce((sum, l) => sum + Number(l.trim().split(/\s+/)[0]) * 1024, 0);
  } catch {
    return 0;
  }
};

const ps = () => fetch(`${url}/api/ps`).then(r => r.json());
const unloadAll = async () => {
  for (const m of (await ps()).models) await post('/api/generate', { model: m.name, keep_alive: 0 });
  for (let i = 0; i < 50 && (await ps()).models.length; i++) await new Promise(r => setTimeout(r, 200));
};

const measured = async fn => {
  let peak = runnerRss();
  const timer = setInterval(() => (peak = Math.max(peak, runnerRss())), 250);
  const t = performance.now();
  try {
    const value = await fn();
    return { ms: Math.round(performance.now() - t), peakRss: Math.max(peak, runnerRss()), ...value };
  } finally {
    clearInterval(timer);
  }
};

const systemone = (state, wanted) =>
  post('/v1/systemone', {
    model,
    state,
    questions: Object.fromEntries(wanted.map(k => [k, { type: 'noul', instructions: questionText(k) }])),
  });

const chunks = text => {
  const out = [];
  let rest = text;
  while (rest.length) {
    let cut = Math.min(rest.length, chunkBytes);
    while (Buffer.byteLength(rest.slice(0, cut)) > chunkBytes) cut -= 512;
    const nl = rest.lastIndexOf('\n', cut);
    if (cut < rest.length && nl > cut / 2) cut = nl;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return out;
};

const pool = async (items, n, fn) => {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
};

const ask = {
  single: async (state, wanted) => {
    const r = await systemone(state, wanted);
    return {
      tokens: r.usage.input_tokens,
      cached: r.prompt_eval_cached_count,
      p: Object.fromEntries(wanted.map(k => [k, r.answers[k].noul])),
    };
  },
  chunked: async (state, wanted) => {
    const parts = chunks(state);
    const rs = await pool(parts, parallel, part => systemone(part, wanted));
    return {
      chunks: parts.length,
      tokens: rs.reduce((s, r) => s + r.usage.input_tokens, 0),
      cached: rs.reduce((s, r) => s + (r.prompt_eval_cached_count ?? 0), 0),
      p: Object.fromEntries(wanted.map(k => [k, Math.max(...rs.map(r => r.answers[k].noul))])),
    };
  },
  generate: async (state, wanted) => {
    const list = wanted.map((k, i) => `${i + 1}. ${questionText(k)}`).join('\n');
    const r = await post('/api/generate', {
      model,
      stream: false,
      think: false,
      prompt: `<state>\n${state}\n</state>\n\nAnswer each question with yes or no only, one per line, as "1. yes".\n${list}`,
      options: { num_ctx: Math.min(262144, Math.ceil(state.length / 3) + 2048), temperature: 0, num_predict: 8 * wanted.length },
    });
    const lines = r.response.toLowerCase().split('\n');
    return {
      tokens: r.prompt_eval_count,
      promptEvalMs: Math.round(r.prompt_eval_duration / 1e6),
      loadMs: Math.round(r.load_duration / 1e6),
      p: Object.fromEntries(wanted.map((k, i) => [k, /\byes\b/.test(lines.find(l => l.startsWith(`${i + 1}.`)) ?? '') ? 1 : 0])),
    };
  },
}[mode];

// Characters per token for this corpus, measured once through the decision endpoint.
const calibrate = async () => {
  const sample = corpus.slice(0, 40_000);
  const q = { a: { type: 'noul', instructions: 'Is this text?' } };
  const full = await post('/v1/systemone', { model: 'tev1-262k:0.8b', state: sample, questions: q });
  const base = await post('/v1/systemone', { model: 'tev1-262k:0.8b', state: 'x', questions: q });
  return sample.length / (full.usage.input_tokens - base.usage.input_tokens);
};

const build = (tokens, ratio, nonce) => {
  const chars = Math.floor((tokens - 300) * ratio);
  let body = corpus.slice(0, chars);
  while (body.length < chars) body += `\n\n${corpus.slice(0, chars - body.length)}`;
  const mid = body.indexOf('\n', Math.floor(body.length / 2));
  return [`Snapshot ${nonce}.`, needles.start.fact, body.slice(0, mid), needles.middle.fact, body.slice(mid), needles.end.fact].join(
    '\n\n',
  );
};
const nonce = () => Math.random().toString(36).slice(2, 8);
const correct = p => Object.entries(p).filter(([k, v]) => (k.endsWith('_yes') ? v >= 0.5 : v < 0.5)).length;
const round = p => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Number(v.toFixed(3))]));

await unloadAll();
const ratio = await calibrate();
console.error(`mode ${mode}, model ${model}, corpus ${corpus.length} chars, ${ratio.toFixed(2)} chars per token`);

const rows = [];
for (const size of sizes) {
  const row = { mode, model, size, parallel, cold: [], warm: [], cached: [] };
  try {
    for (let i = 0; i < runs; i++) {
      await unloadAll();
      const r = await measured(() => ask(build(size, ratio, nonce()), keys));
      row.cold.push({ ...r, correct: correct(r.p), p: round(r.p) });
    }
    let state;
    for (let i = 0; i < runs; i++) {
      state = build(size, ratio, nonce());
      const r = await measured(() => ask(state, keys));
      row.warm.push({ ...r, correct: correct(r.p), p: round(r.p) });
    }
    for (const key of ['middle_yes', 'end_no', 'end_yes']) {
      const r = await measured(() => ask(state, [key]));
      row.cached.push({ key, ms: r.ms, cached: r.cached, promptEvalMs: r.promptEvalMs, p: round(r.p) });
    }
    const m = (await ps()).models.find(x => x.name === model);
    row.vram = m?.size_vram;
  } catch (e) {
    row.error = String(e.message ?? e).slice(0, 300);
  }
  rows.push(row);
  console.log(JSON.stringify(row));
}

if (args.out) writeFileSync(args.out, JSON.stringify({ ratio, rows }, null, 2));
