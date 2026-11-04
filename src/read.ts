import { readdirSync } from 'node:fs';

export const readDirOrEmpty = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch (e) {
    return readOrUndefined(e) ?? [];
  }
};

export const readOrUndefined = (error: unknown): undefined => {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
};
