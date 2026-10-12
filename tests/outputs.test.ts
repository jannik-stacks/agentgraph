import { describe, expect, it } from 'vitest';
import { extractProposals, matchGlob, Proposal, validate } from '../src/outputs.ts';
import { Job, SafeOutputKind } from '../src/schema.ts';

const fence = (body: string, info = 'bothub') => `\`\`\`${info}\n${body}\n\`\`\``;
const outputs = (raw: unknown) => Job.parse({ 'safe-outputs': raw })['safe-outputs'];

describe('Proposal', () => {
  it('covers every safe output kind', () => {
    expect(Proposal.options.map(o => o.shape.kind.value).sort()).toEqual([...SafeOutputKind.options].sort());
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
      fence('{"kind":"ask-human","question":"which db?"}\n\n{"kind":"reply","body":"final"}'),
    ].join('\n');
    expect(extractProposals(text).proposals).toEqual([
      { kind: 'ask-human', question: 'which db?' },
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
  const allowed = outputs({ reply: { max: 2 }, 'push-branch': { paths: ['src/**', 'README.md'] }, 'open-pr': {} });

  it('accepts allowed proposals and applies outside shadow mode', () => {
    const proposals: Proposal[] = [
      { kind: 'reply', body: 'a' },
      { kind: 'push-branch', branch: 'bothub/7-fix', files: ['src/a.ts', 'README.md'] },
      { kind: 'open-pr', title: 't', body: 'b', head: 'bothub/7-fix' },
    ];
    expect(validate(proposals, allowed, 'warn')).toEqual({ accepted: proposals, rejected: [], apply: true });
    expect(validate(proposals, allowed, 'shadow')).toEqual({ accepted: proposals, rejected: [], apply: false });
  });

  it('rejects kinds the job does not allow', () => {
    const proposal: Proposal = { kind: 'label', add: ['x'] };
    expect(validate([proposal], allowed, 'block').rejected).toEqual([
      { proposal, reason: '"label" is not allowed for this job' },
    ]);
    expect(validate([proposal], outputs({}), 'block').accepted).toEqual([]);
  });

  it('rejects proposals over max per kind', () => {
    const replies: Proposal[] = ['a', 'b', 'c'].map(body => ({ kind: 'reply', body }));
    const { accepted, rejected } = validate(replies, allowed, 'warn');
    expect(accepted).toHaveLength(2);
    expect(rejected).toEqual([{ proposal: replies[2], reason: 'more than 2 "reply" proposals' }]);
    expect(validate([replies[0]!, replies[1]!], outputs({ reply: {} }), 'warn').accepted).toHaveLength(1);
  });

  it('rejects files outside paths or the repository', () => {
    const push = (files: string[]): Proposal => ({ kind: 'push-branch', branch: 'bothub/x', files });
    const reason = (files: string[]) => validate([push(files)], allowed, 'warn').rejected[0]?.reason;
    expect(reason(['src/a.ts', 'package.json'])).toBe('path "package.json" is outside the allowed paths');
    expect(reason(['src/../package.json'])).toBe('path "src/../package.json" escapes the repository');
    expect(reason(['/etc/passwd'])).toBe('path "/etc/passwd" escapes the repository');
    const rule: Proposal = { kind: 'propose-rule', path: 'rules/x.md', content: '' };
    expect(validate([rule], outputs({ 'propose-rule': { paths: ['rules/*.md'] } }), 'warn').accepted).toEqual([rule]);
  });

  it('rejects branches outside bothub/', () => {
    const reason = (branch: string) => validate([{ kind: 'push-branch', branch }], allowed, 'warn').rejected[0]?.reason;
    expect(reason('main')).toBe('branch "main" must be a plain name under "bothub/"');
    expect(reason('bothub/../main')).toMatch(/must be a plain name/);
    expect(reason('bothub/a b')).toMatch(/must be a plain name/);
    expect(reason('bothub/7/fix')).toBeUndefined();
    const pr: Proposal = { kind: 'open-pr', title: 't', body: '', head: 'feature' };
    expect(validate([pr], allowed, 'warn').rejected[0]?.reason).toMatch(/must be a plain name/);
  });
});
