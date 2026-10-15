import { describe, expect, it } from 'vitest';
import type { RunStatus } from '../src/store.ts';
import { studioModule } from './studio.ts';

type Run = { status: RunStatus; closure?: string; brief?: { kinds: string[] } };
const { phaseOf, phaseWord } = await studioModule<{
  phaseOf: (run: Run) => string;
  phaseWord: (phase: string, status?: RunStatus) => string;
}>('runs/model.ts');

describe('run phases', () => {
  it('reads a blocked, deferred or asking run as waiting for a human', () => {
    for (const run of [
      { status: 'succeeded', closure: 'blocked' },
      { status: 'succeeded', closure: 'deferred' },
      { status: 'succeeded', brief: { kinds: ['ask'] } },
    ] as Run[]) {
      expect(phaseOf(run)).toBe('waiting');
      expect(phaseWord(phaseOf(run), run.status)).toBe('waiting for a human');
    }
  });

  it('tells running, queued, failed and done apart by word', () => {
    expect(phaseOf({ status: 'running' })).toBe('running');
    expect(phaseOf({ status: 'queued' })).toBe('queued');
    expect(phaseWord(phaseOf({ status: 'timed-out' }), 'timed-out')).toBe('timed out');
    expect(phaseOf({ status: 'succeeded' })).toBe('done');
  });
});
