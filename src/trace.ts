import type { CheckEntry, Exit, Outcome, Run, SessionStop, Trace } from './types.ts';

export const makeOutcomeLine = (step: string, outcome: Outcome, next: Run, failure?: SessionStop['reason']): Trace => ({
  at: new Date().toISOString(),
  step,
  outcome,
  ...(failure && { failure }),
  run: {
    step: next.step,
    status: next.status,
    tries: next.tries,
    rounds: next.rounds,
    ...(next.reason !== undefined && { reason: next.reason }),
  },
});

export const findLatestChecks = (entries: CheckEntry[], versions: Record<string, string> = {}, from = '') => {
  const latest = new Map<string, CheckEntry>();
  const current = (e: CheckEntry) => versions[e.check.check] === undefined || versions[e.check.check] === e.version;
  for (const e of entries.toSorted((a, b) => a.at.localeCompare(b.at))) {
    if (e.item !== undefined || e.at < from) continue;
    const was = latest.get(e.check.check);
    if (!was || current(e) || !current(was)) latest.set(e.check.check, e);
  }
  return [...latest.values()].map(e => (current(e) ? e : { ...e, older: true as const }));
};

export const pickUsed = (x?: Pick<Exit, 'used'>) => (x?.used ? { used: x.used } : {});
