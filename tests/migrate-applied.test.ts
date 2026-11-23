import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';
import { readRunSync, readTraceSync } from '../src/store.ts';
import { makeRun, tmp, write } from './kit.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const at = { at: '2026-11-01T00:00:00Z', step: 'triage' };
const proposal = { kind: 'comment', body: 'hello' };
const refused = { proposal, ok: false, reason: 'permission denied', operation: 'write-1', extra: 'keep' };
const failed = { kind: 'failed', checks: [], proposals: [refused], problems: ['permission denied'] };
const next = { step: 'triage', status: 'waiting', tries: 1, rounds: {} };
const migrate = (dir: string) =>
  spawnSync(process.execPath, [resolve('bin/migrate-applied.ts'), dir], { encoding: 'utf8' });
const setup = (files: Record<string, string>) => {
  const dir = tmp('migrate-applied');
  dirs.push(dir);
  write(dir, files);
  return dir;
};

it('migrates applied entries and failed proposals in plain and compressed records without losing fields', () => {
  const lines = [
    { ...at, applied: { proposal, ok: true, id: 'posted', url: 'https://example.test/comment' } },
    { ...at, applied: { proposal, ok: false } },
    { ...at, applied: { proposal, ok: false, reason: '' } },
    { ...at, outcome: failed, run: { ...next, outcome: failed } },
    { ...at, saved: { outcome: failed } },
    { ...at, applied: { proposal, status: 'skipped', reason: 'not needed' } },
  ];
  const text = lines.map(line => JSON.stringify(line)).join('\n') + '\n';
  const run = {
    ...makeRun({ id: 'plain' }),
    outcome: failed,
    meta: { test: { ok: false, applied: { proposal, ok: false }, outcome: failed } },
  };
  const dir = setup({
    'plain/run.json': JSON.stringify(run),
    'plain/trace.jsonl': text,
    'compressed/run.json': JSON.stringify(makeRun({ id: 'compressed' })),
  });
  writeFileSync(join(dir, 'compressed/trace.jsonl.zst'), zstdCompressSync(text));
  const result = migrate(dir);
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  const expectedRefused = {
    proposal,
    status: 'refused',
    reason: 'permission denied',
    operation: 'write-1',
    extra: 'keep',
  };
  const expectedFailed = { ...failed, proposals: [expectedRefused] };
  expect(JSON.parse(readFileSync(join(dir, 'plain/run.json'), 'utf8'))).toEqual({ ...run, outcome: expectedFailed });
  expect(readRunSync(dir, 'plain')).toMatchObject({ id: 'plain', meta: { test: { ok: false } } });
  const rewritten = readFileSync(join(dir, 'plain/trace.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  expect(rewritten[3]).toEqual({ ...at, outcome: expectedFailed, run: { ...next, outcome: expectedFailed } });
  expect(rewritten[4]).toEqual({ ...at, saved: { outcome: expectedFailed } });
  const traces = readTraceSync(dir, 'plain');
  expect(traces).toEqual([
    { ...at, applied: { proposal, status: 'applied', id: 'posted', url: 'https://example.test/comment' } },
    { ...at, applied: { proposal, status: 'refused', reason: 'Legacy refusal (no reason recorded)' } },
    { ...at, applied: { proposal, status: 'refused', reason: '' } },
    {
      ...at,
      outcome: {
        ...expectedFailed,
        proposals: [{ proposal, status: 'refused', reason: 'permission denied', operation: 'write-1' }],
      },
      run: next,
    },
    { ...at, saved: {} },
    lines[5],
  ]);
  expect(readTraceSync(dir, 'compressed')).toEqual(traces);
  const paths = ['plain/run.json', 'plain/trace.jsonl', 'compressed/trace.jsonl.zst'];
  const before = paths.map(path => ({
    bytes: readFileSync(join(dir, path)),
    modified: statSync(join(dir, path)).mtimeMs,
  }));
  expect(migrate(dir).status).toBe(0);
  expect(
    paths.map(path => ({
      bytes: readFileSync(join(dir, path)),
      modified: statSync(join(dir, path)).mtimeMs,
    }))
  ).toEqual(before);
});

it.each([
  { proposal, ok: 'false' },
  { proposal },
  { proposal, status: 'unknown' },
  { proposal, ok: false, status: 'applied', reason: 'denied' },
  { proposal, ok: false, reason: null },
  { proposal, status: 'refused' },
])('rejects malformed Applied input before rewriting any record: %j', applied => {
  const good = JSON.stringify({ ...at, applied: { proposal, ok: true } }) + '\n';
  const bad = JSON.stringify({ ...at, outcome: { ...failed, proposals: [applied] }, run: next }) + '\n';
  const dir = setup({ 'a/trace.jsonl': good, 'z/trace.jsonl': bad });
  const result = migrate(dir);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('z/trace.jsonl:1');
  expect([readFileSync(join(dir, 'a/trace.jsonl'), 'utf8'), readFileSync(join(dir, 'z/trace.jsonl'), 'utf8')]).toEqual([
    good,
    bad,
  ]);
});

it.each(['{"at":', '{"at":}\n'])('rejects incomplete or malformed JSON without rewriting earlier files: %j', bad => {
  const good = JSON.stringify({ ...at, applied: { proposal, ok: true } }) + '\n';
  const dir = setup({ 'a/trace.jsonl': good, 'z/trace.jsonl': bad });
  const result = migrate(dir);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('z/trace.jsonl:1');
  expect(readFileSync(join(dir, 'a/trace.jsonl'), 'utf8')).toBe(good);
  expect(readFileSync(join(dir, 'z/trace.jsonl'), 'utf8')).toBe(bad);
});

it.each(['trace.jsonl', 'trace.jsonl.zst'])('preserves unrelated historical fields in %s', file => {
  const saved = { ...at, saved: { status: 'waiting' }, cleared: ['reason', 'comment'] };
  const applied = { ...at, applied: { proposal, ok: true, id: 'posted' } };
  const historical = { ...makeRun({ id: 'run' }), status: 'asking' };
  const dir = setup({ 'run/run.json': JSON.stringify(historical) });
  const path = join(dir, 'run', file);
  const text = [saved, applied].map(line => JSON.stringify(line)).join('\n') + '\n';
  writeFileSync(path, file.endsWith('.zst') ? zstdCompressSync(text) : text);
  const result = migrate(dir);
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  const bytes = readFileSync(path);
  const migrated = (file.endsWith('.zst') ? zstdDecompressSync(bytes) : bytes).toString('utf8');
  expect(
    migrated
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
  ).toEqual([saved, { ...at, applied: { proposal, status: 'applied', id: 'posted' } }]);
  expect(readFileSync(join(dir, 'run/run.json'), 'utf8')).toBe(JSON.stringify(historical));
});

it('preflights compressed malformed records before replacing plain files', () => {
  const good = JSON.stringify({ ...at, applied: { proposal, ok: true } }) + '\n';
  const dir = setup({ 'a/trace.jsonl': good, 'z/run.json': JSON.stringify(makeRun({ id: 'z' })) });
  const path = join(dir, 'z/trace.jsonl.zst');
  const packed = zstdCompressSync(JSON.stringify({ ...at, applied: { proposal, ok: null } }) + '\n');
  writeFileSync(path, packed);
  const result = migrate(dir);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('z/trace.jsonl.zst:1');
  expect(readFileSync(join(dir, 'a/trace.jsonl'), 'utf8')).toBe(good);
  expect(readFileSync(path)).toEqual(packed);
});
