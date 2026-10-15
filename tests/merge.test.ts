import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { compile, type Config } from '../src/config.ts';
import { localIssues } from '../src/issues-local.ts';
import { runPlan, runPlanned, type JobResult, type Pipeline } from '../src/pipeline.ts';
import { localPulls } from '../src/pulls.ts';
import { limiter, unsandboxed } from '../src/runner.ts';
import { openStore } from '../src/store.ts';
import type { BotEvent, RunSpec } from '../src/types.ts';
import { workspaces } from '../src/workspace.ts';
import { commit, fakeHarness, git, sourceRepo, temp } from './kit.ts';

const md = (path: string, frontmatter: string, body = '') => ({ path, source: `---\n${frontmatter}\n---\n\n${body}` });
const script = join(import.meta.dirname, '../examples/acme-app/scripts/merge-next.mjs');

const configFor = (hub = ''): Config => {
  const merging = (into: string, requires: string) =>
    `{ run: 'node "${script}"', into: '${into}', requires: [${requires}], returns: [merge, merge-request] }`;
  const result = compile([
    ...(hub ? [{ path: 'hub.yaml', source: hub }] : []),
    md('bots/bot.md', 'harness: opencode\ntools: [read]\nreturns: [reply, push, merge-request]', 'You code.'),
    md('skills/implement.md', 'description: Change code.', 'Implement it.'),
    md('checks/ok.md', 'type: script\nrun: "true"\nmode: block'),
    md('checks/bad.md', 'type: script\nrun: echo broken; exit 1\nmode: block'),
    md(
      'workflows/plan.md',
      `on: { issue_comment: {} }
steps:
  implement: { bot: bot, skill: implement, branch: 'bothub/{parent}-{issue}', into: 'bothub/{parent}', returns: [push, merge-request] }`
    ),
    md(
      'workflows/merge.md',
      `on: { pull_request: {} }
steps:
  merge: ${merging('{base}', 'ok')}
  strict: ${merging('{base}', 'bad')}
  main: ${merging('main', 'ok')}`
    ),
  ]);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.config;
};

const step: BotEvent = {
  id: 'c1',
  ts: '2026-10-12T00:00:00.000Z',
  source: 'local',
  trigger: 'issue_comment',
  action: 'created',
  repo: 'acme/app',
  number: 6,
  actor: { login: 'morgan', association: 'OWNER' },
  body: '/step',
};

const opened: BotEvent = {
  ...step,
  id: 'p1',
  trigger: 'pull_request',
  action: 'opened',
  number: 1,
  branch: 'bothub/5',
};

const bothub = (proposals: unknown[]) => ['```bothub', JSON.stringify(proposals), '```'].join('\n');

/** A harness that writes `a.ts` with what `content` says for the spec, and proposes what `propose` says. */
const harness = (behave: (spec: RunSpec) => { content: string; proposals: unknown[] }) =>
  fakeHarness(spec => {
    const { content, proposals } = behave(spec);
    return {
      events: [{ type: 'end', ok: true, turns: 1, result: bothub(proposals) }],
      work: `fs.writeFileSync('a.ts', ${JSON.stringify(content)})`,
    };
  });

const setup = async (config = configFor(), adapters?: Pipeline['adapters']) => {
  const origin = sourceRepo();
  const dataDir = temp('merge');
  const pulls = localPulls({ origin: origin.dir, file: join(dataDir, 'pulls.jsonl'), repo: 'acme/app' });
  const p: Pipeline = {
    config,
    event: opened,
    store: openStore(dataDir),
    workspaces: workspaces({ dataDir, cloneUrl: () => origin.dir }),
    limit: await Effect.runPromise(limiter(1)),
    env: {},
    pulls,
    launch: unsandboxed,
    ...(adapters && { adapters }),
  };
  /** Puts `content` in `a.ts` on `branch`, starting from `from`. */
  const branch = (name: string, content: string, from = 'main') => {
    git(origin.dir, 'checkout', '-q', '-B', name, from);
    const sha = commit(origin.dir, { 'a.ts': content });
    git(origin.dir, 'checkout', '-q', 'main');
    return sha;
  };
  return { origin, pulls, p, branch };
};

const results = (result: JobResult) => result.outcome?.results;

describe('merge', { timeout: 20_000 }, () => {
  it('lands the oldest open request once its required checks pass on the merged tree', async () => {
    const { origin, pulls, p, branch } = await setup();
    const head = branch('bothub/5-6', 'six\n');
    await pulls.open({ title: 'Step', body: '', branch: 'bothub/5-6', into: 'bothub/5' });
    const result = await Effect.runPromise(runPlanned({ workflow: 'merge', job: 'merge' }, p));
    expect(results(result)).toMatchObject([{ kind: 'merge', status: 'applied', url: `${origin.dir}#pull/1` }]);
    expect(result.run.closure).toBe('done');
    expect(git(origin.dir, 'rev-parse', 'bothub/5^2')).toBe(head);
    expect(git(origin.dir, 'show', 'bothub/5:a.ts')).toBe('six');

    const next = await Effect.runPromise(runPlanned({ workflow: 'merge', job: 'merge' }, p));
    expect(results(next)).toMatchObject([{ kind: 'merge-request', status: 'applied' }]);
    expect(await pulls.list()).toMatchObject([{ branch: 'bothub/5', into: 'main' }]);
  });

  it('brings the other requests into the plan up to date once one lands, unless they conflict', async () => {
    const { origin, pulls, p } = await setup();
    const step = (name: string, files: Record<string, string>) => {
      git(origin.dir, 'checkout', '-q', '-B', name, 'main');
      const sha = commit(origin.dir, files);
      git(origin.dir, 'checkout', '-q', 'main');
      return sha;
    };
    step('bothub/5-6', { 'a.ts': 'six\n' });
    const clean = step('bothub/5-7', { 'b.ts': 'seven\n' });
    const conflicting = step('bothub/5-8', { 'a.ts': 'eight\n' });
    for (const branch of ['bothub/5-6', 'bothub/5-7', 'bothub/5-8'])
      await pulls.open({ title: branch, body: '', branch, into: 'bothub/5' });

    const result = await Effect.runPromise(runPlanned({ workflow: 'merge', job: 'merge' }, p));
    expect(results(result)).toMatchObject([{ kind: 'merge', status: 'applied' }]);
    expect(git(origin.dir, 'rev-parse', 'bothub/5-7^1')).toBe(clean);
    expect(git(origin.dir, 'rev-parse', 'bothub/5-7^2')).toBe(git(origin.dir, 'rev-parse', 'bothub/5'));
    expect(git(origin.dir, 'show', 'bothub/5-7:a.ts')).toBe('six');
    expect(git(origin.dir, 'rev-parse', 'bothub/5-8')).toBe(conflicting);
  });

  it('skips a merge job with nothing to merge and its plan request already open', async () => {
    const { pulls, p, branch } = await setup();
    branch('bothub/5', 'five\n');
    const merge = () => Effect.runPromise(runPlanned({ workflow: 'merge', job: 'merge' }, p));
    expect((await merge()).run).toMatchObject({ status: 'succeeded', closure: 'handed-off' });
    expect((await merge()).run).toMatchObject({
      status: 'skipped',
      closure: 'no-op',
      reason: 'nothing to merge or propose',
    });
    expect(await pulls.list({ into: 'main' })).toHaveLength(1);
  });

  it('refuses a merge whose required checks fail, or one into the default branch', async () => {
    const { pulls, p, branch } = await setup();
    branch('bothub/5-6', 'six\n');
    await pulls.open({ title: 'Step', body: '', branch: 'bothub/5-6', into: 'bothub/5' });
    const strict = await Effect.runPromise(runPlanned({ workflow: 'merge', job: 'strict' }, p));
    expect(results(strict)).toMatchObject([
      { kind: 'merge', status: 'failed', reason: 'required checks failed on the merged tree: bad (broken)' },
    ]);

    await pulls.open({ title: 'Plan', body: '', branch: 'bothub/5-6', into: 'main' });
    const main = await Effect.runPromise(runPlanned({ workflow: 'merge', job: 'main' }, p));
    expect(results(main)).toMatchObject([
      { kind: 'merge', status: 'failed', reason: 'only a human merges into the default branch "main"' },
    ]);
    expect(await pulls.list({ state: 'merged' })).toEqual([]);
  });

  it('blocks a step whose plan the event does not name', async () => {
    const { p } = await setup();
    const [blocked] = await Effect.runPromise(
      runPlan([{ workflow: 'plan', job: 'implement', bot: 'bot' }], { ...p, event: step })
    );
    expect(blocked?.run).toMatchObject({
      status: 'skipped',
      closure: 'blocked',
      reason: '"bothub/{parent}-6" names a value this event does not have',
    });
  });

  it('lets bots merge into the default branch when hub.yaml says so', async () => {
    const { origin, pulls, p, branch } = await setup(configFor('merge: { default-branch: bots }\n'));
    branch('bothub/5', 'plan\n');
    await pulls.open({ title: 'Plan', body: '', branch: 'bothub/5', into: 'main' });
    const main = await Effect.runPromise(runPlanned({ workflow: 'merge', job: 'main' }, p));
    expect(results(main)).toMatchObject([{ kind: 'merge', status: 'applied' }]);
    expect(git(origin.dir, 'show', 'main:a.ts')).toBe('plan');
  });

  it('sends a conflicting request back to the job that opened it, then merges the resolution', async () => {
    const { seen, adapters } = harness(spec =>
      spec.prompt.includes('## Merge conflicts')
        ? { content: 'both\n', proposals: [{ kind: 'push', branch: 'bothub/5-6', files: ['a.ts'] }] }
        : {
            content: 'six\n',
            proposals: [
              { kind: 'push', branch: 'bothub/5-6', files: ['a.ts'] },
              { kind: 'merge-request', title: 'Step', body: 'Closes #6', branch: 'bothub/5-6' },
            ],
          }
    );
    const { origin, pulls, p, branch } = await setup(configFor(), adapters);
    const issues = temp('issues');
    writeFileSync(join(issues, '6-step.md'), '---\ntitle: Step\nparent: 5\n---\n\nDo it.\n');

    const [implemented] = await Effect.runPromise(
      runPlan([{ workflow: 'plan', job: 'implement', bot: 'bot' }], {
        ...p,
        event: step,
        issues: localIssues(issues, { repo: 'acme/app' }),
      })
    );
    expect(implemented && results(implemented)).toMatchObject([
      { kind: 'push', status: 'applied' },
      { kind: 'merge-request', status: 'applied' },
    ]);
    expect(git(origin.dir, 'rev-parse', 'bothub/5-6^')).toBe(origin.main);
    branch('bothub/5', 'five\n', 'bothub/5');
    expect(await pulls.get(1)).toMatchObject({ into: 'bothub/5', mergeable: false, origin: { job: 'plan/implement' } });

    const result = await Effect.runPromise(runPlanned({ workflow: 'merge', job: 'merge' }, p));
    expect(results(result)).toMatchObject([{ kind: 'merge', status: 'applied' }]);
    expect(seen[1]?.prompt).toContain('## Merge conflicts');
    expect(seen[1]?.prompt).toContain('a.ts');
    expect(git(origin.dir, 'show', 'bothub/5:a.ts')).toBe('both');
  });
  it('asks to merge the plan only once every step is closed or merged and none is running', async () => {
    const { adapters } = harness(() => ({
      content: 'six\n',
      proposals: [
        { kind: 'push', branch: 'bothub/5-6', files: ['a.ts'] },
        { kind: 'merge-request', title: 'Step', body: 'Closes #6', branch: 'bothub/5-6' },
      ],
    }));
    const { origin, pulls, p: base, branch } = await setup(configFor(), adapters);
    const dir = temp('issues');
    writeFileSync(join(dir, '5-plan.md'), '---\ntitle: Plan\n---\n\nPlan it.\n');
    writeFileSync(join(dir, '6-step.md'), '---\ntitle: Step\nparent: 5\n---\n\nDo it.\n');
    writeFileSync(join(dir, '7-other.md'), '---\ntitle: Other\nparent: 5\n---\n\nDo that.\n');
    const issues = localIssues(dir, { repo: 'acme/app' });
    const p = { ...base, issues };
    const plan5 = branch('bothub/5', 'five\n');
    await Effect.runPromise(runPlan([{ workflow: 'plan', job: 'implement', bot: 'bot' }], { ...p, event: step }));
    expect(git(origin.dir, 'rev-parse', 'bothub/5-6^')).toBe(plan5);
    const merge = () => Effect.runPromise(runPlanned({ workflow: 'merge', job: 'merge' }, p));
    expect(results(await merge())).toMatchObject([{ kind: 'merge', status: 'applied' }]);

    const plan = () => pulls.list({ into: 'main' });
    await merge();
    expect(await plan()).toEqual([]);

    await issues.close(7);
    const running = await p.store.create({
      workflow: 'plan',
      job: 'implement',
      event: { ...step, id: 'c2', number: 7 },
    });
    await p.store.update(running.id, { status: 'running' });
    await merge();
    expect(await plan()).toEqual([]);

    await p.store.update(running.id, { status: 'succeeded' });
    expect(results(await merge())).toMatchObject([{ kind: 'merge-request', status: 'applied' }]);
    expect(await plan()).toMatchObject([{ branch: 'bothub/5', into: 'main' }]);
  });

  it('closes a landed step, tells its plan, and stores the merge run as running until it landed', async () => {
    const { adapters } = harness(() => ({
      content: 'six\n',
      proposals: [
        { kind: 'push', branch: 'bothub/5-6', files: ['a.ts'] },
        { kind: 'merge-request', title: 'Step', body: 'Closes #6', branch: 'bothub/5-6' },
      ],
    }));
    const { pulls, p: base, branch } = await setup(configFor(), adapters);
    const dir = temp('issues');
    writeFileSync(join(dir, '5-plan.md'), '---\ntitle: Plan\nlabels: [plan]\n---\n\nPlan it.\n');
    writeFileSync(join(dir, '6-step.md'), '---\ntitle: Step\nparent: 5\n---\n\nDo it.\n');
    writeFileSync(join(dir, '7-other.md'), '---\ntitle: Other\nparent: 5\n---\n\nDo that.\n');
    const issues = localIssues(dir, { repo: 'acme/app' });
    const statuses: string[] = [];
    const watched = {
      ...pulls,
      merge: async (...args: Parameters<typeof pulls.merge>) => {
        statuses.push(...(await base.store.runs({ workflow: 'merge' })).map(run => run.status));
        return pulls.merge(...args);
      },
    };
    const p = { ...base, issues, pulls: watched };
    branch('bothub/5', 'five\n');
    await Effect.runPromise(runPlan([{ workflow: 'plan', job: 'implement', bot: 'bot' }], { ...p, event: step }));

    const landed = await Effect.runPromise(runPlanned({ workflow: 'merge', job: 'merge' }, p));
    expect(results(landed)).toMatchObject([{ kind: 'merge', status: 'applied' }]);
    expect(statuses).toEqual(['running']);
    expect(landed.run).toMatchObject({ status: 'succeeded', closure: 'done' });
    expect(await p.store.read(landed.run.id)).toMatchObject({ status: 'succeeded', closure: 'done' });
    expect((await issues.get(6))?.state).toBe('closed');
    expect((await issues.get(7))?.state).toBe('open');
    expect((await issues.get(5))?.comments.map(c => c.body)).toEqual(['#6 landed on bothub/5, 1 of 2 steps.']);
  });
});
