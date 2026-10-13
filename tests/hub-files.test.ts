import { describe, expect, it } from 'vitest';
import {
  currentChoice,
  initialValue,
  type ItemKind,
  itemSchema,
  type JsonSchema,
  matchesOption,
  newItem,
  nextIssueNumber,
  renameItem,
  switchChoice,
  unionChoices,
} from '../src/hub-files.ts';
import { Check, Job, type NoteKind } from '../src/schema.ts';

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

const FILES = [
  { path: 'bots/new-bot.md', source: '---\nharness: opencode\n---\n' },
  { path: 'bots/triager.md', source: '---\nharness: opencode\nskills: [triage]\n---\nRole.\n' },
  { path: 'skills/triage.md', source: '---\ndescription: Triage.\n---\nRead.\n' },
  { path: 'issues/3-first.md', source: '---\ntitle: First\n---\n' },
  { path: 'issues/12-later.md', source: '---\ntitle: Later\n---\n' },
  { path: 'notes/decision/new-note.md', source: '---\ntitle: Note\n---\n' },
];

const NEW_ITEMS: { kind: ItemKind; note?: NoteKind; path: string }[] = [
  { kind: 'bot', path: 'bots/new-bot-2.md' },
  { kind: 'skill', path: 'skills/new-skill.md' },
  { kind: 'issue', path: 'issues/13-new-issue.md' },
  { kind: 'note', note: 'decision', path: 'notes/decision/new-note-2.md' },
  { kind: 'note', note: 'caveat', path: 'notes/caveat/new-note.md' },
  { kind: 'hub', path: 'hub.yaml' },
];

describe('newItem', () => {
  it.each(NEW_ITEMS)('puts a new $kind at $path', ({ kind, note, path }) => {
    expect(newItem(FILES, kind, note)).toEqual({ path, data: initialValue(itemSchema(kind)), body: '' });
  });
});

const ISSUE_NAMES = [
  { names: [], next: 1 },
  { names: ['3-first.md', '12-later.md'], next: 13 },
  { names: ['7-slug'], next: 8 },
];

describe('nextIssueNumber', () => {
  it.each(ISSUE_NAMES)('numbers the issue after $names as $next', ({ names, next }) => {
    expect(nextIssueNumber(names)).toBe(next);
  });
});

const slugRule = 'lowercase letters, digits and dashes, starting with a letter';

const REFUSED_RENAMES = [
  { from: 'bots/triager.md', to: 'bots/Bad Name.md', error: slugRule },
  { from: 'bots/triager.md', to: 'skills/triager.md', error: slugRule },
  { from: 'bots/triager.md', to: 'bots/new-bot.md', error: 'that name is taken' },
  { from: 'issues/3-first.md', to: 'issues/first.md', error: 'a number, a dash and a lowercase slug' },
  { from: 'bots/ghost.md', to: 'bots/spirit.md', error: 'there is no item at bots/ghost.md' },
];

describe('renameItem', () => {
  it.each(REFUSED_RENAMES)('refuses $from to $to', ({ from, to, error }) => {
    expect(renameItem(FILES, from, to)).toEqual({ ok: false, error });
  });

  it('moves the item and points every reference at the new name', () => {
    expect(renameItem(FILES, 'skills/triage.md', 'skills/sorting.md')).toEqual({
      ok: true,
      changes: [
        { path: 'skills/triage.md', delete: true },
        { path: 'skills/sorting.md', data: { description: 'Triage.' }, body: 'Read.' },
        { path: 'bots/triager.md', data: { harness: 'opencode', skills: ['sorting'] }, body: 'Role.' },
      ],
    });
  });

  it('moves a note to another note kind', () => {
    expect(renameItem(FILES, 'notes/decision/new-note.md', 'notes/caveat/new-note.md')).toMatchObject({ ok: true });
  });

  it('changes nothing when the name stays', () => {
    expect(renameItem(FILES, 'bots/triager.md', 'bots/triager.md')).toEqual({ ok: true, changes: [] });
  });
});
