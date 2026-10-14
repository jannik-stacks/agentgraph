import { readFile } from 'node:fs/promises';

/** Whether an error says the file or directory does not exist. */
export const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

/** The records of a JSON-lines file. A missing file has none, and a line that does not parse, such as a half-written last one, is skipped. */
export const readJsonl = async <T>(file: string): Promise<T[]> =>
  (await readFile(file, 'utf8').catch(e => (missing(e) ? '' : Promise.reject(e)))).split('\n').flatMap(line => {
    try {
      return line ? [JSON.parse(line) as T] : [];
    } catch {
      return [];
    }
  });
