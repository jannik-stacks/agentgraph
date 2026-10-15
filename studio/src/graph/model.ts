import { backOf, nextOf, skillOf, triesOf, type Config } from '../../../src/config.ts';

/** One step of a workflow as the graph draws it. `id` is `workflow/name`, the key runs carry as `workflow/job`. */
export type Step = {
  id: string;
  workflow: string;
  name: string;
  /** The bot it casts, or the command it runs; neither for a step that waits for a human. */
  bot?: string;
  run?: string;
  checks: string[];
  tries?: number;
  next: string[];
  /** Where a failing step goes back to, and why. */
  back: { to: string; label: string }[];
  /** The step's prose: its skill, or its command. */
  about?: string | undefined;
};

/** A workflow: what starts it and its steps in file order. `entry` lists the steps the triggers start. */
export type Flow = { workflow: string; triggers: string[]; entry: string[]; steps: Step[] };

/** The only place that reads the hub's workflow shape; everything else draws `Flow`. */
export const flowsOf = (config: Config): Flow[] =>
  Object.values(config.workflows).map(workflow => {
    const name = workflow.name;
    const id = (step: string) => `${name}/${step}`;
    const steps = Object.entries(workflow.steps).map(([step, spec]): Step => {
      const next = nextOf(workflow, step);
      const back = spec.wait ? backOf(workflow, step) : undefined;
      return {
        id: id(step),
        workflow: name,
        name: step,
        ...(spec.bot !== undefined && { bot: spec.bot, about: config.skills[skillOf(step, spec)]?.body }),
        ...(spec.run !== undefined && { run: spec.run, about: spec.run }),
        checks: [...(spec.checks ?? []), ...(spec.requires ?? [])],
        ...(spec.checks && { tries: triesOf(spec) }),
        next: next === undefined ? [] : [id(next)],
        back: [
          ...(spec.checks ? [{ to: id(step), label: 'check fails' }] : []),
          ...(back === undefined ? [] : [{ to: id(back), label: 'a human answers' }]),
        ],
      };
    });
    return {
      workflow: name,
      triggers: Object.keys(workflow.on),
      entry: Object.keys(workflow.steps).slice(0, 1).map(id),
      steps,
    };
  });
