import type { Fixture } from './scenarios.ts';

export const splitSelection = (selected: string | null) => {
  const [workflow, step, ...rest] = selected?.split('/') ?? [];
  const trail = rest.flatMap((part): { kind: 'check' | 'agent'; name: string }[] => {
    const [kind, name] = part.split(':');
    return (kind === 'check' || kind === 'agent') && name ? [{ kind, name }] : [];
  });
  return { workflow, step, trail };
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
