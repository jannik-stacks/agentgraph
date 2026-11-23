import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { Applied } from '../src/event.ts';
import { parseJson } from '../src/read.ts';
import { writeFileAtomic } from '../src/store.ts';

const requireObject = (value: unknown, at: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${at}: expected an object`);
  return value as Record<string, unknown>;
};

const migrateApplied = (value: unknown, at: string) => {
  const applied = requireObject(value, at);
  if ('ok' in applied) {
    if (typeof applied.ok !== 'boolean') throw new Error(`${at}: expected boolean ok`);
    const status = applied.ok ? 'applied' : 'refused';
    if ('status' in applied && applied.status !== status) throw new Error(`${at}: conflicting ok and status`);
    applied.status = status;
    if (!applied.ok && !('reason' in applied)) applied.reason = 'Legacy refusal (no reason recorded)';
    delete applied.ok;
  }
  parseJson(Applied, JSON.stringify(applied), at);
};

const migrateEnvelope = (value: unknown, at: string, run: boolean) => {
  const record = requireObject(value, at);
  if (!run && 'applied' in record) migrateApplied(record.applied, `${at}.applied`);
  if ('outcome' in record) migrateOutcome(record.outcome, `${at}.outcome`);
  if (run) return record;
  for (const key of ['saved', 'run']) {
    if (!(key in record)) continue;
    const snapshot = requireObject(record[key], `${at}.${key}`);
    if ('outcome' in snapshot) migrateOutcome(snapshot.outcome, `${at}.${key}.outcome`);
  }
  return record;
};

const migrateOutcome = (value: unknown, at: string) => {
  const outcome = requireObject(value, at);
  if (outcome.kind === 'failed' && 'proposals' in outcome) {
    if (!Array.isArray(outcome.proposals)) throw new Error(`${at}.proposals: expected an array`);
    outcome.proposals.forEach((applied, i) => migrateApplied(applied, `${at}.proposals[${i}]`));
  }
};

try {
  const { positionals } = parseArgs({ allowPositionals: true });
  if (positionals.length !== 1) throw new Error('usage: node bin/migrate-applied.ts <store-data-directory>');
  const dir = positionals[0]!;
  const writes: { path: string; content: string | Uint8Array }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = join(dir, entry.name);
    for (const file of readdirSync(runDir, { withFileTypes: true })) {
      if (!['run.json', 'trace.jsonl', 'trace.jsonl.zst'].includes(file.name)) continue;
      const path = join(runDir, file.name);
      if (!file.isFile()) throw new Error(`${path}: expected a regular file`);
      const compressed = file.name.endsWith('.zst');
      const bytes = readFileSync(path);
      const text = (compressed ? zstdDecompressSync(bytes) : bytes).toString('utf8');
      let changed = false;
      const migrate = (line: string, at: string, run: boolean) => {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch (cause) {
          throw new Error(`${at}: ${String(cause)}`, { cause });
        }
        const before = JSON.stringify(value);
        const record = migrateEnvelope(value, at, run);
        const after = JSON.stringify(record);
        if (after === before) return line;
        changed = true;
        return run ? `${JSON.stringify(record, null, 2)}\n` : after;
      };
      const content =
        file.name === 'run.json'
          ? migrate(text, path, true)
          : text
              .split('\n')
              .map((line, i) => (line ? migrate(line, `${path}:${i + 1}`, false) : line))
              .join('\n');
      if (changed) writes.push({ path, content: compressed ? zstdCompressSync(content) : content });
    }
  }
  for (const { path, content } of writes) writeFileAtomic(path, content);
  console.log(`Migrated ${writes.length} files`);
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
}
