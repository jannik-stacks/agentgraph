import type { Types } from 'effect';
import { sumSpend } from './stats.ts';
import type { CheckEntry, Exit, Outcome, Run, RunRecord, SessionStop, Trace, Verdict } from './types.ts';

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

export const getRunSpend = (lines: (Trace | CheckEntry)[]) =>
  sumSpend(lines.map(line => ('session' in line ? line.session : 'check' in line ? line : {})));

export const formatSpend = ({ usd, unpriced }: ReturnType<typeof sumSpend>) =>
  `$${usd.toFixed(2)}${unpriced === undefined ? '' : '+'}`;

export const pickUsed = (x?: Pick<Exit, 'used'>) => (x?.used ? { used: x.used } : {});

export const findCheckVerdicts = (
  runs: { run: Pick<RunRecord, 'id' | 'issue'>; checks: CheckEntry[] }[],
  step: string,
  check: string
) => {
  const byTime = new Map<string, Types.Mutable<typeof Verdict.Type>>();
  for (const { run, checks } of runs) {
    for (const line of checks) {
      if (line.step !== step || line.check.check !== check) continue;
      const key = `${run.id}@${line.at}`;
      const v = byTime.get(key) ?? {
        run: run.id,
        issue: run.issue,
        at: line.at,
        pass: true,
        empty: false,
        items: 0,
        failed: 0,
      };
      v.pass &&= line.check.pass;
      v.empty ||= line.check.empty === true;
      if (line.item === undefined) v.findings = line.check.findings;
      else {
        v.items++;
        if (!line.check.pass) v.failed++;
      }
      byTime.set(key, v);
    }
  }
  return [...byTime.values()].sort((a, b) => b.at.localeCompare(a.at));
};
