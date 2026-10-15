import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backOf, compile, nextOf, type Config } from '../src/config.ts';
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
  it.each(hubs)(
    '%s: every workflow is drawn with its steps in order, the first started by the triggers',
    (_, config) => {
      const workflows = Object.values(config.workflows);
      expect(flowsOf(config).map(f => [f.workflow, f.triggers, f.entry, f.steps.map(s => s.name)])).toEqual(
        workflows.map(w => [w.name, Object.keys(w.on), [`${w.name}/${Object.keys(w.steps)[0]}`], Object.keys(w.steps)])
      );
    }
  );

  const steps = hubs.flatMap(([hub, config]) =>
    Object.values(config.workflows).flatMap(workflow =>
      Object.keys(workflow.steps).map(id => [`${hub} ${workflow.name}/${id}`, config, workflow, id] as const)
    )
  );

  it.each(steps)(
    '%s: casts its bot or runs its script, then goes to the next step or back',
    (_, config, workflow, id) => {
      const spec = workflow.steps[id]!;
      const step = flowsOf(config)
        .find(f => f.workflow === workflow.name)!
        .steps.find(s => s.name === id)!;
      const ref = (to: string | undefined) => (to === undefined ? [] : [`${workflow.name}/${to}`]);
      expect({ id: step.id, bot: step.bot, run: step.run, next: step.next, back: step.back.map(b => b.to) }).toEqual({
        id: `${workflow.name}/${id}`,
        bot: spec.bot,
        run: spec.run,
        next: ref(nextOf(workflow, id)),
        back: [...(spec.checks ? ref(id) : []), ...(spec.wait ? ref(backOf(workflow, id)) : [])],
      });
    }
  );

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
