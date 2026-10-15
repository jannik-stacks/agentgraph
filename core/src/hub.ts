import { Data, Schema, type Effect } from 'effect';
import type { Check } from './check.ts';
import type { Proposal } from './forge.ts';
import { todo } from './todo.ts';
import type { Doc, Problem, Workflow } from './workflow.ts';

export type Harness = 'claude' | 'opencode' | 'pi';

const kinds = [
  'reply',
  'label',
  'push',
  'pull',
  'merge',
  'issue',
  'ask',
  'back',
] as const satisfies readonly Proposal['kind'][];

/** A bot file's frontmatter. */
export const Bot = Schema.Struct({
  harness: Schema.Literal('claude', 'opencode', 'pi'),
  model: Schema.optionalWith(Schema.String, { exact: true }),
  tools: Schema.optionalWith(Schema.mutable(Schema.Array(Schema.String)), { default: () => [] }),
  returns: Schema.optionalWith(Schema.mutable(Schema.Array(Schema.Literal(...kinds))), { default: () => ['reply'] }),
});
export type Bot = typeof Bot.Type;

/** The hub-wide limits block. */
export const Limits = Schema.Struct({
  minutes: Schema.optionalWith(Schema.Number, { default: () => 30 }),
  usdPerRun: Schema.optionalWith(Schema.Number, { default: () => 10 }).pipe(Schema.fromKey('usd-per-run')),
  working: Schema.optionalWith(Schema.Int, { default: () => 2 }),
});
export type Limits = typeof Limits.Type;

/** One repo's hub after `uses:` and the repo override are merged. */
export type Hub = {
  repo: string;
  sha: string;
  bots: Record<string, Doc<Bot>>;
  skills: Record<string, Doc<{ description?: string }>>;
  checks: Record<string, Doc<Check>>;
  workflows: Record<string, Workflow>;
  limits: Limits;
};

export class HubError extends Data.TaggedError('HubError')<{ problems: Problem[] }> {}

/** Reads a hub directory, validates every file and fails with all problems at once. */
export const loadHub = (_dir: string): Effect.Effect<Hub, HubError> => todo('loadHub');
