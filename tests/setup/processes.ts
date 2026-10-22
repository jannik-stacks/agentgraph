import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { startTime } from './global.ts';

/** Appends the pid and start time of every process a test worker spawns to the file in BOTHUB_TEST_PROCESSES. */
const childProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
const log = process.env.BOTHUB_TEST_PROCESSES;
const marker = Symbol.for('bothub.recordedSpawn');

if (log && !(marker in childProcess.spawn)) {
  for (const name of ['spawn', 'fork'] as const) {
    const original = childProcess[name] as (...args: unknown[]) => import('node:child_process').ChildProcess;
    const recorded = (...args: unknown[]) => {
      const child = original(...args);
      const started = child.pid && startTime(child.pid);
      if (started) appendFileSync(log, `${child.pid} ${started}\n`);
      return child;
    };
    Object.defineProperty(recorded, marker, { value: true });
    (childProcess as unknown as Record<string, unknown>)[name] = recorded;
  }
  syncBuiltinESMExports();
}
