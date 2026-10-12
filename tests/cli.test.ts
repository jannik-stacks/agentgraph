import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.ts';

const examples = join(import.meta.dirname, '../examples');

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(s => (out.push(String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation(s => (err.push(String(s)), true));
  return { out, err };
};

afterEach(() => vi.restoreAllMocks());

describe('cli', () => {
  it('check passes on the example hub and fails closed on an empty one', async () => {
    const io = capture();
    expect(await main(['check', '--dir', join(examples, 'hub'), '--json'])).toBe(0);
    expect(await main(['check', '--dir', join(examples, 'payloads')])).toBe(2);
    expect(io.out[0]).toBe('{"ok":true}\n');
    expect(JSON.parse(io.out[1] ?? '').errors[0].message).toBe('no personas/*.md or workflows/*.md found');
  });

  it('plan prints the jobs a payload starts', async () => {
    const io = capture();
    const code = await main([
      'plan',
      '--event',
      'issue_comment',
      join(examples, 'payloads/issue-comment.json'),
      '--dir',
      join(examples, 'hub'),
      '--json',
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(io.out.join('')).jobs).toEqual([
      {
        workflow: 'issue-command',
        job: 'implement',
        persona: 'implementor',
        args: 'add a /health endpoint with a test',
      },
    ]);
  });
});
