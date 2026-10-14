import type { Harness } from '../schema.ts';
import type { HarnessAdapter } from '../types.ts';
import { claude } from './claude.ts';
import { opencode } from './opencode.ts';
import { pi } from './pi.ts';

/** Every supported harness, keyed by the bot's `harness`. */
export const harnesses: Record<Harness, HarnessAdapter> = { opencode, pi, claude };
