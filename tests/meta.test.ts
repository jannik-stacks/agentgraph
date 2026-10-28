import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { RunMeta } from '../src/meta.ts';

const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;
const accessor = Object.defineProperty({}, 'value', { get: () => 'hidden', enumerable: true });

describe('run metadata', () => {
  it.each([
    { bench: null },
    { bench: [true, 1, 'a', { nested: false }] },
    { bench: Object.create(null) },
    { engine: { origin: { plugin: 'bench', version: 'v1', job: 'smoke', input: {} } } },
    { engine: { continued: { plugin: 'tune', version: 'v1', job: 'round1', input: null, at: 'now' } } },
  ])('accepts public JSON %j', value => {
    expect(Schema.decodeUnknownSync(RunMeta)(value)).toEqual(value);
  });

  it.each([
    { bench: undefined },
    { bench: () => 1 },
    { bench: 1n },
    { bench: Infinity },
    { bench: NaN },
    { bench: new Date() },
    { bench: cyclic },
    { bench: accessor },
    { bench: { [Symbol('key')]: 1 } },
    { bench: Array(1) },
    { 'bad-owner': {} },
    { engine: { origin: { plugin: 'bench' } } },
    { engine: { anything: true } },
    { bench: 'é'.repeat(4096) },
    Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`owner${i}`, 'x'.repeat(7000)])),
    { bench: Array.from({ length: 34 }).reduce<unknown>(value => [value], null) },
    new Date(),
  ])('rejects invalid or oversized metadata %#', value => {
    expect(Schema.decodeUnknownEither(RunMeta)(value)._tag).toBe('Left');
  });
});
