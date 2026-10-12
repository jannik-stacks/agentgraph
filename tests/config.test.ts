import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, jobOrder, type SourceFile } from '../src/config.ts';
import { parseMarkdown } from '../src/markdown.ts';

const hub = join(import.meta.dirname, '../examples/hub');
const exampleFiles = (): SourceFile[] =>
  ['personas', 'workflows'].flatMap((dir) =>
    readdirSync(join(hub, dir)).map((name) => ({ path: `${dir}/${name}`, source: readFileSync(join(hub, dir, name), 'utf8') })),
  );

const persona = (name: string, canWrite = '[reply]') => ({
  path: `personas/${name}.md`,
  source: `---\nexecutor: claude-code\ncan-write: ${canWrite}\n---\nrole`,
});
const workflow = (frontmatter: string, body = '') => ({ path: 'workflows/w.md', source: `---\n${frontmatter}\n---\n${body}` });
const errorsOf = (files: SourceFile[]) => {
  const result = compile(files);
  return result.ok ? [] : result.errors.map((e) => e.message);
};

describe('parseMarkdown', () => {
  it('splits frontmatter, body and sections', () => {
    const doc = parseMarkdown('---\na: 1\n---\nintro\n\n## one\nfirst\n\n## two\nsecond\n');
    expect(doc.data).toEqual({ a: 1 });
    expect(doc.sections).toEqual({ one: 'first', two: 'second' });
  });

  it('rejects missing frontmatter and duplicate sections', () => {
    expect(() => parseMarkdown('no frontmatter')).toThrow('missing YAML frontmatter');
    expect(() => parseMarkdown('---\na: 1\n---\n## x\n\n## x\n')).toThrow('duplicate section');
  });
});

describe('compile', () => {
  it('accepts the example hub and applies defaults', () => {
    const result = compile(exampleFiles());
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const { personas, workflows } = result.config;
    expect(Object.keys(personas).sort()).toEqual(['implementor', 'reviewer']);
    expect(personas.reviewer?.['max-turns']).toBe(15);
    const flow = workflows['issue-command'];
    expect(flow?.on.issue_comment?.guard?.associations).toEqual(['OWNER', 'MEMBER', 'COLLABORATOR']);
    expect(flow?.jobs.review?.mode).toBe('shadow');
    expect(flow?.jobs.implement?.needs).toEqual([]);
    expect(flow?.prompts.implement).toContain('Open a pull request');
  });

  it('rejects unknown keys', () => {
    expect(errorsOf([workflow('name: w\non: {}\njobs: {}\nextra: 1')]).join()).toMatch(/extra/);
  });

  it('checks references between jobs, personas and sections', () => {
    const errors = errorsOf([
      persona('p'),
      workflow(
        [
          'name: w',
          'on: { pull_request: }',
          'jobs:',
          '  a: { needs: missing, persona: p, safe-outputs: { open-pr: {} } }',
          '  b: { persona: ghost }',
          '  c: { on: { issue_comment: {} } }',
        ].join('\n'),
        '## stray\ntext',
      ),
    ]);
    expect(errors).toEqual(
      expect.arrayContaining([
        'job "a" needs unknown job "missing"',
        'job "a" runs persona "p" but has no "## a" section',
        'job "a" allows "open-pr", which persona "p" cannot write',
        'job "b" uses unknown persona "ghost"',
        'job "c" triggers on "issue_comment", which the workflow does not listen to',
        'section "## stray" has no job',
      ]),
    );
  });

  it('rejects needs cycles', () => {
    const errors = errorsOf([workflow('name: w\non: {}\njobs:\n  a: { needs: b }\n  b: { needs: [a] }')]);
    expect(errors).toContain('needs cycle: a -> b -> a');
  });
});

describe('jobOrder', () => {
  it('puts every job after the jobs it needs', () => {
    const jobs = { ship: { needs: ['lint', 'test'] }, lint: { needs: ['changed'] }, test: { needs: ['changed'] }, changed: { needs: [] } };
    expect(jobOrder({ jobs } as never)).toEqual(['changed', 'lint', 'test', 'ship']);
  });
});
