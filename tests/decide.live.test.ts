import { describe, expect, it } from 'vitest';
import { decideCheck, type DecideInputs } from '../src/decide.ts';
import type { BotEvent } from '../src/types.ts';

const event = (body: string): BotEvent => ({
  id: 'live',
  ts: '2026-10-12T00:00:00.000Z',
  source: 'local',
  trigger: 'push',
  repo: 'acme/app',
  actor: { login: 'bot', association: 'MEMBER' },
  body,
});

const diffOf = (file: string, added: string) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,0 +1,${added.split('\n').length} @@\n${added
    .split('\n')
    .map(line => `+${line}`)
    .join('\n')}\n`;

const change = (file: string, added: string): DecideInputs => ({ files: [file], diff: diffOf(file, added) });

type Decide = Parameters<typeof decideCheck>[0]['decide'];
type Rule = { phrasings: Decide[] };
type Case = Rule & { label: string; inputs: DecideInputs; good: boolean };

const commit: Rule = {
  phrasings: [
    { question: 'Is the commit message exactly the single word "update" and nothing else?', over: 'event' },
    { question: 'Does the message contain anything besides the single word "update"?', over: 'event', 'pass-on': 'no' },
  ],
};
const tsdoc: Rule = {
  phrasings: [
    { question: 'Are the added code comments free of dates and of names of people?' },
    { question: "Does an added comment contain a date or a person's name?", 'pass-on': 'no' },
  ],
};
const middot: Rule = {
  phrasings: [
    { question: 'Is the added prose free of the middle dot character "·"?' },
    { question: 'Does the added text contain the character "·"?', 'pass-on': 'no' },
  ],
};

const cases: Case[] = [
  { ...commit, label: 'commit "update"', inputs: { files: [], diff: '', event: event('update') }, good: true },
  {
    ...commit,
    label: 'commit "fix typo in README"',
    inputs: { files: [], diff: '', event: event('fix typo in README') },
    good: false,
  },
  {
    ...commit,
    label: 'commit "Update docs"',
    inputs: { files: [], diff: '', event: event('Update docs') },
    good: false,
  },
  {
    ...commit,
    label: 'commit "update" + trailer',
    inputs: { files: [], diff: '', event: event('update\n\nCo-Authored-By: Claude <noreply@anthropic.com>') },
    good: false,
  },
  {
    ...tsdoc,
    label: 'tsdoc plain',
    inputs: change(
      'src/encode.ts',
      '/** Encodes a Clarity value as hex. */\nexport const encode = (v: Value) => toHex(v);'
    ),
    good: true,
  },
  {
    ...tsdoc,
    label: 'tsdoc with name and date',
    inputs: change(
      'src/encode.ts',
      '/** Encodes a Clarity value as hex (Morgan 2026-09-22 ruling). */\nexport const encode = (v: Value) => toHex(v);'
    ),
    good: false,
  },
  {
    ...tsdoc,
    label: 'comment with date only',
    inputs: change(
      'src/encode.ts',
      '// renamed from toHex on 2026-09-20\nexport const encode = (v: Value) => toHex(v);'
    ),
    good: false,
  },
  {
    ...tsdoc,
    label: 'comment with name only',
    inputs: change(
      'src/encode.ts',
      '// as Alice asked, keep this lenient\nexport const parse = (s: string) => s.trim();'
    ),
    good: false,
  },
  {
    ...middot,
    label: 'prose with commas',
    inputs: change('docs/intro.mdx', 'Small, typed and fast. Works in Node and the browser.'),
    good: true,
  },
  {
    ...middot,
    label: 'prose with middle dots',
    inputs: change('docs/intro.mdx', 'Small · typed · fast. Works in Node · the browser.'),
    good: false,
  },
  {
    ...middot,
    label: 'prose with one middle dot',
    inputs: change('docs/intro.mdx', 'Read the guide first, then the API reference · it covers every export.'),
    good: false,
  },
];

const env = { BOTHUB_DECIDE_URL: process.env.BOTHUB_DECIDE_URL, BOTHUB_DECIDE_MODEL: process.env.BOTHUB_DECIDE_MODEL };

describe.skipIf(process.env.BOTHUB_LIVE !== '1')('decide against a live model', () => {
  it('answers realistic checks', { timeout: 300_000 }, async () => {
    const rows: string[] = [];
    const right = [0, 0];
    for (const c of cases)
      for (const [i, decide] of c.phrasings.entries()) {
        const verdict = await decideCheck({ name: c.label, mode: 'block', decide }, c.inputs, env);
        const probability = Number(/Probability of \w+ ([\d.]+)/.exec(verdict.findings ?? '')?.[1]);
        expect(probability, verdict.findings).toBeGreaterThanOrEqual(0);
        const ok = verdict.pass === c.good;
        if (ok) right[i]!++;
        const answer = `${decide['pass-on'] ?? 'yes'} ${probability.toFixed(3)}`;
        rows.push(`${ok ? 'right' : 'WRONG'}  ${answer}  expected ${c.good ? 'pass' : 'fail'}  ${c.label}`);
      }
    console.log(
      [
        ...rows,
        `rule-follows (pass on yes) ${right[0]}/${cases.length}, violation (pass on no) ${right[1]}/${cases.length}`,
      ].join('\n')
    );
  });
});
