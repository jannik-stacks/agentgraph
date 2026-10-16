import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Check } from '../src/check.ts';
import type { Hub } from '../src/hub.ts';
import { load, type Problem, type Workflow } from '../src/workflow.ts';

const root = join(import.meta.dirname, '..', 'fixtures');

export const hubs = ['bothub', 'clarinet', 'acme-app', 'hub', 'loop'];

/** A fixture hub: the names its workflows may use, each check's mode and judge, and every workflow loaded. */
export const fixture = (hub: string) => {
  const dir = join(root, hub);
  const file = parse(readFileSync(join(dir, 'hub.yaml'), 'utf8')) as {
    bots: string[];
    skills: string[];
    checks: Record<string, Check['mode'] | Pick<Check, 'mode' | 'judge'>>;
  };
  const names = { bots: file.bots, skills: file.skills, checks: Object.keys(file.checks) };
  const checks = Object.fromEntries(
    Object.entries(file.checks).map(([name, check]) => [name, typeof check === 'string' ? { mode: check } : check])
  );
  const workflows: Record<string, Workflow> = {};
  const problems: Problem[] = [];
  for (const name of readdirSync(join(dir, 'workflows'))) {
    const path = join(dir, 'workflows', name);
    const loaded = load(path, readFileSync(path, 'utf8'), names);
    problems.push(...loaded.problems);
    if (loaded.workflow) workflows[loaded.workflow.name] = loaded.workflow;
  }
  return { names, checks, workflows, problems };
};

const kinds = ['comment', 'label', 'push', 'pull_request', 'merge', 'issue', 'ask', 'back'] as const;
const doc = <T>(name: string, fields: T) => ({ ...fields, name, path: `${name}.md`, body: `You are ${name}.` });

/** A fixture as a whole hub: every bot on opencode may propose anything, and `checks` fills in commands and judges. */
export const hubOf = (hub: string, checks: Record<string, Omit<Check, 'mode'>> = {}): Hub => {
  const f = fixture(hub);
  return {
    repo: `local/${hub}`,
    sha: 'fixture',
    bots: Object.fromEntries(
      f.names.bots.map(b => [b, doc(b, { harness: 'opencode' as const, tools: [], returns: [...kinds] })])
    ),
    skills: Object.fromEntries(f.names.skills.map(s => [s, doc(s, {})])),
    checks: Object.fromEntries(Object.entries(f.checks).map(([n, { mode }]) => [n, doc(n, { mode, ...checks[n] })])),
    workflows: f.workflows,
    limits: { minutes: 1, usdPerRun: 10, parallel: 2 },
  };
};
