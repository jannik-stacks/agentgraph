// Checks the runs in a data dir against a few invariants and fails with one line per finding:
// - no tool call was denied,
// - every session that started was priced,
// - a done run of a named workflow applied its required proposal kind (`workflow=kind`, alternatives with `|`).
// It also prints how long each run waited before its first session, without failing on it.
// Usage: node bin/traces.mjs <data dir> [workflow=kind ...]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonl } from './resume.ts';

const [data, ...rules] = process.argv.slice(2);
if (!data) {
  console.error('usage: node bin/traces.mjs <data dir> [workflow=kind ...]');
  process.exit(2);
}
const required = Object.fromEntries(rules.map(rule => rule.split('=')).map(([w, kinds]) => [w, kinds.split('|')]));

const findings = [];
const waits = [];
let sessions = 0;
for (const id of readdirSync(data)) {
  const file = join(data, id, 'trace.jsonl');
  if (!existsSync(file)) continue;
  const trace = readJsonl(file);
  for (const { step, session, event } of trace) {
    if (event?.type === 'tool' && event.denied)
      findings.push(`${id} ${step}: denied ${event.name} ${JSON.stringify(event.input)}`);
    if (typeof session !== 'object' || !session.id) continue;
    sessions++;
    if (!session.usd) findings.push(`${id} ${step}: session ${session.id} ended ${session.ended} with usd 0`);
  }
  const first = trace.find(t => t.prompt);
  if (trace[0] && first) {
    const minutes = (Date.parse(first.at) - Date.parse(trace[0].at)) / 60_000;
    if (minutes >= 1) waits.push(`${id}: waited ${Math.round(minutes)} min before its first session`);
  }
  const run = existsSync(join(data, id, 'run.json'))
    ? JSON.parse(readFileSync(join(data, id, 'run.json'), 'utf8'))
    : {};
  const kinds = required[run.workflow];
  if (run.status === 'done' && kinds && !trace.some(t => t.applied?.ok && kinds.includes(t.applied.proposal?.kind)))
    findings.push(`${id}: done without ${kinds.join(' or ')}`);
}
if (waits.length) console.log(waits.join('\n'));
if (findings.length) console.log(findings.join('\n'));
console.log(`${findings.length} findings over ${sessions} sessions`);
process.exit(findings.length ? 1 : 0);
