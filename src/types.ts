import type { Association, Executor, Trigger } from './schema.ts';

/** A trigger from GitHub or the CLI, normalised so workflows never see raw payloads. */
export type BotEvent = {
  id: string;
  ts: string;
  source: 'github' | 'cli';
  trigger: Trigger;
  action?: string;
  repo: string;
  number?: number;
  actor: { login: string; association: Association };
  body?: string;
  url?: string;
  ref?: string;
};

/** What a run needs to start an agent session. */
export type RunSpec = {
  prompt: string;
  system: string;
  cwd: string;
  model?: string;
  tools: string[];
  maxTurns: number;
};

/** Agent output, normalised across executors. */
export type AgentEvent =
  | { type: 'start'; session?: string; model?: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; tool: string; input: unknown }
  | { type: 'tool_result'; id: string; ok: boolean; output?: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'end'; ok: boolean; turns?: number; result?: string; costUsd?: number }
  | { type: 'error'; message: string };

/** A harness adapter: pure argv construction plus line-by-line output parsing. */
export type ExecutorAdapter = {
  name: Executor;
  command: (spec: RunSpec) => { cmd: string; args: string[]; env: Record<string, string> };
  parseLine: (line: string) => AgentEvent[];
};
