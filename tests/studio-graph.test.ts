import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, type Config } from '../src/config.ts';
import { readHub } from '../src/load.ts';
import { studioModule } from './studio.ts';

type Step = { id: string; name: string; bot?: string; run?: string; next: string[]; back: { to: string }[] };
type Flow = { workflow: string; triggers: string[]; entry: string[]; steps: Step[] };
type Placed = { id: string; kind: string; x: number; y: number };
type Line = { from: string; to: string; back?: string };

const { flowsOf } = await studioModule<{ flowsOf: (config: Config) => Flow[] }>('graph/model.ts');
const { layout } = await studioModule<{ layout: (flows: Flow[]) => { placed: Placed[]; lines: Line[] } }>(
  'graph/layout.ts'
);

const examples = join(import.meta.dirname, '..', 'examples');
const hubs = await Promise.all(
  readdirSync(examples)
    .filter(name => ['bots', 'workflows'].some(entry => existsSync(join(examples, name, entry))))
    .map(async name => {
      const compiled = compile(await readHub(join(examples, name)));
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
      return [name, compiled.config] as const;
    })
);

describe('studio graph', () => {
  it.each(hubs)('%s: every job is one step, started by the triggers or by the jobs it needs', (_, config) => {
    const flows = flowsOf(config);
    expect(flows.map(f => f.workflow).toSorted()).toEqual(
      Object.values(config.workflows)
        .map(w => w.name)
        .toSorted()
    );
    for (const flow of flows) {
      const workflow = Object.values(config.workflows).find(w => w.name === flow.workflow)!;
      const jobs = Object.entries(workflow.jobs);
      expect(flow.steps.map(s => s.name)).toEqual(jobs.map(([id]) => id));
      expect(flow.triggers).toEqual(Object.keys(workflow.on));
      for (const [id, job] of jobs) {
        const step = flow.steps.find(s => s.name === id)!;
        expect(step.id).toBe(`${flow.workflow}/${id}`);
        expect(job.type === 'bot' ? step.bot : step.run).toBeTruthy();
        for (const need of job.needs) expect(flow.steps.find(s => s.name === need)!.next).toContain(step.id);
        expect(flow.entry.includes(step.id)).toBe(job.needs.length === 0);
      }
    }
  });

  it.each(hubs)(
    '%s: the layout places every node once, apart from the others, and links only placed nodes',
    (_, config) => {
      const flows = flowsOf(config);
      const { placed, lines } = layout(flows);
      const ids = new Set(placed.map(p => p.id));
      expect(ids.size).toBe(placed.length);
      expect(new Set(placed.map(p => `${p.x},${p.y}`)).size).toBe(placed.length);
      for (const step of flows.flatMap(f => f.steps)) expect(ids.has(step.id)).toBe(true);
      for (const line of lines) expect(ids.has(line.from) && ids.has(line.to)).toBe(true);
    }
  );
});
