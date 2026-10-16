import type { AgentEvent, HarnessAdapter, RunSpec } from '../src/types.ts';

type Behaviour = { events: AgentEvent[]; work?: string; exit?: number };

/**
 * A harness that runs `node -e` in the worktree: `work` first, then it prints `events` and exits with `exit`. Records
 * each spec in `seen`; `adapters` holds it under both harness names.
 */
export const fakeHarness = (behave: (spec: RunSpec, call: number) => Behaviour) => {
  const seen: RunSpec[] = [];
  const adapter: HarnessAdapter = {
    name: 'opencode',
    command: spec => {
      seen.push(spec);
      const { events, work = '', exit = 0 } = behave(spec, seen.length);
      const out = events.map(event => JSON.stringify(event)).join('\n');
      const script = `const fs = require('fs'); ${work}; console.log(${JSON.stringify(out)}); process.exit(${exit})`;
      return { cmd: process.execPath, args: ['-e', script], env: {} };
    },
    parseLine: line => (line.trim() ? [JSON.parse(line) as AgentEvent] : []),
  };
  return {
    seen,
    adapters: {
      opencode: adapter,
      pi: { ...adapter, name: 'pi' as const },
      claude: { ...adapter, name: 'claude' as const },
    },
  };
};
