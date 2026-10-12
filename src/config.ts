import { z } from 'zod';
import { parseMarkdown } from './markdown.ts';
import { PersonaFrontmatter, WorkflowFrontmatter } from './schema.ts';

export type SourceFile = { path: string; source: string };

export type Persona = PersonaFrontmatter & { name: string; prompt: string; path: string };
export type Workflow = WorkflowFrontmatter & { path: string; prompts: Record<string, string> };
export type Config = { personas: Record<string, Persona>; workflows: Record<string, Workflow> };

export type ConfigError = { path: string; message: string };
export type Compiled = { ok: true; config: Config } | { ok: false; errors: ConfigError[] };

const stem = (path: string) => path.split('/').pop()?.replace(/\.md$/, '') ?? path;

/**
 * Validates persona and workflow Markdown files into one config. Fails closed: any error rejects the whole set.
 * Files are routed by directory: `personas/` and `workflows/`.
 */
export const compile = (files: SourceFile[]): Compiled => {
  const errors: ConfigError[] = [];
  const personas: Record<string, Persona> = {};
  const workflows: Record<string, Workflow> = {};

  for (const file of files) {
    const kind = file.path.includes('personas/') ? 'persona' : file.path.includes('workflows/') ? 'workflow' : undefined;
    if (!kind) continue;
    const fail = (message: string) => errors.push({ path: file.path, message });
    let doc;
    try {
      doc = parseMarkdown(file.source);
    } catch (e) {
      fail((e as Error).message);
      continue;
    }
    if (kind === 'persona') {
      const parsed = PersonaFrontmatter.safeParse(doc.data);
      if (!parsed.success) {
        fail(z.prettifyError(parsed.error));
        continue;
      }
      const name = parsed.data.name ?? stem(file.path);
      if (name in personas) fail(`duplicate persona "${name}"`);
      personas[name] = { ...parsed.data, name, prompt: doc.body, path: file.path };
    } else {
      const parsed = WorkflowFrontmatter.safeParse(doc.data);
      if (!parsed.success) {
        fail(z.prettifyError(parsed.error));
        continue;
      }
      if (parsed.data.name in workflows) fail(`duplicate workflow "${parsed.data.name}"`);
      workflows[parsed.data.name] = { ...parsed.data, path: file.path, prompts: doc.sections };
    }
  }

  for (const workflow of Object.values(workflows)) errors.push(...checkWorkflow(workflow, personas));
  return errors.length ? { ok: false, errors } : { ok: true, config: { personas, workflows } };
};

const checkWorkflow = (workflow: Workflow, personas: Record<string, Persona>): ConfigError[] => {
  const errors: string[] = [];
  const { jobs } = workflow;

  for (const [id, job] of Object.entries(jobs)) {
    for (const need of job.needs) if (!(need in jobs)) errors.push(`job "${id}" needs unknown job "${need}"`);
    for (const trigger of Object.keys(job.on ?? {}))
      if (!(trigger in workflow.on)) errors.push(`job "${id}" triggers on "${trigger}", which the workflow does not listen to`);
    if (!job.persona) continue;
    const persona = personas[job.persona];
    if (!persona) {
      errors.push(`job "${id}" uses unknown persona "${job.persona}"`);
      continue;
    }
    if (!(id in workflow.prompts)) errors.push(`job "${id}" runs persona "${job.persona}" but has no "## ${id}" section`);
    for (const kind of Object.keys(job['safe-outputs']))
      if (!persona['can-write'].includes(kind as never))
        errors.push(`job "${id}" allows "${kind}", which persona "${persona.name}" cannot write`);
  }

  for (const id of Object.keys(workflow.prompts)) if (!(id in jobs)) errors.push(`section "## ${id}" has no job`);

  const cycle = findCycle(jobs);
  if (cycle) errors.push(`needs cycle: ${cycle.join(' -> ')}`);

  return errors.map((message) => ({ path: workflow.path, message }));
};

const findCycle = (jobs: Record<string, { needs: string[] }>): string[] | undefined => {
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, trail: string[]): string[] | undefined => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') return [...trail.slice(trail.indexOf(id)), id];
    state.set(id, 'visiting');
    for (const need of jobs[id]?.needs ?? []) {
      const found = visit(need, [...trail, id]);
      if (found) return found;
    }
    state.set(id, 'done');
  };
  for (const id of Object.keys(jobs)) {
    const found = visit(id, []);
    if (found) return found;
  }
};

/** Job ids in dependency order, so every job comes after the jobs it needs. */
export const jobOrder = (workflow: Pick<Workflow, 'jobs'>): string[] => {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const need of workflow.jobs[id]?.needs ?? []) visit(need);
    order.push(id);
  };
  Object.keys(workflow.jobs).forEach(visit);
  return order;
};
