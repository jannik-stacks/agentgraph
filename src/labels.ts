import { join } from 'node:path';
import { Effect, Schema } from 'effect';
import { appendJsonlRows, readJsonlRows } from './store.ts';

const LabelRecord = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/, { message: 'a label key is a-z, 0-9 and -' })),
  Schema.String.check(
    Schema.isPattern(/^\P{Cc}{1,128}$/u, { message: 'a label value is 1 to 128 characters on one line' })
  )
);

export const parseLabels = (value: unknown): typeof LabelRecord.Type =>
  Schema.decodeUnknownSync(LabelRecord, { onExcessProperty: 'error' })(value);

const labelsLog = (data: string, id: string) => {
  if (!/^(?!\.+$)[\w.-]+$/.test(id)) throw new Error(`bad run id ${id}`);
  return join(data, id, 'labels.jsonl');
};

export const readRunLabels = (data: string, id: string): typeof LabelRecord.Type => {
  const labels = new Map<string, string>();
  for (const row of readJsonlRows(labelsLog(data, id))) {
    const { key, value } = row as { key: string; value: string | null };
    if (value === null) labels.delete(key);
    else labels.set(key, value);
  }
  return Object.fromEntries(labels);
};

export const writeRunLabels = (data: string, id: string, patch: Record<string, string | null>) => {
  const log = labelsLog(data, id);
  parseLabels(
    Object.fromEntries(Object.entries({ ...readRunLabels(data, id), ...patch }).filter(([, v]) => v !== null))
  );
  const at = new Date().toISOString();
  const rows = Object.entries(patch).map(([key, value]) => ({ at, key, value }));
  return Effect.map(rows.length ? appendJsonlRows(log, rows) : Effect.void, () => readRunLabels(data, id));
};

export const parseLabelPatch = (words: readonly string[]): Record<string, string | null> =>
  Object.fromEntries(
    words.map(word => {
      const set = /^([^=]+)=(.*)$/.exec(word);
      if (set) return [set[1]!, set[2]!];
      if (word.endsWith('-')) return [word.slice(0, -1), null];
      throw new Error(`${word}: write a label as key=value, or key- to remove it`);
    })
  );
