import type { Executor } from '../schema.ts';
import type { ExecutorAdapter } from '../types.ts';
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import { opencode } from './opencode.ts';
import { pi } from './pi.ts';

/** Every supported harness, keyed by the bot's `harness`. */
export const executors: Record<Executor, ExecutorAdapter> = { 'claude-code': claude, codex, opencode, pi };
