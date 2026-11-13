import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type * as ChildProcessModule from 'node:child_process';
import { afterAll } from 'vitest';
import { startTime } from './global.ts';

const childProcess = createRequire(import.meta.url)('node:child_process') as typeof ChildProcessModule;
const log = process.env.AGENTGRAPH_TEST_PROCESSES;
const marker = Symbol.for('agentgraph.recordedSpawn');
type Recorded = { [marker]?: Set<ChildProcessModule.ChildProcess> };

if (log && !(marker in childProcess.spawn)) {
  const running = new Set<ChildProcessModule.ChildProcess>();
  for (const name of ['spawn', 'fork'] as const) {
    const original = childProcess[name] as (...args: unknown[]) => ChildProcessModule.ChildProcess;
    const recorded = (...args: unknown[]) => {
      const at = args.findIndex((a, i) => i > 0 && a && typeof a === 'object' && !Array.isArray(a));
      const options = args[at] as { env?: NodeJS.ProcessEnv } | undefined;
      if (options?.env) args[at] = { ...options, env: { ...options.env, AGENTGRAPH_TEST_PROCESSES: log } };
      const child = original(...args);
      if (child.pid) {
        appendFileSync(log, `${child.pid} -\n`);
        running.add(child);
        child.once('exit', () => running.delete(child));
      }
      return child;
    };
    Object.defineProperty(recorded, marker, { value: running });
    (childProcess as unknown as Record<string, unknown>)[name] = recorded;
  }
  syncBuiltinESMExports();
}

afterAll(() => {
  for (const child of (childProcess.spawn as Recorded)[marker] ?? []) {
    const started = startTime(child.pid!);
    if (started) appendFileSync(log!, `${child.pid} ${started}\n`);
  }
});
