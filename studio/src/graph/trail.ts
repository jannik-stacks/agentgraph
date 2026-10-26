import type { ServedRun } from '../runs/trace.ts';
import type { Fixture } from './scenarios.ts';

export const splitSelection = (selected: string | null) => {
  const [workflow, step, ...rest] = selected?.split('/') ?? [];
  const trail = rest.flatMap((part): { kind: 'check' | 'agent'; name: string }[] => {
    const [kind, name] = part.split(':');
    return (kind === 'check' || kind === 'agent') && name ? [{ kind, name }] : [];
  });
  return { workflow, step, trail };
};

export const findCheckVerdicts = (
  runs: Pick<ServedRun, 'fixture' | 'run' | 'trace'>[],
  fixture: string,
  step: string,
  check: string
) => {
  const byTime = new Map<
    string,
    {
      run: string;
      issue: number;
      at: string;
      pass: boolean;
      findings?: string | undefined;
      items: number;
      failed: number;
    }
  >();
  for (const { fixture: from, run, trace } of runs) {
    if (from !== fixture) continue;
    for (const line of trace) {
      if (!('check' in line) || line.step !== step || line.check.check !== check) continue;
      const key = `${run.id}@${line.at}`;
      const v = byTime.get(key) ?? { run: run.id, issue: run.issue, at: line.at, pass: true, items: 0, failed: 0 };
      v.pass &&= line.check.pass;
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

export const findAgentUses = (fixtures: Fixture[], agent: string) => ({
  steps: fixtures.flatMap(f =>
    f.workflow.steps
      .filter(s => 'agent' in s.does && s.does.agent === agent)
      .map(s => ({ name: s.name, workflow: f.workflow.name, path: `${f.workflow.name}/${s.name}` }))
  ),
  checks: [
    ...new Set(fixtures.flatMap(f => Object.keys(f.checks).filter(name => f.checks[name]!.agent === agent))),
  ].map(name => {
    const f = fixtures.find(f => f.workflow.steps.some(s => s.checks.includes(name)));
    const step = f?.workflow.steps.find(s => s.checks.includes(name));
    return { name, path: step && `${f!.workflow.name}/${step.name}/check:${name}` };
  }),
});
