import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { Event, Issue } from '../src/event.ts';
import { RunRecord } from '../src/types.ts';

const record = {
  id: 'r1',
  workflow: 'issue',
  step: 'implement',
  status: 'running',
  tries: 0,
  rounds: { implement: 1 },
  sessions: {},
  started: '2026-01-01T00:00:00Z',
};

const issue = {
  number: 7,
  title: 't',
  body: '',
  state: 'open',
  labels: [],
  author: 'a',
  url: 'https://github.com/o/r/issues/7',
};

const fails = (schema: Schema.Top, value: unknown) =>
  Schema.decodeUnknownResult(schema as Schema.Codec<unknown>)(value)._tag === 'Failure';

describe('numeric domains', () => {
  it('reads run counters as whole numbers from zero', () => {
    expect(fails(RunRecord, record)).toBe(false);
    expect(fails(RunRecord, { ...record, issue: 3 })).toBe(false);
    expect(fails(RunRecord, { ...record, tries: -1 })).toBe(true);
    expect(fails(RunRecord, { ...record, tries: 1.5 })).toBe(true);
    expect(fails(RunRecord, { ...record, rounds: { implement: -1 } })).toBe(true);
    expect(fails(RunRecord, { ...record, rounds: { implement: Number.NaN } })).toBe(true);
    expect(fails(RunRecord, { ...record, issue: 0 })).toBe(true);
  });

  it('reads issue numbers as positive whole numbers', () => {
    expect(fails(Issue, issue)).toBe(false);
    expect(fails(Issue, { ...issue, number: 0 })).toBe(true);
    expect(fails(Issue, { ...issue, dependsOn: [2.5] })).toBe(true);
    const event = { id: 'e', issue: 7, kind: 'comment', actor: 'a', bot: false, trusted: true, at: '' };
    expect(fails(Event, event)).toBe(false);
    expect(fails(Event, { ...event, issue: -7 })).toBe(true);
  });
});
