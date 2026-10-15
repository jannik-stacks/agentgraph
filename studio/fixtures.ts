import type { Plugin } from 'vite';
import { type Fixture, scenarios, simulate } from './src/graph/views/scenarios.ts';

const id = 'virtual:fixtures';

/** Serves core's fixture workflows, each with runs replayed through the engine's begin and transition, as `virtual:fixtures`. */
export const fixtures = (): Plugin => ({
  name: 'bothub:fixtures',
  resolveId: source => (source === id ? `\0${id}` : undefined),
  async load(source) {
    if (source !== `\0${id}`) return;
    const core = new URL('../core/', import.meta.url);
    const { hubs, fixture }: typeof import('../core/tests/fixtures.ts') = await import(
      new URL('tests/fixtures.ts', core).href
    );
    const engine: typeof import('../core/src/workflow.ts') = await import(new URL('src/workflow.ts', core).href);
    const all: Fixture[] = hubs.flatMap(hub => {
      const { checks, workflows } = fixture(hub);
      return Object.values(workflows).map(workflow => ({
        id: `${hub}/${workflow.name}`,
        workflow: { ...workflow, path: `${hub}/workflows/${workflow.name}.md` },
        checks,
        runs: scenarios(workflow, checks).map(({ label, next }) => ({ label, ...simulate(workflow, next, engine) })),
      }));
    });
    return `export const fixtures = ${JSON.stringify(all)};`;
  },
});
