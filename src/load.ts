import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceFile } from './config.ts';

/** Reads `personas/*.md` and `workflows/*.md` from a hub directory. Missing directories count as empty. */
export const readHub = async (dir: string): Promise<SourceFile[]> => {
  const groups = await Promise.all(
    ['personas', 'workflows'].map(async (sub) => {
      const names = await readdir(join(dir, sub)).catch(() => []);
      return Promise.all(
        names
          .filter((name) => name.endsWith('.md'))
          .sort()
          .map(async (name) => ({ path: `${sub}/${name}`, source: await readFile(join(dir, sub, name), 'utf8') })),
      );
    }),
  );
  return groups.flat();
};
