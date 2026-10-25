import type { Run } from './workflow.ts';

export const findRunsWaitingOnPeople = (runs: Run[]) =>
  runs
    .filter(run => run.status === 'waiting' && !runs.some(c => c.by === run.id && run.reason === `waiting on ${c.id}`))
    .toSorted((a, b) => b.started.localeCompare(a.started));

const quote = (path: string) => (/^[\w./~:@+-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`);

export const formatNextSteps = (
  run: Run,
  repo: string,
  at: { instance: string } | { hub: string; data: string; forge?: string }
) => {
  const folder = 'instance' in at ? at.instance : at.forge;
  const again =
    'instance' in at
      ? `--instance ${quote(at.instance)}`
      : `--hub ${quote(at.hub)} --data ${quote(at.data)}${at.forge ? ` --forge ${quote(at.forge)}` : ''}`;
  const forge = folder && `node bin/forge.ts ${quote(folder)}`;
  const issue = `https://github.com/${repo}/issues/${run.issue}`;
  return [
    `${run.id} ${run.workflow} #${run.issue} is ${run.status}${run.reason ? `: ${run.reason}` : ''}`,
    run.reason
      ? forge
        ? `  Answer with ${forge} comment ${run.issue} "/agent <answer>", then:`
        : `  Answer at ${issue}, then:`
      : forge
        ? `  Find the pull request <pr> with ${forge} show, then ${forge} merge <pr>, or review <pr> changes "<why>", then:`
        : `  Review the PR linked from ${issue}, then:`,
    `  npx agentgraph ${again} --issue ${run.issue}`,
  ];
};
