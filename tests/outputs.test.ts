import { describe, expect, it } from 'vitest';
import { extractProposals, matchGlob, Proposal, validate } from '../src/outputs.ts';
import { ProposalKind, type Return } from '../src/schema.ts';

const fence = (body: string, info = 'bothub') => `\`\`\`${info}\n${body}\n\`\`\``;

describe('Proposal', () => {
  it('covers every proposal kind', () => {
    expect(Proposal.options.map(o => o.shape.kind.value).sort()).toEqual([...ProposalKind.options, 'close'].sort());
  });
});

describe('extractProposals', () => {
  it('returns nothing without a bothub block', () => {
    expect(extractProposals('Done.\n' + fence('[{"kind":"reply","body":"x"}]', 'json'))).toEqual({
      proposals: [],
      errors: [],
    });
  });

  it('reads a JSON array', () => {
    const text = `All done.\n\n${fence('[{"kind":"reply","body":"hi"},{"kind":"label","add":["bug"]}]')}\n`;
    expect(extractProposals(text)).toEqual({
      proposals: [
        { kind: 'reply', body: 'hi' },
        { kind: 'label', add: ['bug'] },
      ],
      errors: [],
    });
  });

  it('reads JSON Lines from the last block only', () => {
    const text = [
      fence('[{"kind":"reply","body":"draft"}]'),
      'changed my mind',
      fence('{"kind":"ask","question":"which db?"}\n\n{"kind":"reply","body":"final"}'),
    ].join('\n');
    expect(extractProposals(text).proposals).toEqual([
      { kind: 'ask', question: 'which db?' },
      { kind: 'reply', body: 'final' },
    ]);
  });

  it('reports bad JSON and invalid proposals, keeping the valid ones', () => {
    expect(extractProposals(fence('[{"kind":"reply",')).errors[0]).toMatch(/^invalid JSON/);
    const { proposals, errors } = extractProposals(
      fence('{"kind":"reply","body":"ok"}\nnot json\n{"kind":"merge"}\n{"kind":"reply","body":"x","extra":1}')
    );
    expect(proposals).toEqual([{ kind: 'reply', body: 'ok' }]);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toBe('line 2: invalid JSON');
  });
});

describe('matchGlob', () => {
  it('matches exact paths, single segments and any depth', () => {
    expect(matchGlob('README.md', 'README.md')).toBe(true);
    expect(matchGlob('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('src/*.ts', 'src/x/a.ts')).toBe(false);
    expect(matchGlob('src/**', 'src/x/y/a.ts')).toBe(true);
    expect(matchGlob('**/*.md', 'README.md')).toBe(true);
    expect(matchGlob('docs/**/*.md', 'docs/a/b.md')).toBe(true);
    expect(matchGlob('docs/**/*.md', 'docs/b.md')).toBe(true);
    expect(matchGlob('a.ts', 'aXts')).toBe(false);
  });
});

describe('validate', () => {
  const allowed = { returns: ['reply', 'push', 'merge-request', 'note'] as Return[], paths: ['src/**', 'README.md'] };

  it('accepts allowed proposals and applies outside log mode', () => {
    const proposals: Proposal[] = [
      { kind: 'reply', body: 'a' },
      { kind: 'push', branch: 'bothub/7-fix', files: ['src/a.ts', 'README.md'] },
      { kind: 'merge-request', title: 't', body: 'b', branch: 'bothub/7-fix' },
      { kind: 'note', note: 'caveat', slug: 'fork-prs', title: 'Fork PRs?', body: 'Which repo?' },
    ];
    expect(validate(proposals, allowed, 'warn')).toEqual({ accepted: proposals, rejected: [], apply: true });
    expect(validate(proposals, allowed, 'log')).toEqual({ accepted: proposals, rejected: [], apply: false });
  });

  it('rejects kinds the job does not allow', () => {
    const proposal: Proposal = { kind: 'label', add: ['x'] };
    expect(validate([proposal], allowed, 'block').rejected).toEqual([
      { proposal, reason: '"label" is not allowed for this job' },
    ]);
    expect(validate([proposal], { returns: [] }, 'block').accepted).toEqual([]);
  });

  it('caps replies at 3 and every other kind at 1', () => {
    const replies: Proposal[] = ['a', 'b', 'c', 'd'].map(body => ({ kind: 'reply', body }));
    const { accepted, rejected } = validate(replies, allowed, 'warn');
    expect(accepted).toHaveLength(3);
    expect(rejected).toEqual([{ proposal: replies[3], reason: 'more than 3 "reply" proposals' }]);
    const pr: Proposal = { kind: 'merge-request', title: 't', body: '', branch: 'bothub/x' };
    expect(validate([pr, pr], allowed, 'warn').rejected[0]?.reason).toBe('more than 1 "merge-request" proposals');
  });

  it('rejects files outside paths or the repository', () => {
    const push = (files: string[]): Proposal => ({ kind: 'push', branch: 'bothub/x', files });
    const reason = (files: string[]) => validate([push(files)], allowed, 'warn').rejected[0]?.reason;
    expect(reason(['src/a.ts', 'package.json'])).toBe('path "package.json" is outside the allowed paths');
    expect(reason(['src/../package.json'])).toBe('path "src/../package.json" escapes the repository');
    expect(reason(['/etc/passwd'])).toBe('path "/etc/passwd" escapes the repository');
    const anywhere = (files: string[], paths?: string[]) =>
      validate([push(files)], { returns: ['push'], ...(paths && { paths }) }, 'warn').rejected[0]?.reason;
    expect(anywhere(['.github/workflows/ci.yml'])).toMatch(/is a GitHub workflow/);
    expect(anywhere(['.github/workflows/ci.yml'], ['**'])).toMatch(/is a GitHub workflow/);
    expect(anywhere(['.github/workflows/ci.yml'], ['.github/workflows/**'])).toBeUndefined();
  });

  it('always allows a close and keeps the approved label for humans', () => {
    const close: Proposal = { kind: 'close', as: 'no-op', reason: 'already done' };
    expect(validate([close], { returns: [] }, 'warn').accepted).toEqual([close]);
    const reason = (proposal: Proposal, returns: Return[]) =>
      validate([proposal], { returns }, 'warn').rejected[0]?.reason;
    expect(reason({ ...close, resolved: true }, ['reply'])).toBeUndefined();
    expect(reason({ ...close, resolved: true }, [])).toBe('resolving the issue comments on it, which needs "reply"');
    expect(reason({ ...close, as: 'blocked', resolved: true }, ['reply'])).toBe(
      'only a "no-op" close resolves the issue'
    );
    const label: Proposal = { kind: 'label', add: ['approved'] };
    expect(validate([label], { returns: ['label'] }, 'warn').rejected[0]?.reason).toBe(
      'only a human adds the "approved" label'
    );
  });

  it('rejects branches outside bothub/ or other than the job branch', () => {
    const reason = (branch: string, branchOf?: string) =>
      validate([{ kind: 'push', branch }], { ...allowed, branch: branchOf }, 'warn').rejected[0]?.reason;
    expect(reason('main')).toBe('branch "main" must be a plain name under "bothub/"');
    expect(reason('bothub/../main')).toMatch(/must be a plain name/);
    expect(reason('bothub/a b')).toMatch(/must be a plain name/);
    expect(reason('bothub/7/fix')).toBeUndefined();
    expect(reason('bothub/7-a', 'bothub/7-a')).toBeUndefined();
    expect(reason('bothub/8-b', 'bothub/7-a')).toBe('branch "bothub/8-b" is not the job\'s branch "bothub/7-a"');
    const pr: Proposal = { kind: 'merge-request', title: 't', body: '', branch: 'feature' };
    expect(validate([pr], allowed, 'warn').rejected[0]?.reason).toMatch(/must be a plain name/);
  });

  it("accepts a merge request only into the job's into or the default branch", () => {
    const request = (into?: string): Proposal => ({
      kind: 'merge-request',
      title: 't',
      body: '',
      branch: 'bothub/5-6',
      ...(into && { into }),
    });
    const reason = (
      into: string | undefined,
      allowance: Partial<typeof allowed> & { into?: string; defaultBranch?: string }
    ) => validate([request(into)], { ...allowed, ...allowance }, 'warn').rejected[0]?.reason;
    expect(reason(undefined, {})).toBeUndefined();
    expect(reason('main', { defaultBranch: 'main' })).toBeUndefined();
    expect(reason('release', { defaultBranch: 'main' })).toBe(
      'merge request into "release", but this job\'s requests go into the default branch'
    );
    expect(reason('release', {})).toMatch(/go into the default branch/);
    expect(reason('bothub/5', { into: 'bothub/5', defaultBranch: 'main' })).toBeUndefined();
    expect(reason('main', { into: 'bothub/5', defaultBranch: 'main' })).toBeUndefined();
    expect(reason('bothub/9', { into: 'bothub/5', defaultBranch: 'main' })).toBe(
      'merge request into "bothub/9", but this job\'s requests go into the job\'s "bothub/5"'
    );
    expect(reason('bothub/5-6', { into: 'bothub/5-6' })).toBe('a branch cannot be merged into itself');
    expect(reason(undefined, { into: 'bothub/5-6' })).toBe('a branch cannot be merged into itself');
  });

  it('accepts a merge only from a job that returns it, once', () => {
    const merge: Proposal = { kind: 'merge', request: 3 };
    expect(validate([merge], allowed, 'warn').rejected[0]?.reason).toBe('"merge" is not allowed for this job');
    const { accepted, rejected } = validate([merge, merge], { returns: ['merge'] }, 'warn');
    expect(accepted).toEqual([merge]);
    expect(rejected[0]?.reason).toBe('more than 1 "merge" proposals');
  });

  it('takes hub file changes only inside the returned globs, and never to hub.yaml, bots or workflows', () => {
    const hub = (...paths: string[]): Proposal => ({
      kind: 'hub',
      title: 't',
      body: 'b',
      files: paths.map(path => ({ path, content: 'x' })),
    });
    const reason = (proposal: Proposal, returns: Return[] = ['hub(notes/**, skills/*.md)']) =>
      validate([proposal], { returns }, 'warn').rejected[0]?.reason;
    expect(reason(hub('notes/style/a.md', 'skills/b.md'))).toBeUndefined();
    expect(reason(hub('skills/x/b.md'))).toBe('path "skills/x/b.md" is outside hub(notes/**, skills/*.md)');
    expect(reason(hub('notes/a.md'), ['note'])).toBe('"hub" is not allowed for this job');
    for (const path of ['hub.yaml', 'bots/a.md', 'workflows/w.md'])
      expect(reason(hub(path), ['hub(**)'])).toBe(`path "${path}" changes only by a human`);
    expect(reason(hub('../repo/x'), ['hub(**)'])).toBe('path "../repo/x" leaves the hub');
    expect(
      validate([hub('notes/a.md'), hub('notes/b.md')], { returns: ['hub(notes/**)'] }, 'warn').rejected
    ).toHaveLength(1);
  });

  it('rejects malformed notes when extracting', () => {
    const { errors } = extractProposals(fence('{"kind":"note","note":"rumor","slug":"A b","title":"t","body":"b"}'));
    expect(errors).toHaveLength(1);
  });
});
