import type { Run } from './workflow.ts';

export const findRunsWaitingOnPeople = (runs: Run[]) =>
  runs
    .filter(run => run.status === 'waiting' && !runs.some(c => c.by === run.id && run.reason === `waiting on ${c.id}`))
    .toSorted((a, b) => b.started.localeCompare(a.started));

export const formatNextSteps = (run: Run, where: { again: string; forge?: string; repo: string }) => {
  const forge = where.forge && `node bin/forge.ts ${where.forge}`;
  const issue = `https://github.com/${where.repo}/issues/${run.issue}`;
  return [
    `${run.id} ${run.workflow} #${run.issue} is ${run.status}${run.reason ? `: ${run.reason}` : ''}`,
    run.reason
      ? forge
        ? `  Answer with ${forge} comment ${run.issue} "/agent <answer>", then:`
        : `  Answer at ${issue}, then:`
      : forge
        ? `  Review the pull request that ${forge} show lists, then:`
        : `  Review the PR linked from ${issue}, then:`,
    `  npx agentgraph ${where.again} --issue ${run.issue}`,
  ];
};
