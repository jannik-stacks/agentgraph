import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compile, type Config } from '../src/config.ts';
import { parseIssue } from '../src/issues-local.ts';
import { readHub } from '../src/load.ts';
import { parseMarkdown } from '../src/markdown.ts';
import { accepted } from '../src/preload.ts';
import { NoteKind } from '../src/schema.ts';
import {
  index,
  issueDocs,
  judgeWith,
  lineOf,
  noteDocs,
  weigh,
  stem,
  summaryDocs,
  synonyms,
  terms,
  type Doc,
  type Judge,
} from '../src/recall.ts';
import { askerOf, history, loadSummaries, summarizeRun, Summarizer, type History } from '../src/summaries.ts';
import { tokensOf } from '../src/usage.ts';

const hub = new URL('../examples/acme-app/', import.meta.url).pathname;
const fixture = new URL('./fixtures/recorded-run.jsonl', import.meta.url).pathname;

const hubNotes = async (): Promise<Config['notes']> => {
  const notes: Config['notes'] = [];
  for (const kind of NoteKind.options)
    for (const file of await readdir(join(hub, 'notes', kind))) {
      const path = join(hub, 'notes', kind, file);
      const { data, body } = parseMarkdown(await readFile(path, 'utf8'));
      notes.push({
        ...(data as { title: string }),
        kind,
        name: file.replace(/\.md$/, ''),
        path,
        body,
      });
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

type Seen = {
  id: string;
  bot: string;
  job?: string;
  event?: string;
  number?: number;
};

const runDir = async (runs: Seen[]) => {
  const dir = await mkdtemp(join(tmpdir(), 'recall-'));
  for (const { id, bot, job = 'j', event = id, number } of runs) {
    await mkdir(join(dir, 'runs', id), { recursive: true });
    const on = {
      id: event,
      repo: 'acme/app',
      ...(number !== undefined && { number }),
    };
    await writeFile(
      join(dir, 'runs', id, 'run.json'),
      JSON.stringify({
        id,
        bot,
        workflow: 'w',
        job,
        status: 'succeeded',
        event: on,
      })
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

  const kept = async (options: Parameters<typeof weigh>[0]) =>
    (await weigh(options)).weighed.filter(w => w.fate === 'kept');

  it('limits recall and history to how far the asking bot reaches', async () => {
    const dir = await runDir(runs);
    const records = await loadSummaries(dir);
    expect(new Set(records.map(r => r.run))).toEqual(new Set(['a', 'b', 'c', 'd']));
    const idx = index(summaryDocs(records.filter(r => r.run !== 'd')));
    const reach = async (scope: History) => {
      const asker = await askerOf(dir, 'd', 'implementor', scope);
      const recalled = await kept({
        index: idx,
        query: 'bothub_issues_get',
        asker,
        top: 50,
        budget: 1e6,
      });
      const listed = (await history(dir, asker).list()).filter(r => r.id !== 'd');
      return {
        recalled: new Set(recalled.map(h => h.doc.pointer.split('#')[0])),
        listed: listed.map(r => r.id),
      };
    };
    expect(await reach('hub')).toEqual({
      recalled: new Set(['a', 'b', 'c']),
      listed: ['c', 'b', 'a'],
    });
    expect(await reach('bot')).toEqual({
      recalled: new Set(['a', 'c']),
      listed: ['c', 'a'],
    });
    expect(await reach('issue')).toEqual({
      recalled: new Set(['a', 'b']),
      listed: ['b', 'a'],
    });
    expect(await reach('run')).toEqual({
      recalled: new Set(['a']),
      listed: ['a'],
    });
    expect(await reach('none')).toEqual({ recalled: new Set(), listed: [] });
  });

  it('reads only runs the asker may see', async () => {
    const dir = await runDir(runs);
    const h = history(dir, await askerOf(dir, 'd', 'checker', 'issue'));
    expect(await h.read('c')).toBeUndefined();
    expect((await h.read('b', { from: 0, to: 1 }))?.length).toBe(2);
  });

  it('loads only the summaries of runs it keeps', async () => {
    const dir = await runDir(runs);
    const records = await loadSummaries(dir, origin => origin.event?.number === 9);
    expect(new Set(records.map(r => r.run))).toEqual(new Set(['c']));
  });
});

const scripted =
  (p: Record<string, number>): Judge =>
  async (_query, docs) =>
    docs.map(d => p[d.id]);

describe('weigh', () => {
  const idx = index([
    doc('fees', 'Fee estimation', 'Fees are bigint values; estimate fees before signing.'),
    doc('nonce', 'Nonce gaps', 'A nonce gap stalls later transactions; fees do not help.'),
    doc('docs', 'Docs style', 'No middle dots in docs; fees are mentioned in passing.'),
  ]);
  const ids = async (options: Omit<Parameters<typeof weigh>[0], 'index'>) =>
    (await weigh({ index: idx, ...options })).weighed.map(w => `${w.doc.id}:${w.fate}`);

  it('keeps the search order of what the judge scores at or above the cutoff', async () => {
    expect(
      await ids({
        query: 'estimate fees',
        judge: scripted({ fees: 0.6, nonce: 0.9, docs: 0.2 }),
      })
    ).toEqual(['fees:kept', 'nonce:kept', 'docs:cutoff']);
  });

  it('keeps a candidate the judge left unscored', async () => {
    expect(await ids({ query: 'estimate fees', judge: scripted({ fees: 0.1 }) })).toEqual([
      'fees:cutoff',
      'nonce:kept',
      'docs:kept',
    ]);
  });

  it('keeps at most top candidates', async () => {
    expect(await ids({ query: 'estimate fees', top: 1 })).toEqual(['fees:kept', 'nonce:budget', 'docs:budget']);
  });

  it('charges each candidate the tokens of the line the bot reads', async () => {
    const first = tokensOf(lineOf(idx.search('estimate fees')[0]!.doc).length + 1);
    expect(await ids({ query: 'estimate fees', budget: first })).toEqual(['fees:kept', 'nonce:budget', 'docs:budget']);
  });

  it('keeps the search order and says why when the judge fails', async () => {
    const { weighed, error } = await weigh({
      index: idx,
      query: 'estimate fees',
      judge: async () => {
        throw new Error('offline');
      },
    });
    expect(error).toBe('offline');
    expect(weighed.map(w => w.fate)).toEqual(['kept', 'kept', 'kept']);
  });
});

describe('lineOf', () => {
  it('shows a note whole under its kind and slug', () => {
    expect(lineOf(doc('n', 'Fees', 'Fees are bigint.', { pointer: 'caveat/fees' }))).toBe(
      '### caveat/fees: Fees\nFees are bigint.'
    );
  });

  it('cuts a text past 1,600 characters', () => {
    expect(lineOf(doc('n', 'Long', 'x'.repeat(2000))).endsWith(`${'x'.repeat(1600)}…`)).toBe(true);
  });
});

describe('judgeWith', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('scores each document and leaves out what the chat model did not answer', async () => {
    const fetch = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"c0": 0.9}' } }],
          })
        )
    );
    vi.stubGlobal('fetch', fetch);
    const judge = judgeWith('luna', { llm: { url: 'http://litellm:4000/v1' } });
    expect(await judge('estimate fees', [doc('fees', 'Fees', 'a'), doc('nonce', 'Nonce', 'b')])).toEqual([
      0.9,
      undefined,
    ]);
    const asked = JSON.parse(String(fetch.mock.calls[0]?.[1].body)).messages[1].content as string;
    expect(asked).toContain('<state>\nTask:\nestimate fees\n</state>');
    expect(asked).toContain('c1: Does this note name a pitfall or rule specific to this task');
  });
});

const evalRows = (await readFile(new URL('./fixtures/recorded-eval.jsonl', import.meta.url), 'utf8'))
  .split('\n')
  .filter(Boolean)
  .map(
    line =>
      JSON.parse(line) as {
        source: string;
        kind: string;
        query: string;
        relevant: string[];
      }
  );

const bothubIndex = async () => {
  const hubDir = new URL('../examples/bothub/', import.meta.url).pathname;
  const compiled = compile(await readHub(hubDir));
  if (!compiled.ok) throw new Error('the bothub hub does not compile');
  return index(noteDocs(compiled.config.notes.filter(accepted)));
};

/** Precision of what is shown and recall of what is relevant, over every labelled query. */
const score = (shown: { relevant: string[]; kept: string[] }[]) => {
  const hits = shown.reduce((n, s) => n + s.kept.filter(k => s.relevant.includes(k)).length, 0);
  const kept = shown.reduce((n, s) => n + s.kept.length, 0);
  const wanted = shown.reduce((n, s) => n + Math.min(3, s.relevant.length), 0);
  return {
    precision: kept ? hits / kept : 0,
    recall: hits / wanted,
    shown: kept,
  };
};

const ranked = async (judge?: Judge) => {
  const idx = await bothubIndex();
  return Promise.all(
    evalRows.map(async row => ({
      relevant: row.relevant,
      kept: (
        await weigh({
          index: idx,
          query: row.query,
          budget: 1e6,
          ...(judge && { judge }),
        })
      ).weighed
        .filter(w => w.fate === 'kept')
        .map(w => w.doc.pointer),
    }))
  );
};

describe('recall on the labelled bothub tasks', () => {
  it('finds a relevant note in the top three for most briefs and issues', async () => {
    const shown = (await ranked()).filter((_, i) => evalRows[i]!.kind !== 'item');
    expect(shown.filter(s => s.kept.some(k => s.relevant.includes(k))).length).toBeGreaterThanOrEqual(9);
  });
});

const checkerKey = () =>
  parseEnv(readFileSync(new URL('../infra/local/.keys.env', import.meta.url), 'utf8')).BOTHUB_LLM_API_KEY_CHECKER;

describe.skipIf(process.env.BOTHUB_LIVE !== '1')('recall judges on the labelled bothub tasks', () => {
  const judges: Record<string, () => Judge | undefined> = {
    'BM25 only': () => undefined,
    'tev1:0.8b': () => judgeWith('tev1:0.8b', { timeoutMs: 120_000 }),
    luna: () =>
      judgeWith('luna', {
        llm: { url: 'http://127.0.0.1:4000/v1', apiKey: checkerKey() ?? '' },
        timeoutMs: 120_000,
      }),
  };

  it.each(Object.keys(judges))('measures %s', { timeout: 600_000 }, async name => {
    console.log(name, score(await ranked(judges[name]!())));
  });
});
