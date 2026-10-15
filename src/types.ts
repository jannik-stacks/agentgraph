import type { DeciderOptions } from './harnesses/opencode-decider.ts';
import type { SurfacerOptions } from './harnesses/opencode-surfacer.ts';
import type { McpServer } from './mcp-config.ts';
import type { RepoFiles } from './preload.ts';
import type { Association, DeciderQuestion, Harness, Load, Trigger } from './schema.ts';
import type { Source } from './usage.ts';

/**
 * A trigger from GitHub, a local issue tracker or the CLI, normalised so workflows never see raw payloads. `label` is
 * the label an `issues` `labeled` or `unlabeled` event is about, `parent` the parent of the event's issue when known,
 * `pull` the merge request the event is on.
 */
export type BotEvent = {
  id: string;
  ts: string;
  source: 'github' | 'local' | 'cli';
  trigger: Trigger;
  action?: string;
  repo: string;
  number?: number;
  actor: { login: string; association: Association };
  body?: string;
  url?: string;
  ref?: string;
  branch?: string;
  label?: string;
  parent?: number;
  pull?: number;
};

/** What a run needs to start an agent session. */
export type RunSpec = {
  prompt: string;
  system: string;
  cwd: string;
  model?: string;
  tools: string[];
  maxTurns?: number;
  /** The bothub MCP server serving the run's read tools, when it has any. */
  mcp?: McpServer;
  /** The repo's own instruction files and skill directories, relative to `cwd`, for the harness to load itself. */
  repo?: RepoFiles;
  /** Past-run memory for the harness to surface and search, when the bot has any. */
  surfacer?: SurfacerOptions;
  /** Decision-model questions asked during the run. */
  decider?: DeciderOptions;
  /** An earlier run's harness session to continue: its id, and the run home that holds it. */
  session?: { id: string; home: string };
};

/** Agent output, normalised across harnesses. */
export type AgentEvent =
  | { type: 'start'; session?: string; model?: string }
  | { type: 'text'; text: string }
  /** `at` is when the tool started, when the harness reports it apart from when the event was seen. */
  | { type: 'tool_call'; id: string; tool: string; input: unknown; at?: string }
  /** `ms` is how long the tool ran, when the harness reports it. */
  | { type: 'tool_result'; id: string; ok: boolean; output?: string; ms?: number }
  | {
      type: 'usage';
      /** All input of one model call, cached input included. */
      inputTokens: number;
      outputTokens: number;
      /** The part of `inputTokens` read from the provider's prompt cache. */
      cachedInputTokens?: number;
      /** The part of `inputTokens` written to the provider's prompt cache. */
      cacheWriteTokens?: number;
      reasoningTokens?: number;
      /** Why the model stopped, as the harness reports it. */
      finish?: string;
      /** What the harness says this call cost. */
      costUsd?: number;
      /** What made the call; a harness's own calls leave it out. */
      source?: Source;
      model?: string;
      /** How long the call took, when bothub made it. */
      ms?: number;
      /** The call failed; its tokens are what the provider reported, often none. */
      error?: true;
      /** The call went straight to Ollama's decision API, not through the model proxy. */
      direct?: true;
    }
  | { type: 'end'; ok: boolean; turns?: number; result?: string; costUsd?: number }
  | { type: 'error'; message: string }
  | {
      /**
       * A human in the loop: the run asked one (`ask`, posted at `url`), or started from a human's answer (`answer`,
       * by `by` at `at`) to what the run `asked` asked.
       */
      type: 'human';
      on: 'ask' | 'answer';
      url?: string;
      by?: string;
      at?: string;
      asked?: string;
    }
  | {
      /**
       * What the memory surfacer weighed: before a model turn (`turn`) or for a `history` call. Each item is a note,
       * run summary or run, with its BM25 `score`, the decision model's `p` when it judged, and the tokens it adds.
       */
      type: 'recall';
      on: 'turn' | 'history';
      query: string;
      tokens: number;
      items: {
        pointer: string;
        title?: string;
        kind?: 'note' | 'issue' | 'summary' | 'run';
        score?: number;
        p?: number;
        tokens?: number;
        fate: 'surfaced' | 'cutoff' | 'budget' | 'unjudged' | 'returned';
      }[];
      error?: string;
    }
  | {
      /**
       * One decider question answered at a hook point: `p` is the probability of yes, `call` the tool call it was
       * about, and `acted` whether the answer denied the call or added a nudge. `error` when the model could not answer.
       */
      type: 'decision';
      on: DeciderQuestion['on'];
      ask: string;
      tool?: string;
      call?: string;
      p?: number;
      threshold?: number;
      acted: boolean;
      error?: string;
    };

/** A harness adapter: pure argv construction plus line-by-line output parsing. */
export type HarnessAdapter = {
  name: Harness;
  command: (spec: RunSpec) => { cmd: string; args: string[]; env: Record<string, string> };
  parseLine: (line: string) => AgentEvent[];
  /**
   * Events the adapter knows before the harness says them, such as the model alias it was given, or the session id
   * the harness's first own `line` names; sent with the first line it returns any for.
   */
  start?: (spec: RunSpec, line: string) => AgentEvent[];
  /** What the harness can honor beyond the basics: `Load` kinds from the target repo, and `resume` context. */
  supports?: (Load | 'resume')[];
  /** Where under the run home the harness keeps its sessions, when it can continue one. */
  sessions?: string;
  /** The ids of bothub's own plugins the run loads; each marks itself loaded in the run home. */
  plugins?: (spec: RunSpec) => string[];
  /** Files the harness reads from its home, by path under it, written into the run home before it starts. */
  home?: Record<string, string>;
  /** Links in the run home, by path under it, to a path inside the run container. */
  links?: Record<string, string>;
};
