import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Chunk, Effect, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { fileStore, Store, type Trace } from '../src/store.ts';
import type { Run } from '../src/workflow.ts';
import { studioDir, studioModule } from './studio.ts';

type Row = {
  at?: string;
  summary?: unknown;
  body?: { props: { r: CoreRun } };
  children?: Row[];
  raw?: unknown;
  open?: boolean;
};
type CoreRun = { fixture: string; repo: string; run: Run; trace: Trace[] };
Object.assign(globalThis, { location: new URL('http://localhost/runs') });
const { runRow } = await studioModule<{ runRow: (r: CoreRun, open?: boolean) => Row }>('runs/rows.tsx');
const dependency = <T>(name: string) =>
  import(
    /* @vite-ignore */ pathToFileURL(createRequire(join(studioDir, 'package.json')).resolve(name)).href
  ) as Promise<T>;
const { renderToStaticMarkup } = await dependency<{ renderToStaticMarkup: (node: unknown) => string }>(
  'react-dom/server'
);
const text = (row: Row | undefined) => renderToStaticMarkup(row?.summary).replace(/<[^>]+>/g, ' ');

const at = '2026-10-16T05:00:00.000Z';
const run: Run = {
  id: 'issue-1',
  issue: 1,
  started: at,
  workflow: 'issue',
  step: 'review',
  status: 'running',
  tries: 0,
  rounds: {},
  usd: 0.1,
} as Run;
const trace = [
  { at, step: 'implement', event: { type: 'start', session: 's1', model: 'smart' } },
  { at, step: 'implement', event: { type: 'text', text: 'done' } },
  { at, step: 'implement', session: { id: 's1', resumed: false, ended: 'stop', usd: 0.1 } },
  { at, step: 'implement', check: { check: 'tests', pass: true, ms: 5 } },
  {
    at,
    step: 'implement',
    outcome: { kind: 'pass' },
    run: { step: 'review', status: 'running', tries: 0, rounds: {} },
  },
  { at, step: 'review', saved: { step: 'review' } },
  { at, step: 'review', event: { type: 'start', session: 's2', model: 'smart' } },
] as Trace[];

describe('a run as rows', () => {
  const row = runRow({ fixture: 'sk/issue', repo: 'o/r', run, trace }, true);

  it('opens to its visits, each holding its sessions and the other lines, with the run in its body', () => {
    expect(row.raw).toBeUndefined();
    expect(row.body?.props.r.run).toBe(run);
    expect(row.children?.map(v => v.children?.length)).toEqual([3, 2]);
    expect(row.children?.[0]?.children?.[0]?.children?.map(c => c.raw)).toEqual(trace.slice(0, 2));
    expect(row.children?.[0]?.children?.[0]?.raw).toBe(trace[2]);
  });

  it('keeps the running session open and every trace line inspectable as raw', () => {
    const [, review] = row.children!;
    expect(review?.children?.[1]?.open).toBe(true);
    expect(row.children?.[0]?.children?.slice(1).map(c => c.raw)).toEqual(trace.slice(3, 5));
  });
});

/** Real lines from two runs, cut short: an aside, a rebase, a judged check, then two judges that failed to start. */
const real = readFileSync(join(import.meta.dirname, 'fixtures', 'interleaved-trace.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map(line => JSON.parse(line) as Trace);
const sessionsOf = (trace: Trace[]) =>
  runRow({ fixture: 'sk/issue', repo: 'o/r', run: { ...run, status: 'done' }, trace }, true)
    .children!.flatMap(visit => visit.children!)
    .filter(row => !row.raw || 'session' in (row.raw as object));

const kindOf = (line: object) => ['prompt', 'event', 'session'].find(k => k in line);

describe('sessions in a trace', () => {
  it('ties each prompt, its events and its end together in an older trace without keys', () => {
    const sessions = sessionsOf(real);
    expect(sessions.map(s => s.children?.map(c => kindOf(c.raw as object)))).toEqual([
      ['prompt', 'event', 'event', 'event', 'event'],
      ['prompt', 'event', 'event', 'event', 'event'],
      ['prompt'],
      ['prompt'],
    ]);
    expect(text(sessions[0])).toMatch(/aside .*implementor .*opencode, smart .*ended stop, exit 0, \$0\.05/);
    expect(text(sessions[2])).toContain('ended before it started: provider');
    expect(text(sessions[0]).match(/ses_eaad525edffeCrrVWpaqdOtFbY/g)).toHaveLength(1);
    expect(sessions[0]?.raw).toBe(real.find(l => 'session' in l));
  });

  it('reads an older trace with briefs and shows every tool call under its session', async () => {
    const old = await Effect.runPromise(
      Effect.flatMap(Store, store => Stream.runCollect(store.read('issue-6'))).pipe(
        Effect.map(Chunk.toArray),
        Effect.provide(fileStore(join(import.meta.dirname, 'fixtures', 'old-trace')))
      )
    );
    const [session] = sessionsOf(old);
    expect(session?.children?.map(c => kindOf(c.raw as object))).toEqual(
      old.map(kindOf).filter(k => k && k !== 'session')
    );
    expect(session?.children?.filter(c => (c.raw as { event?: { type: string } }).event?.type === 'tool')).toHaveLength(
      10
    );
    expect(text(session)).toMatch(/implementor .*opencode, smart .*10 tool calls .*ended stop, exit 0, \$0\.04/);
  });

  it('keeps sessions that ran at once apart by their key', () => {
    const audit = real.slice(real.findIndex(l => 'prompt' in l && l.prompt.agent === 'auditor'));
    const own = audit.slice(0, audit.findIndex(l => 'session' in l) + 1).filter(l => !('check' in l));
    const judged = (key: string, check: string) =>
      own.map(l => ({ ...l, key, ...('prompt' in l && { prompt: { ...l.prompt, check }, item: `${check}.ts` }) }));
    const [a, b] = [judged('a', 'names'), judged('b', 'scope')];
    const ended = { ...own.at(-1)!, key: 'c' } as Trace;
    const sessions = sessionsOf([...a.flatMap((line, i) => [line, b[i]!]), ended] as Trace[]);
    expect(sessions).toHaveLength(3);
    expect(sessions.slice(0, 2).map(s => s.children?.map(c => (c.raw as { key: string }).key))).toEqual([
      a.slice(0, -1).map(() => 'a'),
      b.slice(0, -1).map(() => 'b'),
    ]);
    expect(text(sessions[1])).toMatch(/auditor .*judges scope .*on scope\.ts .*[\d.]+k? in, \d+ out .*ended stop/);
    expect(sessions[2]?.children).toEqual([]);
    expect(sessions[2]?.raw).toBe(ended);
    expect(text(sessions[2]).match(/ended/g)).toHaveLength(1);
    expect(text(sessions[2])).toContain('ended before it started: stop, exit 0');
  });
});
