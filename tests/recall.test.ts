import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.ts';
import { parseIssue } from '../src/issues-local.ts';
import { parseMarkdown } from '../src/markdown.ts';
import { NoteKind } from '../src/schema.ts';
import {
  index,
  issueDocs,
  noteDocs,
  recall,
  stem,
  summaryDocs,
  synonyms,
  terms,
  type DecideFn,
  type Doc,
} from '../src/recall.ts';
import type { EventRecord } from '../src/store.ts';
import {
  askerOf,
  fit,
  history,
  items,
  loadSummaries,
  modelLine,
  readSummaries,
  summarizeEvents,
  summarizeRun,
  Summarizer,
  type History,
} from '../src/summaries.ts';

const hub = new URL('../examples/acme-app/', import.meta.url).pathname;
const fixture = new URL('./fixtures/recorded-run.jsonl', import.meta.url).pathname;

const readEvents = async () =>
  (await readFile(fixture, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as EventRecord);

const hubNotes = async (): Promise<Config['notes']> => {
  const notes: Config['notes'] = [];
  for (const kind of NoteKind.options)
    for (const file of await readdir(join(hub, 'notes', kind))) {
      const path = join(hub, 'notes', kind, file);
      const { data, body } = parseMarkdown(await readFile(path, 'utf8'));
      notes.push({ ...(data as { title: string }), kind, name: file.replace(/\.md$/, ''), path, body });
    }
  return notes;
};

const hubIssues = async () =>
  Promise.all(
    (await readdir(join(hub, 'issues'))).map(async f => parseIssue(f, await readFile(join(hub, 'issues', f), 'utf8')))
  );

const doc = (id: string, title: string, text: string, extra: Partial<Doc> = {}): Doc => ({
  id,
  kind: 'note',
  title,
  text,
  pointer: id,
  ...extra,
});

describe('terms', () => {
  it('splits names into parts and folds inflections together', () => {
    expect(terms('cvToJson handles max_bytes')).toEqual([
      'cvtojson',
      'cv',
      'json',
      'handle',
      'max_byte',
      'max',
      'byte',
    ]);
    expect(['tests', 'testing', 'tested', 'test'].map(stem)).toEqual(['test', 'test', 'test', 'test']);
    expect(stem('policies')).toBe('policy');
    expect(stem('class')).toBe('class');
  });
});

describe('index', () => {
  it('ranks a title match over a passing mention, and a rare term over a common one', () => {
    const idx = index([
      doc('a', 'Signing transactions', 'How the kit signs and broadcasts.'),
      doc('b', 'Fees', 'Fees are bigint. Signing is mentioned once here among many other words about fees and nonces.'),
      doc('c', 'Nonces', 'Nonce handling for the kit.'),
    ]);
    expect(idx.search('signing').map(h => h.doc.id)).toEqual(['a', 'b']);
    expect(idx.search('kit nonce')[0]?.doc.id).toBe('c');
    expect(idx.search('zebra quokka')).toEqual([]);
  });

  it('finds documents through synonyms, below documents with the exact word', () => {
    const words = synonyms([['pull request', 'pr', 'merge request']]);
    const idx = index(
      [
        doc('exact', 'Opening a PR', 'Open the PR after checks pass.'),
        doc('synonym', 'Merge flow', 'The merge request waits for review.'),
      ],
      words
    );
    expect(idx.search('pr').map(h => h.doc.id)).toEqual(['exact', 'synonym']);
    expect(index([doc('synonym', 'Merge flow', 'The merge request waits.')]).search('pr')).toEqual([]);
  });

  it('indexes the real acme-app hub notes and issues', async () => {
    const idx = index([...noteDocs(await hubNotes()), ...issueDocs(await hubIssues())]);
    expect(idx.search('bigint amounts above 2^53')[0]?.doc.id).toBe('note:decision/bigint-above-2-53');
    expect(idx.search('cvFromJson lenient')[0]?.doc.id).toBe('issue:7');
  });
});

describe('summaries', () => {
  it('pairs each tool call with its result and keeps messages', async () => {
    const records = await readEvents();
    const all = items(records);
    const calls = records.filter(r => r.event.type === 'tool_call').length;
    expect(all.filter(i => i.kind === 'tool')).toHaveLength(calls);
    const first = all.find(i => i.kind === 'tool')!;
    expect(first.line).toBe('tool bothub_issues_get number=6: ok, {');
    expect(all.filter(i => i.kind === 'tool' && i.line.includes(': error')).length).toBeGreaterThan(0);
  });

  it('builds item, turn and run lines within the byte cap', async () => {
    const records = await readEvents();
    const settings = Summarizer.parse({ granularity: ['item', 'turn', 'run'], 'max-bytes': 200 });
    const out = summarizeEvents('r1', records, settings);
    expect(new Set(out.map(r => r.kind))).toEqual(new Set(['tool', 'text', 'turn', 'run']));
    expect(out.filter(r => r.kind === 'run')).toHaveLength(1);
    for (const r of out) expect(Buffer.byteLength(r.line)).toBeLessThanOrEqual(200);
    expect(summarizeEvents('r1', records, Summarizer.parse('off'))).toEqual([]);
  });

  it('accepts the short forms of the setting', () => {
    expect(Summarizer.parse('extractive')).toMatchObject({ mode: 'extractive', granularity: 'item', 'max-bytes': 512 });
    expect(Summarizer.parse('small')).toMatchObject({ mode: 'model', model: 'small' });
    expect(Summarizer.safeParse({ mode: 'model' }).success).toBe(false);
  });

  it('cuts at the last separator under the cap', () => {
    expect(fit('alpha beta; gamma delta epsilon', 20)).toBe('alpha beta…');
    expect(Buffer.byteLength(fit('ääää ääää ääää', 12))).toBeLessThanOrEqual(12);
    expect(fit('short', 20)).toBe('short');
  });
});

afterEach(() => vi.unstubAllGlobals());

const chat = (...answers: string[]) => {
  const fetch = vi.fn(async () => Response.json({ choices: [{ message: { content: answers.shift() ?? '' } }] }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
};

describe('model summaries', () => {
  const settings = Summarizer.parse({ mode: 'model', model: 'small', 'max-bytes': 64 });
  const endpoint = { url: 'http://proxy/v1' };

  it('keeps a short source verbatim without a call', async () => {
    const fetch = chat();
    expect(await modelLine(settings, endpoint, 'text: done')).toBe('text: done');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retries an over-long line once, then cuts it', async () => {
    const long = 'tool: ran the full kit test suite; text: everything failed because vitest was missing; more';
    const fetch = chat(long, long);
    const line = await modelLine(settings, endpoint, 'x'.repeat(200));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(64);
    expect(line.endsWith('…')).toBe(true);
  });

  it('writes extractive lines first and model lines as later records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recall-'));
    await mkdir(join(dir, 'runs', 'r1'), { recursive: true });
    await writeFile(join(dir, 'runs', 'r1', 'events.jsonl'), await readFile(fixture, 'utf8'));
    chat(...Array.from({ length: 200 }, () => 'model line'));
    const written = await summarizeRun(dir, 'r1', settings, { endpoint });
    const current = await readSummaries(dir, 'r1');
    expect(written.length).toBeGreaterThan(current.length);
    expect(current.every(r => r.by === 'small' || Buffer.byteLength(r.line) <= 64)).toBe(true);
    expect(current.some(r => r.line === 'model line' && r.prompt)).toBe(true);
  });
});

type Seen = { id: string; bot: string; job?: string; event?: string; number?: number };

const runDir = async (runs: Seen[]) => {
  const dir = await mkdtemp(join(tmpdir(), 'recall-'));
  for (const { id, bot, job = 'j', event = id, number } of runs) {
    await mkdir(join(dir, 'runs', id), { recursive: true });
    const on = { id: event, repo: 'acme/app', ...(number !== undefined && { number }) };
    await writeFile(
      join(dir, 'runs', id, 'run.json'),
      JSON.stringify({ id, bot, workflow: 'w', job, status: 'succeeded', event: on })
    );
    await writeFile(join(dir, 'runs', id, 'events.jsonl'), await readFile(fixture, 'utf8'));
    await summarizeRun(dir, id, Summarizer.parse('extractive'));
  }
  return dir;
};

describe('history', () => {
  const runs: Seen[] = [
    { id: 'a', bot: 'implementor', event: 'e1', number: 7 },
    { id: 'b', bot: 'reviewer', event: 'e2', number: 7 },
    { id: 'c', bot: 'implementor', event: 'e3', number: 9 },
    { id: 'd', bot: 'implementor', event: 'e1', number: 7 },
  ];

  it('limits recall and history to how far the asking bot reaches', async () => {
    const dir = await runDir(runs);
    const records = await loadSummaries(dir);
    expect(new Set(records.map(r => r.run))).toEqual(new Set(['a', 'b', 'c', 'd']));
    const idx = index(summaryDocs(records.filter(r => r.run !== 'd')));
    const reach = async (scope: History) => {
      const asker = await askerOf(dir, 'd', 'implementor', scope);
      const recalled = await recall({
        index: idx,
        task: 'bothub_issues_get',
        asker,
        top: 50,
        budget: 1e6,
        decide: none,
      });
      const listed = (await history(dir, asker).list()).filter(r => r.id !== 'd');
      return { recalled: new Set(recalled.map(h => h.doc.pointer.split('#')[0])), listed: listed.map(r => r.id) };
    };
    expect(await reach('hub')).toEqual({ recalled: new Set(['a', 'b', 'c']), listed: ['c', 'b', 'a'] });
    expect(await reach('bot')).toEqual({ recalled: new Set(['a', 'c']), listed: ['c', 'a'] });
    expect(await reach('issue')).toEqual({ recalled: new Set(['a', 'b']), listed: ['b', 'a'] });
    expect(await reach('run')).toEqual({ recalled: new Set(['a']), listed: ['a'] });
    expect(await reach('none')).toEqual({ recalled: new Set(), listed: [] });
  });

  it('reads only runs the asker may see', async () => {
    const dir = await runDir(runs);
    const h = history(dir, await askerOf(dir, 'd', 'checker', 'issue'));
    expect(await h.read('c')).toBeUndefined();
    expect((await h.read('b', { from: 0, to: 1 }))?.length).toBe(2);
  });
});

const none: DecideFn = async () => {
  throw new Error('offline');
};

const scripted = (p: Record<string, number>) => {
  const calls: Parameters<DecideFn>[0][] = [];
  const fn = (async request => {
    calls.push(request);
    return Object.fromEntries(
      Object.entries(request.questions).map(([key, q]) => {
        const hit = Object.entries(p).find(([word]) => String(q.instructions).includes(word));
        return [key, { type: 'noul', noul: hit?.[1] ?? 0 }];
      })
    );
  }) as DecideFn;
  return { fn, calls };
};

describe('recall', () => {
  const idx = index([
    doc('fees', 'Fee estimation', 'Fees are bigint values; estimate fees before signing.'),
    doc('nonce', 'Nonce gaps', 'A nonce gap stalls later transactions; fees do not help.'),
    doc('docs', 'Docs style', 'No middle dots in docs; fees are mentioned in passing.'),
  ]);

  it('asks about every candidate in one call and keeps those at or above the cutoff, best first', async () => {
    const { fn, calls } = scripted({ 'Nonce gaps': 0.9, 'Fee estimation': 0.6, 'Docs style': 0.2 });
    const hits = await recall({ index: idx, task: 'why is my transaction stuck? fees', decide: fn, cutoff: 0.5 });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.questions)).toHaveLength(3);
    expect(hits.map(h => h.doc.id)).toEqual(['nonce', 'fees']);
    expect((await recall({ index: idx, task: 'fees', decide: fn, cutoff: 0.7 })).map(h => h.doc.id)).toEqual(['nonce']);
  });

  it('stays within the token budget', async () => {
    const { fn } = scripted({ 'Nonce gaps': 0.9, 'Fee estimation': 0.8, 'Docs style': 0.7 });
    const hits = await recall({ index: idx, task: 'fees', decide: fn, budget: 20 });
    expect(hits.map(h => h.doc.id)).toEqual(['nonce']);
  });

  it('keeps the keyword order when the decision model is unreachable', async () => {
    const hits = await recall({ index: idx, task: 'estimate fees', decide: none, budget: 1e6 });
    expect(hits[0]?.doc.id).toBe('fees');
    expect(hits.every(h => h.p === undefined)).toBe(true);
  });
});

describe.skipIf(process.env.BOTHUB_LIVE !== '1')('recall against a live decision model', () => {
  it('keeps the relevant hub note for a real task', async () => {
    const idx = index([...noteDocs(await hubNotes()), ...issueDocs(await hubIssues())]);
    const hits = await recall({
      index: idx,
      task: 'Add a helper that converts STX amounts in micro-STX to and from strings for JSON.',
      query: 'stx amount micro json bigint string',
      cutoff: 0.5,
    });
    expect(hits.map(h => h.doc.id)).toContain('note:decision/bigint-above-2-53');
    expect(hits.every(h => (h.p ?? 0) >= 0.5)).toBe(true);
  }, 60_000);
});
