import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { change, runScript, temp, write } from './kit.ts';

const script = resolve(import.meta.dirname, '../examples/bothub/scripts/note-pairs.mjs');

const note = (title: string, body: string, status = 'accepted') =>
  `---\ntitle: ${title}\nstatus: ${status}\n---\n${body}\n`;

describe('note-pairs', () => {
  it('pairs each hunk with the notes that share its words and carries the files the change touches', () => {
    const hub = temp('hub');
    write(hub, {
      'notes/caveat/ids.md': note('Ids live in a field', 'Never parse a step marker back from an issue body.'),
      'notes/style/icons.md': note('Every icon has a tooltip', 'An icon button explains itself on hover.'),
      'notes/style/old.md': note('Step markers in bodies', 'Parse the step marker from the issue body.', 'proposed'),
    });
    const repo = change(
      { 'src/apply.ts': 'export const apply = () => 1;\n' },
      {
        'src/apply.ts':
          'export const stepOf = (issue: { body: string }) => /step marker: (\\S+)/.exec(issue.body)?.[1];\n',
      }
    );
    const { ok, out } = runScript(script, repo, ['src/'], { BOTHUB_HUB: hub });
    expect(ok).toBe(true);
    const items = out.split('\n').map(line => JSON.parse(line));
    expect(items.map(item => item.path)).toEqual(['src/apply.ts:1 caveat/ids']);
    expect(items[0]).toMatchObject({
      note: expect.stringMatching(/^Ids live in a field\n\nNever parse/),
      'files changed': ['src/apply.ts'],
    });
  });
});
