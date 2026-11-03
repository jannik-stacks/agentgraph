import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Schema } from 'effect';
import { writeFileAtomic } from './store.ts';

const LabelRecord = Schema.Record({
  key: Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9-]{0,31}$/, { message: () => 'a label key is a-z, 0-9 and -' })),
  value: Schema.String.pipe(
    Schema.pattern(/^\P{Cc}{1,128}$/u, { message: () => 'a label value is 1 to 128 characters on one line' })
  ),
});

export const parseLabels = (value: unknown): typeof LabelRecord.Type =>
  Schema.decodeUnknownSync(LabelRecord, { onExcessProperty: 'error' })(value);

const labelsFile = (data: string, id: string) => {
  if (!/^(?!\.+$)[\w.-]+$/.test(id)) throw new Error(`bad run id ${id}`);
  return join(data, id, 'labels.json');
};

export const readRunLabels = (data: string, id: string): typeof LabelRecord.Type =>
  existsSync(labelsFile(data, id)) ? JSON.parse(readFileSync(labelsFile(data, id), 'utf8')) : {};

export const writeRunLabels = (data: string, id: string, patch: Record<string, string | null>) => {
  const merged = Object.entries({ ...readRunLabels(data, id), ...patch }).filter(([, v]) => v !== null);
  const next = parseLabels(Object.fromEntries(merged));
  writeFileAtomic(labelsFile(data, id), next);
  return next;
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
