import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/config.ts';
import { hubGraph } from '../src/graph.ts';
import { readHub } from '../src/load.ts';

const compiled = compile(await readHub(join(import.meta.dirname, '../examples/hub')));
if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
const graph = hubGraph(compiled.config);

describe('hubGraph', () => {
  it('has one node per trigger, job, bot, skill, check, read note kind, issue tracker and read tool', () => {
    expect(graph.nodes.map(n => `${n.id} ${n.badges?.join(',') ?? ''}`.trim())).toEqual([
      'trigger:issue/issue_comment /bothub,created',
      'trigger:issue/pull_request opened,synchronize',
      'job:issue/implement warn,bothub/{issue}-{slug}',
      'job:issue/review shadow',
      'bot:implementor opencode,writer',
      'bot:reviewer pi,review',
      'skill:implement',
      'skill:review-file',
      'skill:review',
      'check:review warn,reviewer',
      'check:types block,script',
      'note:decision 0',
      'note:convention 1',
      'note:caveat 1',
      'issues:issues github',
      'tool:issues_get read',
      'tool:notes_search read',
      'tool:notes_get read',
    ]);
    expect(graph.nodes.every(n => n.id.startsWith(`${n.kind}:`))).toBe(true);
  });

  it('links triggers, bots, skills, the until loop, fan-out, notes, preloads and tool calls', () => {
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
      'preloads job:issue/review -> note:decision',
      'preloads job:issue/review -> note:convention',
      'reads-notes bot:implementor -> note:caveat',
      'preloads bot:implementor -> issues:issues (issue, links)',
      'preloads bot:implementor -> note:decision',
      'preloads bot:implementor -> note:convention',
      'calls bot:implementor -> tool:issues_get',
      'calls bot:implementor -> tool:notes_search',
      'calls bot:implementor -> tool:notes_get',
      'reads-notes bot:reviewer -> note:caveat',
      'reads-notes skill:review-file -> note:convention',
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
    const convention = graph.nodes.find(n => n.id === 'note:convention');
    expect(convention?.detail).toEqual({
      notes: [
        { slug: 'typecheck-clean', title: 'The project typechecks with no errors', status: 'accepted', check: 'types' },
      ],
    });
  });

  it('draws needs between jobs and scripts', () => {
    const result = compile([
      {
        path: 'workflows/w.md',
        source: '---\non: { push: {} }\njobs:\n  a: { run: echo }\n  b: { needs: a, run: echo }\n---\n',
      },
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(hubGraph(result.config).edges).toEqual([
      { from: 'trigger:w/push', to: 'script:w/a', kind: 'triggers' },
      { from: 'script:w/a', to: 'script:w/b', kind: 'needs' },
    ]);
  });
});
