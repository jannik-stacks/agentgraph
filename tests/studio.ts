import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The studio sources, which the root typecheck leaves to the studio's own tsconfig. */
export const studioDir = join(import.meta.dirname, '..', 'studio');

/** Imports a module under `studio/src` without pulling it into the root typecheck. */
export const studioModule = <T>(path: string): Promise<T> =>
  import(/* @vite-ignore */ pathToFileURL(join(studioDir, 'src', path)).href) as Promise<T>;
