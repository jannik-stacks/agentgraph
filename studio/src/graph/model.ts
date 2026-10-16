import type { Step, Workflow } from '../../../core/src/workflow.ts';
import { backOf, skillOf, stepOrder, triesOf, type Config } from '../../../src/config.ts';
import type { Fixture } from './scenarios.ts';

/** A v1 hub's workflows in core's shape, so one graph draws both formats. Steps follow their `next` from the first. */
export const fixturesOf = (config: Config): Fixture[] =>
  Object.values(config.workflows).map(workflow => {
    const steps = stepOrder(workflow).order.map((name): Step => {
      const spec = workflow.steps[name]!;
      const checks = [...(spec.checks ?? []), ...(spec.requires ?? [])];
      const back = spec.wait ? backOf(workflow, name) : undefined;
      return {
        name,
        does:
          spec.run !== undefined
            ? { run: spec.run }
            : spec.wait
              ? { wait: 'human' }
              : { bot: spec.bot ?? '', skill: skillOf(name, spec) },
        checks,
        tries: spec.checks ? triesOf(spec) : 1,
        ...(back !== undefined && { back: { to: back } }),
      };
    });
    return {
      id: workflow.name,
      workflow: { ...workflow, on: workflow.on as Workflow['on'], steps },
      checks: Object.fromEntries(
        Object.entries(config.checks).map(([name, check]) => [
          name,
          { mode: check.mode === 'log' ? 'warn' : check.mode, ...(check.type !== 'script' && { judge: check.type }) },
        ])
      ),
      runs: [],
    };
  });
