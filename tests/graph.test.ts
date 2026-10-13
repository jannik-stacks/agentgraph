import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/config.ts';
import { hubGraph } from '../src/graph.ts';
import { readHub } from '../src/load.ts';

const compiled = compile(await readHub(join(import.meta.dirname, '../examples/hub')));
if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
const graph = hubGraph(compiled.config);

describe('hubGraph', () => {
  it('has one node per trigger, job, bot, skill, check, note kind with notes, issue tracker and read tool', () => {
    expect(graph.nodes.map(n => `${n.id} ${n.badges?.join(',') ?? ''}`.trim())).toEqual([
      'trigger:issue/issue_comment /bothub,created',
      'trigger:issue/pull_request opened,synchronize',
      'job:issue/implement warn,bothub/{issue}',
      'job:issue/review log',
      'bot:implementor opencode,writer',
      'bot:reviewer pi,review',
      'skill:implement',
      'skill:review-file',
      'skill:review',
      'check:review warn,reviewer',
      'check:types block,script',
      'note:decision 1',
      'note:style 2',
      'note:caveat 2',
      'issues:issues github',
      'tool:issues_get read',
      'tool:notes_search read',
      'tool:notes_get read',
    ]);
    expect(graph.nodes.every(n => n.id.startsWith(`${n.kind}:`))).toBe(true);
  });

  it('links triggers, bots, skills, the until loop, fan-out, issue preloads and tool calls, and no edge to notes', () => {
    expect(graph.edges.map(e => `${e.kind} ${e.from} -> ${e.to}${e.label ? ` (${e.label})` : ''}`)).toEqual([
      'triggers trigger:issue/issue_comment -> job:issue/implement',
      'runs-as job:issue/implement -> bot:implementor',
      'uses-skill job:issue/implement -> skill:implement',
      'calls job:issue/implement -> tool:issues_get',
      'calls job:issue/implement -> tool:notes_search',
      'gates check:types -> job:issue/implement',
      'loops-back check:types -> job:issue/implement (max 2)',
      'gates check:review -> job:issue/implement',
      'loops-back check:review -> job:issue/implement (max 2)',
      'triggers trigger:issue/pull_request -> job:issue/review',
      'runs-as job:issue/review -> bot:reviewer',
      'uses-skill job:issue/review -> skill:review',
      'preloads job:issue/review -> issues:issues (issue)',
      'preloads bot:implementor -> issues:issues (issue, links)',
      'calls bot:implementor -> tool:issues_get',
      'calls bot:implementor -> tool:notes_search',
      'calls bot:implementor -> tool:notes_get',
      'fans-out check:review -> bot:reviewer (for each file)',
      'uses-skill check:review -> skill:review-file',
    ]);
    const ids = new Set(graph.nodes.map(n => n.id));
    expect(graph.edges.filter(e => !ids.has(e.from) || !ids.has(e.to))).toEqual([]);
  });

  it('carries details for the studio', () => {
    const job = graph.nodes.find(n => n.id === 'job:issue/implement');
    expect(job?.detail).toMatchObject({
      workflow: 'issue',
      bot: 'implementor',
      until: { checks: ['types', 'review'] },
    });
    const style = graph.nodes.find(n => n.id === 'note:style');
    expect(style?.detail).toEqual({
      notes: [
        { slug: 'small-pure-functions', title: 'Logic lives in small pure functions', status: 'accepted' },
        { slug: 'typecheck-clean', title: 'The project typechecks with no errors', status: 'accepted', check: 'types' },
      ],
    });
  });

  it('draws needs between jobs and scripts', () => {
    const result = compile([
      {
        path: 'workflows/w.md',
        source:
          '---\non: { push: {} }\njobs:\n  a: { type: script, run: echo }\n  b: { type: script, needs: a, run: echo }\n---\n',
      },
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(hubGraph(result.config).edges).toEqual([
      { from: 'trigger:w/push', to: 'script:w/a', kind: 'triggers' },
      { from: 'script:w/a', to: 'script:w/b', kind: 'needs' },
    ]);
  });
});
