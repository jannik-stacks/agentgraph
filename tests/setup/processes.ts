import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type * as ChildProcessModule from 'node:child_process';
import { afterAll } from 'vitest';
import { startTime } from './global.ts';

/**
 * Appends the pid of every process a test worker spawns to the file in AGENTGRAPH_TEST_PROCESSES, and after each test
 * file the start time of those still running.
 */
const childProcess = createRequire(import.meta.url)('node:child_process') as typeof ChildProcessModule;
const log = process.env.AGENTGRAPH_TEST_PROCESSES;
const marker = Symbol.for('agentgraph.recordedSpawn');
type Recorded = { [marker]?: Set<ChildProcessModule.ChildProcess> };

if (log && !(marker in childProcess.spawn)) {
  const running = new Set<ChildProcessModule.ChildProcess>();
  for (const name of ['spawn', 'fork'] as const) {
    const original = childProcess[name] as (...args: unknown[]) => ChildProcessModule.ChildProcess;
    const recorded = (...args: unknown[]) => {
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
