import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Schema } from 'effect';

const LabelRecord = Schema.Record({
  key: Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9-]{0,31}$/, { message: () => 'a label key is a-z, 0-9 and -' })),
  value: Schema.String.pipe(
    Schema.pattern(/^\P{Cc}{1,128}$/u, { message: () => 'a label value is 1 to 128 characters on one line' })
  ),
});

export const parseLabels = (value: unknown): typeof LabelRecord.Type =>
  Schema.decodeUnknownSync(LabelRecord, { onExcessProperty: 'error' })(value);

const labelsLog = (data: string, id: string) => {
  if (!/^(?!\.+$)[\w.-]+$/.test(id)) throw new Error(`bad run id ${id}`);
  return join(data, id, 'labels.jsonl');
};

export const readRunLabels = (data: string, id: string): typeof LabelRecord.Type => {
  const log = labelsLog(data, id);
  const labels = new Map<string, string>();
  for (const line of existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) {
    const { key, value } = JSON.parse(line) as { key: string; value: string | null };
    if (value === null) labels.delete(key);
    else labels.set(key, value);
  }
  return Object.fromEntries(labels);
};

export const writeRunLabels = (data: string, id: string, patch: Record<string, string | null>) => {
  const merged = Object.entries({ ...readRunLabels(data, id), ...patch }).filter(([, v]) => v !== null);
  parseLabels(Object.fromEntries(merged));
  const at = new Date().toISOString();
  const lines = Object.entries(patch).map(([key, value]) => `${JSON.stringify({ at, key, value })}\n`);
  mkdirSync(join(data, id), { recursive: true });
  if (lines.length) appendFileSync(labelsLog(data, id), lines.join(''));
  return readRunLabels(data, id);
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
