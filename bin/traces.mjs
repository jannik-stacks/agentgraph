import { readdirSync } from 'node:fs';
import { readRunSync, readTraceSync } from '../src/store.ts';

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
  let run, trace;
  try {
    run = readRunSync(data, id);
    trace = readTraceSync(data, id);
  } catch (e) {
    findings.push(String(e.message));
    continue;
  }
  if (!trace.length) {
    if (run) findings.push(`${id}: trace.jsonl missing`);
    continue;
  }
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
  if (!run) findings.push(`${id}: run.json missing`);
  const kinds = run && required[run.workflow];
  if (run?.status === 'done' && kinds && !trace.some(t => t.applied?.ok && kinds.includes(t.applied.proposal?.kind)))
    findings.push(`${id}: done without ${kinds.join(' or ')}`);
}
if (waits.length) console.log(waits.join('\n'));
if (findings.length) console.log(findings.join('\n'));
console.log(`${findings.length} findings over ${sessions} sessions`);
process.exit(findings.length ? 1 : 0);
