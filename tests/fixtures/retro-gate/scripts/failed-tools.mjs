import { readFileSync } from 'node:fs';

const limit = Number(process.argv[2] ?? 5);
const trace = readFileSync(process.env.AGENTGRAPH_RUN_TRACE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line));
if (trace.some(t => t.applied?.ok && t.applied.proposal.kind === 'run')) process.exit(0);
const failed = new Set(
  trace.flatMap((t, i) => (t.event?.type === 'tool' && t.event.ok === false ? [`${t.key}:${t.event.id || i}`] : []))
);
console.log(`${failed.size} failed tool calls, the limit is ${limit}`);
if (failed.size > limit) {
  const retro = { kind: 'run', workflow: 'retro', issue: Number(process.env.AGENTGRAPH_ISSUE) };
  console.log(`\`\`\`agentgraph\n${JSON.stringify([retro])}\n\`\`\``);
}
