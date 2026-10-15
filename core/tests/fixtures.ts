import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Check } from '../src/check.ts';
import { load, type Problem, type Workflow } from '../src/workflow.ts';

const root = join(import.meta.dirname, '..', 'fixtures');

export const hubs = ['bothub', 'clarinet', 'acme-app', 'hub', 'loop'];

/** A fixture hub: the names its workflows may use, the check modes and every workflow loaded. */
export const fixture = (hub: string) => {
  const dir = join(root, hub);
  const file = parse(readFileSync(join(dir, 'hub.yaml'), 'utf8')) as {
    bots: string[];
    skills: string[];
    checks: Record<string, Check['mode']>;
  };
  const names = { bots: file.bots, skills: file.skills, checks: Object.keys(file.checks) };
  const checks = Object.fromEntries(Object.entries(file.checks).map(([name, mode]) => [name, { mode }]));
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
