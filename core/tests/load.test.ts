import { describe, expect, it } from 'vitest';
import { load } from '../src/workflow.ts';
import { fixture, hubs } from './fixtures.ts';

const names = { bots: ['implementor', 'reviewer'], skills: ['implement'], checks: ['types', 'tests'] };
const file = (front: string, body = 'The prose.') => `---\n${front}\n---\n${body}\n`;
const messages = (text: string, n = names) => load('workflows/issue.md', text, n).problems.map(p => p.message);

describe('load', () => {
  it.each(hubs)('loads every workflow of the %s fixture without problems', hub => {
    const { workflows, problems } = fixture(hub);
    expect(problems).toEqual([]);
    expect(Object.keys(workflows).length).toBeGreaterThan(0);
  });

  it('fills the defaults of the acme-app issue workflow', () => {
    const w = fixture('acme-app').workflows.issue!;
    expect(w.name).toBe('issue');
    expect(w.on).toEqual({ issue_comment: { command: '/bothub' } });
    expect(w.branch).toBe('bothub/{issue}');
    expect(w.body).toMatch(/^A maintainer comments/);
    expect(w.steps.map(s => s.name)).toEqual(['triage', 'implement', 'review', 'merge']);
    const [triage, implement, review, merge] = w.steps;
    expect(triage).toEqual({ name: 'triage', does: { bot: 'triager', skill: 'triage' }, checks: [], tries: 1 });
    expect(implement!.tries).toBe(4);
    expect(review).toEqual({
      name: 'review',
      does: { bot: 'reviewer', skill: 'review-hunk' },
      checks: [],
      tries: 1,
      back: { to: 'implement', until: 'no hunk needs a change before it can merge', rounds: 2 },
      each: 'hunks',
    });
    expect(merge).toEqual({ name: 'merge', does: { wait: 'human' }, checks: [], tries: 1, back: { to: 'implement' } });
  });

  it('gives a step with checks three tries and a bot way back three rounds', () => {
    const w = fixture('loop').workflows.align!;
    expect(w.steps.find(s => s.name === 'write')!.tries).toBe(3);
    expect(w.steps.find(s => s.name === 'align')!.back!.rounds).toBe(3);
  });

  it('reads a script step and branch filters', () => {
    const w = fixture('acme-app').workflows.merge!;
    expect(w.on).toEqual({ pull_request: { branches: ['bothub/*'] } });
    expect(w.steps).toEqual([
      {
        name: 'merge',
        does: { run: 'node "$BOTHUB_HUB/scripts/merge-next.mjs"' },
        checks: ['types', 'tests'],
        tries: 3,
      },
    ]);
  });

  it('turns a workflow without steps into one step named after the file, prompted by the body', () => {
    const w = fixture('hub').workflows.review!;
    expect(w.on).toEqual({ pull_request: {} });
    expect(w.steps).toEqual([{ name: 'review', does: { bot: 'reviewer', skill: 'review' }, checks: [], tries: 1 }]);
    expect(w.body).toMatch(/^Review this pull request/);
  });

  it('takes the only bot when a workflow without steps names none', () => {
    const { workflow } = load('workflows/ask.md', file('on: issues'), { ...names, bots: ['helper'] });
    expect(workflow!.steps[0]!.does).toEqual({ bot: 'helper' });
  });

  it('asks for a bot when a workflow without steps names none and the hub has several', () => {
    expect(messages(file('on: issues'))).toEqual(['bot: a workflow without steps names its bot']);
  });

  it('rejects a bot next to steps', () => {
    expect(messages(file('on: issues\nbot: reviewer\nsteps:\n  a: { bot: reviewer }'))).toEqual([
      'bot: only a workflow without steps names its bot',
    ]);
  });

  it('rejects a way back to a later or unknown step', () => {
    expect(
      messages(
        file('on: issues\nsteps:\n  a: { wait: human, back: b }\n  b: { wait: human }\n  c: { wait: human, back: z }')
      )
    ).toEqual([
      'steps.a.back: b comes later; a way back goes to this step or an earlier one',
      'steps.c.back: unknown step z',
    ]);
  });

  it('rejects a bot step with back and no until, and until or rounds without back', () => {
    expect(
      messages(
        file(
          'on: issues\nsteps:\n  a: { bot: implementor, back: a }\n  b: { bot: reviewer, until: done }\n  c: { bot: reviewer, rounds: 2 }'
        )
      )
    ).toEqual([
      'steps.a.until: a bot step with a way back says until when',
      'steps.b.until: until needs back',
      'steps.c.rounds: rounds needs back',
    ]);
  });

  it('rejects two doers, or none', () => {
    expect(
      messages(file('on: issues\nsteps:\n  a: { bot: implementor, run: make }\n  b: { checks: [types] }'))
    ).toEqual(['steps.a: name exactly one of bot, run and wait', 'steps.b: name exactly one of bot, run and wait']);
  });

  it('rejects unknown bots, skills and checks', () => {
    expect(messages(file('on: issues\nsteps:\n  a: { bot: ghost, skill: haunt, checks: [types, lint] }'))).toEqual([
      'steps.a.bot: unknown bot ghost',
      'steps.a.skill: unknown skill haunt',
      'steps.a.checks: unknown check lint',
    ]);
  });

  it('reports unknown keys and wrong values by path, one message per path', () => {
    const problems = messages(file('on: issues\njobs: {}\nsteps:\n  a: { bot: implementor, tries: 0, each: lines }'));
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^jobs: /);
    expect(problems.some(p => p.startsWith('steps.a.tries: '))).toBe(true);
    expect(problems.some(p => p.startsWith('steps.a.each: '))).toBe(true);
  });

  it('reports a missing trigger and broken frontmatter', () => {
    expect(messages(file('steps:\n  a: { bot: implementor }'))[0]).toMatch(/^on: /);
    expect(messages(file('on: [issues'))[0]).toMatch(/^frontmatter: /);
  });

  it('rejects empty steps', () => {
    expect(messages(file('on: issues\nsteps: {}'))).toEqual(['steps: name at least one step']);
  });
});
