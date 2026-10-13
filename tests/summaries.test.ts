import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pipeline } from '../src/pipeline/context.ts';
import { attemptSummary } from '../src/pipeline/continue.ts';
import type { EventRecord, Outcome, Run } from '../src/store.ts';
import {
  extract,
  fit,
  items,
  modelLine,
  outcomeRecords,
  readSummaries,
  summarizeEvents,
  summarizeOutcome,
  summarizeRun,
  Summarizer,
} from '../src/summaries.ts';
import type { AgentEvent } from '../src/types.ts';

const fixture = new URL('./fixtures/recorded-run.jsonl', import.meta.url).pathname;

const records = (...events: AgentEvent[]): EventRecord[] => events.map((event, seq) => ({ ts: '', seq, event }));

const tool = (id: string, name: string, input: unknown, output: string, ok = true): AgentEvent[] => [
  { type: 'tool_call', id, tool: name, input },
  { type: 'tool_result', id, ok, output },
];

describe('summaries', () => {
  it('leaves out reads and searches unless they failed', () => {
    const lines = items(
      records(
        ...tool('a', 'read', { filePath: '/work/src/a.ts' }, '<path>/work/src/a.ts</path>\n1: x'),
        ...tool('b', 'grep', { pattern: 'x' }, 'Found 2 matches'),
        ...tool('c', 'read', { filePath: '/work/src/gone.ts' }, 'File not found: /work/src/gone.ts', false)
      )
    ).map(i => i.line);
    expect(lines).toEqual(['tool read src/gone.ts: error, File not found: /work/src/gone.ts']);
  });

  it('says what changed per file instead of the edit text', () => {
    const all = items(
      records(
        ...tool('a', 'edit', { filePath: '/work/src/a.ts', oldString: 'x', newString: 'y\nz' }, 'Edit applied.'),
        ...tool('b', 'write', { filePath: '/work/src/b.ts', content: 'one\ntwo\nthree' }, 'Wrote file.'),
        ...tool('c', 'edit', { filePath: '/work/src/a.ts', oldString: 'p\nq', newString: '' }, 'Edit applied.')
      )
    );
    expect(all.map(i => [i.kind, i.from, i.to, i.line])).toEqual([
      ['edit', 0, 5, 'edited src/a.ts: 2 edits, +2 -3 lines'],
      ['edit', 2, 3, 'edited src/b.ts: 1 edit, +3 -0 lines'],
    ]);
  });

  it('keeps the last run of a repeated command, with the line that tells how it went', () => {
    const tsc = { command: 'npx tsc --noEmit' };
    const vitest = { command: 'npx vitest run', workdir: '/work' };
    const lines = items(
      records(
        ...tool('a', 'bash', tsc, "src/a.ts(1,1): error TS2322: Type 'x' is not assignable"),
        ...tool(
          'b',
          'bash',
          vitest,
          ' RUN v5 /work\n Test Files 1 failed\n Tests 2 failed | 8 passed (10)\n Duration 1s'
        ),
        ...tool('c', 'bash', tsc, ''),
        ...tool('d', 'bash', { command: 'false' }, 'boom\nmore', false)
      )
    ).map(i => i.line);
    expect(lines).toEqual([
      'tool bash command=npx vitest run: ok, Tests 2 failed | 8 passed (10)',
      'tool bash command=npx tsc --noEmit: ok',
      'tool bash command=false: error, boom',
    ]);
  });

  it('spells out a bothub block and keeps the names after the first sentence, each once', () => {
    const block = '```bothub\n[{ "kind": "reply", "body": "PASS\\n`src/a.ts:4` is fine." }]\n```';
    expect(items(records({ type: 'text', text: block }))[0]!.line).toBe('text: reply PASS [src/a.ts:4]');
    expect(
      extract('## Plan\nFixed `parseFee`. Then `parseFee`, `src/fees.ts` and src/fees.ts\\nlater, with `ps`.')
    ).toBe('Fixed `parseFee`. [src/fees.ts]');
  });

  it('keeps every line of a real run within the byte cap, and none when off', async () => {
    const all = (await readFile(fixture, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as EventRecord);
    const out = summarizeEvents('r1', all, Summarizer.parse({ 'max-bytes': 100 }));
    expect(out.length).toBeGreaterThan(5);
    for (const r of out) expect(Buffer.byteLength(r.line)).toBeLessThanOrEqual(100);
    expect(out.some(r => r.line.startsWith('tool read ') && r.line.includes(': ok'))).toBe(false);
    expect(summarizeEvents('r1', all, Summarizer.parse('off'))).toEqual([]);
  });

  it('accepts the short forms of the setting', () => {
    expect(Summarizer.parse('extractive')).toEqual({ mode: 'extractive', 'max-bytes': 512 });
    expect(Summarizer.parse('small')).toMatchObject({ mode: 'model', model: 'small' });
    expect(Summarizer.safeParse({ mode: 'model' }).success).toBe(false);
  });

  it('cuts at the last separator under the cap', () => {
    expect(fit('alpha beta; gamma delta epsilon', 20)).toBe('alpha beta…');
    expect(Buffer.byteLength(fit('ääää ääää ääää', 12))).toBeLessThanOrEqual(12);
    expect(fit('short', 20)).toBe('short');
  });
});

const run = { id: 'r1', workflow: 'issue', job: 'implement', status: 'succeeded', closure: 'blocked' } as Run;
const outcome = {
  proposals: [
    { kind: 'push', branch: 'bothub/7', files: ['src/a.ts', 'src/b.ts'] },
    { kind: 'label', add: ['triaged'] },
    { kind: 'ask', question: 'May I widen the scope?' },
  ],
  rejected: [{ proposal: { kind: 'merge', request: 3 }, reason: 'not allowed' }],
  results: [{ kind: 'push', status: 'applied', sha: '0123456789abcdef' }],
  checks: [
    { check: 'scope', pass: false, gating: true, findings: 'src/c.ts is outside the brief. It changes `parseFee`.' },
    { check: 'tone', pass: false, gating: false, findings: 'Reads like an ad.' },
    { check: 'tests', pass: true, gating: true },
  ],
} as unknown as Outcome;

describe('outcome summaries', () => {
  it('says how the run ended, each proposal once, and the gist of each failed check', () => {
    expect(outcomeRecords(run, outcome, 9).map(r => [r.id, r.kind, r.from, r.line])).toEqual([
      [
        'r1:outcome',
        'outcome',
        9,
        'outcome: succeeded, blocked; proposed push bothub/7 src/a.ts, src/b.ts; label triaged; ask May I widen the scope?; rejected merge 3: not allowed; landed push 0123456789ab',
      ],
      ['r1:check:scope', 'check', 9, 'check scope failed: src/c.ts is outside the brief. [parseFee]'],
      ['r1:check:tone', 'check', 9, 'check tone (log) failed: Reads like an ad.'],
    ]);
    expect(
      outcomeRecords({ id: 'r1', workflow: 'w', job: 'j', status: 'failed', error: 'timed out' } as Run, undefined, 0)
    ).toEqual([expect.objectContaining({ line: 'outcome: failed, timed out' })]);
  });

  it('appends after the last event, so the run reads in order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'summaries-'));
    await mkdir(join(dir, 'runs', 'r1'), { recursive: true });
    await writeFile(join(dir, 'runs', 'r1', 'events.jsonl'), await readFile(fixture, 'utf8'));
    await summarizeRun(dir, 'r1', Summarizer.parse('extractive'));
    await summarizeOutcome(dir, run, outcome);
    const all = await readSummaries(dir, 'r1');
    expect(all.slice(-3).map(r => r.kind)).toEqual(['outcome', 'check', 'check']);
  });
});

describe('resume summary', () => {
  it('reads the stored summaries with how the run ended, else summarizes the events, last lines first to go', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'summaries-'));
    await mkdir(join(dir, 'runs', 'r1'), { recursive: true });
    await writeFile(join(dir, 'runs', 'r1', 'events.jsonl'), await readFile(fixture, 'utf8'));
    const events = records({ type: 'text', text: 'Working on it.' });
    const p = (data?: string) =>
      ({ ...(data && { data }), store: { events: async () => events } }) as unknown as Pipeline;
    expect(await attemptSummary(run, p())).toBe('- text: Working on it.');
    await summarizeRun(dir, 'r1', Summarizer.parse('extractive'));
    await summarizeOutcome(dir, run, outcome);
    const lines = (await attemptSummary(run, p(dir)))!.split('\n');
    expect(lines.length).toBeLessThanOrEqual(40);
    expect(lines.at(-3)).toMatch(/^- outcome: succeeded, blocked; proposed push bothub\/7/);
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
    const dir = await mkdtemp(join(tmpdir(), 'summaries-'));
    await mkdir(join(dir, 'runs', 'r1'), { recursive: true });
    await writeFile(join(dir, 'runs', 'r1', 'events.jsonl'), await readFile(fixture, 'utf8'));
    chat(...Array.from({ length: 200 }, () => 'model line'));
    const written = await summarizeRun(dir, 'r1', settings, { endpoint });
    const current = await readSummaries(dir, 'r1');
    expect(written.length).toBeGreaterThan(current.length);
    expect(current.every(r => r.by === 'small' || Buffer.byteLength(r.line) <= 64)).toBe(true);
    expect(current.some(r => r.line === 'model line' && r.by === 'small')).toBe(true);
  });
});
