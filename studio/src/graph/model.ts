import type { Config } from '../../../src/config.ts';

/** One step of a workflow as the graph draws it. `id` is `workflow/name`, the key runs carry as `workflow/job`. */
export type Step = {
  id: string;
  workflow: string;
  name: string;
  /** The bot it casts, or the command it runs. */
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
    const id = (job: string) => `${name}/${job}`;
    const jobs = Object.entries(workflow.jobs);
    const steps = jobs.map(([job, spec]): Step => {
      const until = spec.type === 'bot' ? spec.until : undefined;
      return {
        id: id(job),
        workflow: name,
        name: job,
        ...(spec.type === 'bot'
          ? { bot: spec.bot, about: config.skills[spec.skill]?.body }
          : { run: spec.run, about: spec.run }),
        checks: [...(until?.checks ?? []), ...(spec.requires ?? [])],
        ...(until && { tries: until.max }),
        next: jobs.filter(([, other]) => other.needs.includes(job)).map(([other]) => id(other)),
        back: until ? [{ to: id(job), label: 'check fails' }] : [],
      };
    });
    return {
      workflow: name,
      triggers: Object.keys(workflow.on),
      entry: jobs.filter(([, spec]) => !spec.needs.length).map(([job]) => id(job)),
      steps,
    };
  });
