import { readdirSync } from 'node:fs';

export const readDirOrEmpty = (dir: string) => readDirEntriesOrEmpty(dir).map(e => e.name);

export const readDirEntriesOrEmpty = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return readOrUndefined(e) ?? [];
  }
};

export const readOrUndefined = (error: unknown): undefined => {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
};
