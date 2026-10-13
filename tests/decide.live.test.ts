import { describe, expect, it } from 'vitest';
import { decideCheck } from '../src/decide.ts';
import { addedLines } from '../src/over.ts';

const diffOf = (file: string, added: string) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,0 +1,${added.split('\n').length} @@\n${added
    .split('\n')
    .map(line => `+${line}`)
    .join('\n')}\n`;

const change = (file: string, added: string) => addedLines(diffOf(file, added));

type Case = { question: string; label: string; state: string; good: boolean };

const commit = { question: 'Is the commit message exactly the single word "update" and nothing else?' };
const tsdoc = { question: 'Are the added code comments free of dates and of names of people?' };
const middot = { question: 'Is the added prose free of the middle dot character "·"?' };

const cases: Case[] = [
  { ...commit, label: 'commit "update"', state: 'update', good: true },
  { ...commit, label: 'commit "fix typo in README"', state: 'fix typo in README', good: false },
  { ...commit, label: 'commit "Update docs"', state: 'Update docs', good: false },
  {
    ...commit,
    label: 'commit "update" + trailer',
    state: 'update\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
    good: false,
  },
  {
    ...tsdoc,
    label: 'tsdoc plain',
    state: change(
      'src/encode.ts',
      '/** Encodes a Clarity value as hex. */\nexport const encode = (v: Value) => toHex(v);'
    ),
    good: true,
  },
  {
    ...tsdoc,
    label: 'tsdoc with name and date',
    state: change(
      'src/encode.ts',
      '/** Encodes a Clarity value as hex (Morgan 2026-09-22 ruling). */\nexport const encode = (v: Value) => toHex(v);'
    ),
    good: false,
  },
  {
    ...tsdoc,
    label: 'comment with date only',
    state: change(
      'src/encode.ts',
      '// renamed from toHex on 2026-09-20\nexport const encode = (v: Value) => toHex(v);'
    ),
    good: false,
  },
  {
    ...tsdoc,
    label: 'comment with name only',
    state: change(
      'src/encode.ts',
      '// as Alice asked, keep this lenient\nexport const parse = (s: string) => s.trim();'
    ),
    good: false,
  },
  {
    ...middot,
    label: 'prose with commas',
    state: change('docs/intro.mdx', 'Small, typed and fast. Works in Node and the browser.'),
    good: true,
  },
  {
    ...middot,
    label: 'prose with middle dots',
    state: change('docs/intro.mdx', 'Small · typed · fast. Works in Node · the browser.'),
    good: false,
  },
  {
    ...middot,
    label: 'prose with one middle dot',
    state: change('docs/intro.mdx', 'Read the guide first, then the API reference · it covers every export.'),
    good: false,
  },
];

const env = { BOTHUB_DECIDE_URL: process.env.BOTHUB_DECIDE_URL, BOTHUB_DECIDE_MODEL: process.env.BOTHUB_DECIDE_MODEL };

describe.skipIf(process.env.BOTHUB_LIVE !== '1')('decide against a live model', () => {
  it('answers realistic checks', { timeout: 300_000 }, async () => {
    const rows: string[] = [];
    let right = 0;
    for (const c of cases) {
      const verdict = await decideCheck(c.question, c.state, env);
      const probability = Number(/Probability of yes ([\d.]+)/.exec(verdict.findings ?? '')?.[1]);
      expect(probability, verdict.findings).toBeGreaterThanOrEqual(0);
      const ok = verdict.pass === c.good;
      if (ok) right++;
      rows.push(
        `${ok ? 'right' : 'WRONG'}  ${probability.toFixed(3)}  expected ${c.good ? 'pass' : 'fail'}  ${c.label}`
      );
    }
    console.log([...rows, `right ${right}/${cases.length}`].join('\n'));
  });
});
