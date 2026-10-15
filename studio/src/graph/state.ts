import { atom } from 'jotai';
import { selectAtom } from 'jotai/utils';
import type { RunStatus } from '../../../src/store.ts';
import { live } from '../runs/live.ts';
import { groupRuns, type Phase } from '../runs/model.ts';

/** What the graph shows of a step's latest run. */
export type StepState = { phase: Phase; status: RunStatus; tries: number; startedAt?: string | undefined };

/**
 * Each step's state from its latest run, keyed `workflow/job`. Rows only change when a run's status does, and the graph
 * redraws only when this key changes.
 */
const statesAtom = atom(get => {
  const rows = get(live.rows) ?? [];
  const states = new Map<string, StepState>();
  for (const group of groupRuns(rows))
    for (const job of group.jobs) {
      const id = `${job.workflow}/${job.job}`;
      if (states.has(id)) continue;
      const last = job.attempts.at(-1)!;
      states.set(id, { phase: job.phase, status: last.status, tries: job.attempts.length, startedAt: last.startedAt });
    }
  return { states, key: [...states].map(([id, s]) => `${id}:${s.phase}:${s.status}:${s.tries}`).join() };
});

export const stepStatesAtom = selectAtom(
  statesAtom,
  s => s,
  (a, b) => a.key === b.key
);
