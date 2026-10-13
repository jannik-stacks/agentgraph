import { describe, expect, it } from 'vitest';
import {
  currentChoice,
  itemSchema,
  type JsonSchema,
  matchesOption,
  switchChoice,
  unionChoices,
} from '../src/hub-files.ts';
import { Check, Job } from '../src/schema.ts';

/** The fields a form shows for a union option: its properties, minus the discriminator it fixes. */
const formFields = (option: JsonSchema) =>
  Object.entries(option.properties ?? {})
    .filter(([, p]) => p.const === undefined)
    .map(([k]) => k)
    .sort();

const shapeFields = (options: readonly { shape: Record<string, unknown> }[]) =>
  Object.fromEntries(
    options.map(o => [
      String((o.shape.type as { value: unknown }).value),
      Object.keys(o.shape)
        .filter(k => k !== 'type')
        .sort(),
    ])
  );

describe('union forms', () => {
  const check = itemSchema('check');
  const job = (itemSchema('workflow').properties!.jobs!.additionalProperties as JsonSchema).oneOf!;

  it('offers one choice per type, with exactly the fields of that type', () => {
    for (const [options, schema] of [
      [check.oneOf!, Check.options],
      [job, Job.options],
    ] as const) {
      const choices = unionChoices(options);
      const shapes = shapeFields(schema);
      expect(choices.map(c => c.label)).toEqual(Object.keys(shapes));
      for (const choice of choices) expect(formFields(choice.option)).toEqual(shapes[choice.label]);
    }
  });

  it('offers each value of over, and a script field for run and each', () => {
    const over = check.oneOf![0]!.properties!.over!;
    const choices = unionChoices(over.anyOf!);
    expect(choices.map(c => c.label)).toEqual([
      'diff',
      'added',
      'event',
      'each-file',
      'each-hunk',
      'run',
      'each',
      'each-hunk with options',
    ]);
    expect(currentChoice(choices, { 'each-hunk': { context: 'function' } })?.label).toBe('each-hunk with options');
    expect(over.default).toBe('diff');
    expect(currentChoice(choices, 'each-hunk')?.label).toBe('each-hunk');
    expect(currentChoice(choices, { each: 'ls', max: 3 })?.label).toBe('each');
    expect(switchChoice(choices[1]!, { run: 'ls' })).toBe('added');
  });

  it('picks the option a value is and keeps shared fields when the type changes', () => {
    const choices = unionChoices(check.oneOf!);
    const script = { type: 'script', run: 'npm test', over: 'each-file', mode: 'block', paths: ['src/**'] };
    expect(currentChoice(choices, script)?.label).toBe('script');
    expect(matchesOption(choices[1]!.option, script)).toBe(false);
    const bot = switchChoice(
      choices.find(c => c.label === 'bot')!,
      script
    ) as Record<string, unknown>;
    expect(bot).toMatchObject({ type: 'bot', over: 'each-file', mode: 'block', paths: ['src/**'] });
    expect(bot).not.toHaveProperty('run');
    expect(currentChoice(choices, bot)?.label).toBe('bot');
  });
});
