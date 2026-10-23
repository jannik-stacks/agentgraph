import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { checkLogs } from './store.ts';

/**
 * A local instance: `instance.yaml` names the repo it reads, its base branch and the trusted owner, beside the hub in
 * `hub/`, the forge folder in `forge/`, the data dir in `data/` and an optional `keys.env`. `logs` says which check
 * output the data dir keeps.
 */
type Instance = {
  dir: string;
  repo: string;
  base: string;
  owner: string;
  hub: string;
  forge: string;
  data: string;
  keys: string;
  logs?: (typeof checkLogs)[number];
};

/** The instance that holds `from`, looking up from it; undefined outside one. */
export const instanceAt = (from: string): Instance | undefined => {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const file = join(dir, 'instance.yaml');
    if (existsSync(file)) {
      const own = parse(readFileSync(file, 'utf8')) as Pick<Instance, 'repo' | 'base' | 'owner' | 'logs'>;
      const at = (name: string) => join(dir, name);
      return { ...own, dir, hub: at('hub'), forge: at('forge'), data: at('data'), keys: at('keys.env') };
    }
    if (dirname(dir) === dir) return undefined;
  }
};
