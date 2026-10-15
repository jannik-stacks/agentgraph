import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EventRecord } from '../src/store.ts';
import { studioDir, studioModule } from './studio.ts';

const studioRequire = createRequire(join(studioDir, 'package.json'));
const dependency = <T>(name: string) =>
  import(/* @vite-ignore */ pathToFileURL(studioRequire.resolve(name)).href) as Promise<T>;

const records: EventRecord[] = [
  { ts: '', seq: 0, event: { type: 'start', model: 'smart' } },
  {
    ts: '',
    seq: 1,
    event: {
      type: 'recall',
      on: 'turn',
      query: 'Fix the fee crash',
      tokens: 42,
      items: [
        { pointer: 'r-fees#2-3', title: 'tool', kind: 'summary', score: 3.2, p: 0.92, tokens: 30, fate: 'surfaced' },
        {
          pointer: 'notes/decision/bigint-amounts.md',
          title: 'Amounts are bigint',
          kind: 'note',
          score: 2.1,
          p: 0.85,
          tokens: 12,
          fate: 'surfaced',
        },
        { pointer: 'r-docs#0-0', title: 'text', kind: 'summary', score: 0.4, p: 0.1, tokens: 20, fate: 'cutoff' },
      ],
    },
  },
  { ts: '', seq: 2, event: { type: 'recall', on: 'history', query: 'nonce', tokens: 3, items: [] } },
];

describe('Recalled step', () => {
  it('shows one row per surfaced item with its score and tokens, and what each lookup left out', async () => {
    Object.assign(globalThis, {
      location: { pathname: '/', search: '', origin: 'http://127.0.0.1' },
      requestIdleCallback: () => 0,
    });
    const { createElement } = await dependency<{ createElement: (t: unknown, p?: object) => unknown }>('react');
    const { renderToString } = await dependency<{ renderToString: (node: unknown) => string }>('react-dom/server');
    const view = await studioModule<{
      recallsOf: (r: EventRecord[]) => unknown[];
      RecalledHead: unknown;
      RecalledRows: unknown;
    }>('runs/render/recall.tsx');
    const recalls = view.recallsOf(records);
    expect(recalls).toHaveLength(2);
    const head = renderToString(createElement(view.RecalledHead, { recalls }));
    expect(head).toContain('Recalled');
    expect(head).toContain('2<!-- --> items');
    expect(head).toContain('45');
    const rows = renderToString(createElement(view.RecalledRows, { recalls }));
    expect(rows).toContain('r-fees#2-3');
    expect(rows).toContain('Amounts are bigint');
    expect(rows).toContain('0.92');
    expect(rows).toContain('Fix the fee crash');
    expect(rows).toContain('1 left out');
    expect(rows).toContain('r-docs#0-0 0.10: below the cutoff');
    expect(rows).toContain('nothing matched the history query');
    expect(rows).not.toContain(' title=');
  });
});
