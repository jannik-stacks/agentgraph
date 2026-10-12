import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/config.ts';
import { localIssues } from '../src/issues-local.ts';
import { issueContext, overlaps, relevantNotes } from '../src/preload.ts';
import type { BotEvent } from '../src/types.ts';
import { temp } from './git.ts';

const note = (path: string, front: string) => ({ path, source: `---\n${front}\n---\n\n${path}` });

const compiled = compile([
  note('notes/decision/everywhere.md', 'title: Everywhere'),
  note('notes/convention/docs.md', 'title: Docs\npaths: [docs/**]'),
  note('notes/convention/old.md', 'title: Old\nstatus: retired'),
  note('notes/pattern/listed.md', 'title: Listed'),
  note('notes/caveat/kit.md', 'title: Kit\npaths: [kit/src/**]'),
  note('notes/caveat/loose.md', 'title: Loose'),
  note('notes/caveat/drafted.md', 'title: Drafted\nstatus: proposed'),
  note('notes/decision/ruled.md', 'title: Ruled\nstatus: accepted'),
]);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
const { notes } = compiled.config;
const names = (kinds: Parameters<typeof relevantNotes>[1]['kinds'], paths?: string[]) =>
  relevantNotes(notes, { kinds, paths }).map(n => n.name);

describe('relevantNotes', () => {
  it('loads rules whose paths overlap, and knowledge only when listed or scoped to the job', () => {
    expect(names([])).toEqual(['everywhere', 'docs', 'ruled']);
    expect(names([], ['kit/**'])).toEqual(['everywhere', 'kit', 'ruled']);
    expect(names(['pattern'], ['docs/content/**'])).toEqual(['everywhere', 'docs', 'listed', 'ruled']);
    expect(names(['caveat'], ['docs/**'])).toEqual(['everywhere', 'docs', 'loose', 'ruled']);
  });

  it('loads only accepted notes, never proposed or retired ones', () => {
    const loaded = names(['decision', 'convention', 'pattern', 'caveat'], ['docs/**', 'kit/**']);
    expect(loaded).toContain('ruled');
    expect(loaded).not.toContain('drafted');
    expect(loaded).not.toContain('old');
  });

  it('judges glob overlap by literal prefix', () => {
    expect(overlaps(['docs/**'], ['docs/content/**/*.mdx'])).toBe(true);
    expect(overlaps(['kit/**'], ['CLAUDE.md'])).toBe(false);
    expect(overlaps(['**/*.ts'], ['kit/**'])).toBe(true);
    expect(overlaps(undefined, ['kit/**'])).toBe(true);
  });
});

describe('issueContext', () => {
  const event: BotEvent = {
    id: 'e',
    ts: 't',
    source: 'local',
    trigger: 'issue_comment',
    repo: 'a/b',
    number: 6,
    actor: { login: 'morgan', association: 'OWNER' },
  };

  it('renders the issue with comments, then its parent, links and sub-issues', async () => {
    const dir = temp('issues');
    const file = (name: string, front: string, body: string) =>
      writeFileSync(join(dir, name), `---\n${front}\n---\n\n${body}\n`);
    file('4-spec.md', 'title: Spec\nlabels: [spec]', 'The spec.');
    file('5-plan.md', 'title: Plan\nlabels: [plan]\nlinks: [4]', 'The plan.');
    file(
      '6-step.md',
      'title: Step\nparent: 5\nlinks: [4]',
      'Do the step.\n\n## @morgan at 2026-10-12T10:00:00.000Z\n\n/bothub'
    );
    file('7-sub.md', 'title: Sub\nparent: 6\nstate: closed', 'Done.');
    const issues = localIssues(dir, { repo: 'a/b' });
    expect(await issueContext(issues, event, ['issue', 'links'])).toBe(
      [
        '## Issue #6: Step',
        'State: open. Parent: #5. Links: #4',
        'Do the step.',
        '### @morgan at 2026-10-12T10:00:00.000Z\n\n/bothub',
        '## Linked issues',
        '### #5: Plan',
        'State: open. Labels: plan. Links: #4',
        'The plan.',
        '### #4: Spec',
        'State: open. Labels: spec',
        'The spec.',
        '### Sub-issues\n\n- [x] #7: Sub',
      ].join('\n\n')
    );
    expect(await issueContext(issues, event, ['notes'])).toBeUndefined();
    expect(await issueContext(undefined, event, ['issue'])).toBeUndefined();
    expect(await issueContext(issues, { ...event, number: 99 }, ['issue'])).toBeUndefined();
  });
});
