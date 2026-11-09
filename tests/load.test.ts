import { describe, expect, it } from 'vitest';
import { compileWorkflow } from '../src/workflow.ts';
import { fixture, graphs } from './fixtures.ts';

const names = { agents: ['implementor', 'reviewer'], skills: ['implement'], checks: ['types', 'tests'] };
const file = (front: string, body = 'The prose.') => `---\n${front}\n---\n${body}\n`;
const messages = (text: string, n = names) =>
  compileWorkflow('workflows/issue.md', text, n).problems.map(p => p.message);

describe('compileWorkflow', () => {
  it.each(graphs)('loads every workflow of the %s fixture without problems', graph => {
    const { workflows, problems } = fixture(graph);
    expect(problems).toEqual([]);
    expect(Object.keys(workflows).length).toBeGreaterThan(0);
  });

  it('fills the defaults of a workflow and its steps', () => {
    const { workflow, problems } = compileWorkflow(
      'workflows/issue.md',
      file(
        [
          'on: issue_comment',
          'steps:',
          '  triage: { agent: implementor }',
          '  implement: { agent: implementor, checks: [types, tests] }',
          '  review: { agent: reviewer, back: implement, until: done }',
          '  merge: { wait: human, back: implement }',
        ].join('\n')
      ),
      names
    );
    expect(problems).toEqual([]);
    expect(workflow).toMatchObject({ name: 'issue', on: { issue_comment: {} }, concurrency: 'steer', checks: [] });
    expect(workflow!.branch).toBeUndefined();
    expect(workflow!.steps).toEqual([
      { name: 'triage', does: { agent: 'implementor' }, checks: [], tries: 1 },
      { name: 'implement', does: { agent: 'implementor', skill: 'implement' }, checks: ['types', 'tests'], tries: 3 },
      {
        name: 'review',
        does: { agent: 'reviewer' },
        checks: [],
        tries: 1,
        back: { to: 'implement', until: 'done', rounds: 3 },
      },
      {
        name: 'merge',
        does: { wait: 'human' },
        checks: ['types', 'tests'],
        tries: 1,
        back: { to: 'implement' },
        follow: 'merge',
      },
    ]);
  });

  it.each([true, false])('reads carry: %s on a step', carry => {
    const { workflow, problems } = compileWorkflow(
      'workflows/issue.md',
      file(`on: issues\nsteps:\n  implement: { agent: implementor, carry: ${carry} }`),
      names
    );
    expect(problems).toEqual([]);
    expect(workflow!.steps[0]!.carry).toBe(carry);
  });

  it.each([
    ['feedback:', {}],
    ['feedback: { restarts: true }', { restarts: true }],
  ])('reads on: { %s }', (feedback, trigger) => {
    const { workflow, problems } = compileWorkflow('workflows/retro.md', file(`on:\n  ${feedback}`), {
      ...names,
      agents: ['helper'],
    });
    expect(problems).toEqual([]);
    expect(workflow!.on).toEqual({ feedback: trigger });
  });

  it('reads a script step and branch filters', () => {
    const w = fixture('kit').workflows.merge!;
    expect(w.on).toEqual({ pull_request: { branches: ['agentgraph/*'] } });
    expect(w.steps).toEqual([
      {
        name: 'merge',
        does: { run: 'node "$AGENTGRAPH_DIR/scripts/merge-next.mjs"', returns: ['run'] },
        checks: ['types', 'tests'],
        tries: 3,
      },
    ]);
  });

  it('keeps the returns a script step lists', () => {
    const { workflow } = compileWorkflow(
      'workflows/issue.md',
      file('on: issues\nsteps:\n  gate: { run: node gate.mjs, returns: [comment, label] }'),
      names
    );
    expect(workflow!.steps[0]!.does).toEqual({ run: 'node gate.mjs', returns: ['comment', 'label'] });
  });

  it('refuses returns on a step that runs no script', () => {
    expect(messages(file('on: issues\nsteps:\n  implement: { agent: implementor, returns: [merge] }'))).toEqual([
      "steps.implement.returns: only a run step lists returns; an agent's returns are in its file",
    ]);
  });

  it('turns a workflow without steps into one step named after the file, prompted by the body', () => {
    const w = fixture('graph').workflows.review!;
    expect(w.on).toEqual({ pull_request: {} });
    expect(w.steps).toEqual([{ name: 'review', does: { agent: 'reviewer', skill: 'review' }, checks: [], tries: 1 }]);
    expect(w.body).toMatch(/^Review this pull request/);
  });

  it('takes the only agent when a workflow without steps names none', () => {
    const { workflow } = compileWorkflow('workflows/ask.md', file('on: issues'), { ...names, agents: ['helper'] });
    expect(workflow!.steps[0]!.does).toEqual({ agent: 'helper' });
  });

  it('asks for an agent when a workflow without steps names none and the graph has several', () => {
    expect(messages(file('on: issues'))).toEqual(['agent: a workflow without steps names its agent']);
  });

  it('rejects an agent next to steps', () => {
    expect(messages(file('on: issues\nagent: reviewer\nsteps:\n  a: { agent: reviewer }'))).toEqual([
      'agent: only a workflow without steps names its agent',
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

  it('rejects an agent step with back and no until, and until or rounds without back', () => {
    expect(
      messages(
        file(
          'on: issues\nsteps:\n  a: { agent: implementor, back: a }\n  b: { agent: reviewer, until: done }\n  c: { agent: reviewer, rounds: 2 }'
        )
      )
    ).toEqual([
      'steps.a.until: an agent step with a way back says until when',
      'steps.b.until: until needs back',
      'steps.c.rounds: rounds needs back',
    ]);
  });

  it('reads traces only on a run step', () => {
    const run = compileWorkflow(
      'workflows/issue.md',
      file('on: issues\nsteps:\n  a: { run: make, reads: traces }'),
      names
    );
    expect({
      does: run.workflow?.steps[0]?.does,
      problems: messages(file('on: issues\nsteps:\n  b: { agent: implementor, reads: traces }')),
    }).toEqual({
      does: { run: 'make', returns: ['run'], reads: 'traces' },
      problems: ['steps.b.reads: only a run step reads traces; an agent says so in its file'],
    });
  });

  it('rejects two doers, or none', () => {
    expect(
      messages(file('on: issues\nsteps:\n  a: { agent: implementor, run: make }\n  b: { checks: [types] }'))
    ).toEqual(['steps.a: name exactly one of agent, run and wait', 'steps.b: name exactly one of agent, run and wait']);
  });

  it('rejects unknown agents, skills and checks', () => {
    expect(messages(file('on: issues\nsteps:\n  a: { agent: ghost, skill: haunt, checks: [types, lint] }'))).toEqual([
      'steps.a.agent: unknown agent ghost',
      'steps.a.skill: unknown skill haunt',
      'steps.a.checks: unknown check lint',
    ]);
  });

  it('reports unknown keys and wrong values by path, one message per path', () => {
    const problems = messages(file('on: issues\njobs: {}\nsteps:\n  a: { agent: implementor, tries: 0, each: lines }'));
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^jobs: /);
    expect(problems.some(p => p.startsWith('steps.a.tries: '))).toBe(true);
    expect(problems.some(p => p.startsWith('steps.a.each: '))).toBe(true);
  });

  it('reports a missing trigger and broken frontmatter', () => {
    expect(messages(file('steps:\n  a: { agent: implementor }'))[0]).toMatch(/^on: /);
    expect(messages(file('on: [issues'))[0]).toMatch(/^frontmatter: /);
  });

  it('rejects empty steps', () => {
    expect(messages(file('on: issues\nsteps: {}'))).toEqual(['steps: name at least one step']);
  });
});
