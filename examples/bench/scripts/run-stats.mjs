import { readFileSync } from 'node:fs';

const lines = readFileSync(process.env.AGENTGRAPH_RUN_TRACE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line));
const events = lines.flatMap(line => (line.event ? [line.event] : []));
const usage = events.filter(e => e.type === 'usage');
const sum = key => usage.reduce((total, e) => total + (e[key] ?? 0), 0);
const times = lines
  .filter(line => line.event || line.outcome)
  .map(line => Date.parse(line.at))
  .filter(Number.isFinite);

console.log(
  JSON.stringify({
    usd: Math.round(sum('usd') * 10_000) / 10_000,
    tools: events.filter(e => e.type === 'tool').length,
    steps: lines.filter(line => line.outcome).length,
    minutes: times.length ? Math.round((Math.max(...times) - Math.min(...times)) / 600) / 100 : 0,
    tokens: sum('input') + sum('output') + sum('cacheRead') + sum('cacheWrite'),
  })
);
