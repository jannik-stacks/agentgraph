import type { AgentEvent } from '../types.ts';

/** A `parseLine` that reads each non-blank line as JSON for `event`, and turns one that is not JSON into an error event. */
export const jsonLines =
  <L>(name: string, event: (line: L) => AgentEvent[]) =>
  (raw: string): AgentEvent[] => {
    if (!raw.trim()) return [];
    try {
      return event(JSON.parse(raw) as L);
    } catch (e) {
      return [{ type: 'error', message: `unreadable ${name} output: ${(e as Error).message}` }];
    }
  };
