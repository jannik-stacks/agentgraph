import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, type Config } from '../src/config.ts';
import { readHub } from '../src/load.ts';
import { buildSpec } from '../src/pipeline.ts';
import { relevantNotes, renderNotes } from '../src/preload.ts';
import type { BotEvent } from '../src/types.ts';
import { studioModule } from './studio.ts';

type Node = {
  id: string;
  kind: string;
  context?: { step: string; preload: string[]; notes: { note: Config['notes'][number]; why: string }[] }[];
};
type Edge = { from: string; to: string; kind: string };
type Model = { nodes: Node[]; edges: Edge[] };
type GraphModule = {
  graphModel: (config: Config) => Model;
  layerModel: (model: Model, layer: 'flow' | 'cast') => Model;
};

const { graphModel, layerModel } = await studioModule<GraphModule>('graph-model.ts');

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

const event: BotEvent = {
  id: 'e',
  ts: '2026-10-12T00:00:00.000Z',
  source: 'local',
  trigger: 'issue_comment',
  repo: 'acme/app',
  actor: { login: 'octocat', association: 'OWNER' },
};

describe('studio step context', () => {
  it.each(hubs)('%s: each job shows exactly the notes its run loads', (_, config) => {
    const model = graphModel(config);
    let jobs = 0;
    for (const workflow of Object.values(config.workflows))
      for (const [id, job] of Object.entries(workflow.jobs)) {
        if (!job.bot || !job.skill) continue;
        jobs++;
        const node = model.nodes.find(n => n.id === `job:${workflow.name}/${id}`);
        const [context] = node?.context ?? [];
        expect(context?.step).toBe(node?.id);
        const shown = context!.notes.map(n => n.note);
        const { spec } = buildSpec({ config, workflow, job: id, event, cwd: '/w' });
        const rendered = renderNotes(shown);
        if (rendered) expect(spec.system).toContain(rendered);
        else expect(spec.system).not.toContain('## Notes');
        const bot = config.bots[job.bot]!;
        const skill = config.skills[job.skill]!;
        const kinds = [...(bot.notes ?? []), ...(skill.notes ?? [])];
        const loads = context!.preload.includes('notes')
          ? relevantNotes(config.notes, { kinds, paths: job.paths })
          : [];
        expect(shown).toEqual(loads);
      }
    expect(jobs).toBeGreaterThan(0);
  });

  it.each(hubs)('%s: each bot lists the context of every step that casts it', (_, config) => {
    const model = graphModel(config);
    for (const bot of model.nodes.filter(n => n.kind === 'bot')) {
      const casters = model.edges
        .filter(e => e.to === bot.id && (e.kind === 'runs-as' || e.kind === 'fans-out'))
        .map(e => e.from);
      expect((bot.context ?? []).map(c => c.step).toSorted()).toEqual([...new Set(casters)].toSorted());
    }
  });
});

describe('studio graph layers', () => {
  const flowKinds = ['triggers', 'needs', 'gates', 'loops-back'];
  const castKinds = ['runs-as', 'fans-out', 'uses-skill'];

  it.each(hubs)('%s: the flow layer has steps and gating checks, linked only by the flow', (_, config) => {
    const model = graphModel(config);
    const flow = layerModel(model, 'flow');
    const steps = (m: Model) => m.nodes.filter(n => ['trigger', 'job', 'script'].includes(n.kind)).map(n => n.id);
    expect(steps(flow)).toEqual(steps(model));
    expect(flow.nodes.every(n => ['trigger', 'job', 'script', 'check'].includes(n.kind))).toBe(true);
    expect(flow.edges.every(e => flowKinds.includes(e.kind))).toBe(true);
    const gating = new Set(model.edges.filter(e => e.kind === 'gates').map(e => e.from));
    expect(flow.nodes.filter(n => n.kind === 'check').every(n => gating.has(n.id))).toBe(true);
  });

  it.each(hubs)('%s: the cast layer adds bots and skills with one edge per cast, and never context', (_, config) => {
    const cast = layerModel(graphModel(config), 'cast');
    const kinds = new Map(cast.nodes.map(n => [n.id, n.kind]));
    expect([...kinds.values()].some(kind => ['note', 'tool', 'issues'].includes(kind))).toBe(false);
    for (const edge of cast.edges.filter(e => !flowKinds.includes(e.kind))) {
      expect(castKinds).toContain(edge.kind);
      expect(['job', 'check']).toContain(kinds.get(edge.from));
      expect(['bot', 'skill']).toContain(kinds.get(edge.to));
    }
    expect(new Set(cast.edges.map(e => `${e.kind} ${e.from} ${e.to}`)).size).toBe(cast.edges.length);
  });
});

type Placed = { id: string; position: { x: number; y: number }; measured?: { width: number; height: number } };
type PlacedModule = {
  applyMoves: (changes: object[], nodes: Placed[]) => Placed[];
  decorate: (nodes: Placed[], selected: string | null, near: Set<string> | undefined) => Placed[];
};

describe('studio graph dragging', () => {
  it('moves a node in place, keeping its measured size and every other node as it was', async () => {
    const { applyMoves, decorate } = await studioModule<PlacedModule>('studio/placed.ts');
    const nodes = decorate(
      [
        { id: 'a', position: { x: 0, y: 0 }, measured: { width: 232, height: 72 } },
        { id: 'b', position: { x: 300, y: 0 }, measured: { width: 232, height: 72 } },
      ],
      null,
      undefined
    );
    const moved = applyMoves([{ type: 'position', id: 'a', position: { x: 12, y: 8 }, dragging: true }], nodes);
    expect(moved[0]).toMatchObject({ position: { x: 12, y: 8 }, measured: { width: 232, height: 72 } });
    expect(moved[1]).toBe(nodes[1]);
    expect(applyMoves([{ type: 'select', id: 'b', selected: true }], moved)).toBe(moved);
    expect(decorate(moved, null, undefined)).toEqual(moved);
    expect(decorate(moved, null, undefined).every((n, i) => n === moved[i])).toBe(true);
  });
});
