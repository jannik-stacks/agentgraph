import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import { compile, effectiveCan } from '../src/config.ts';
import { claude } from '../src/executors/claude.ts';
import { readHub } from '../src/load.ts';
import { extractProposals, validate } from '../src/outputs.ts';
import { openStore, runId, type EventRecord } from '../src/store.ts';
import type { AgentEvent, BotEvent } from '../src/types.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { live: { type: 'boolean', default: false }, delay: { type: 'string', default: '600' } },
});
const root = join(import.meta.dirname, '..');
const dataDir = resolve(positionals[0] ?? process.env.BOTHUB_DATA ?? join(homedir(), '.bothub'));
const delay = Number(values.delay);

const compiled = compile(await readHub(join(root, 'examples', 'hub')));
if (!compiled.ok) throw new Error(compiled.errors.map(e => `${e.path}: ${e.message}`).join('\n'));
const workflow = compiled.config.workflows.issue;
const job = workflow?.jobs.implement;
const bot = job?.bot ? compiled.config.bots[job.bot] : undefined;
if (!workflow || !job || !bot) throw new Error('the example hub has no issue/implement job');

const message = [
  'Added `GET /health` returning `{ ok: true }` with a test, and opened a pull request.',
  '',
  '```bothub',
  JSON.stringify({ kind: 'reply', body: 'Added a /health endpoint with a test. See the linked pull request.' }),
  JSON.stringify({
    kind: 'push',
    branch: 'bothub/7-health-endpoint',
    files: ['src/health.ts', 'test/health.test.ts'],
  }),
  JSON.stringify({
    kind: 'open-pr',
    title: 'Add /health endpoint',
    body: 'Closes #7',
    head: 'bothub/7-health-endpoint',
  }),
  JSON.stringify({ kind: 'label', add: ['enhancement'] }),
  '```',
].join('\n');

const parsed = readFileSync(join(root, 'tests', 'fixtures', 'claude-stream.jsonl'), 'utf8')
  .split('\n')
  .flatMap(line => (line.trim() ? claude.parseLine(line) : []));
const events = parsed.flatMap<AgentEvent>(event =>
  event.type === 'end'
    ? [
        { type: 'text', text: message },
        { ...event, result: message },
      ]
    : [event]
);
const end = events.find((event): event is Extract<AgentEvent, { type: 'end' }> => event.type === 'end');

const started = new Date(Date.now() - (values.live ? 0 : 5 * 60_000));
const event: BotEvent = {
  id: 'seed',
  ts: started.toISOString(),
  source: 'github',
  trigger: 'issue_comment',
  action: 'created',
  repo: 'acme/app',
  number: 7,
  actor: { login: 'octocat', association: 'OWNER' },
  body: '/bothub add a /health endpoint with a test',
  url: 'https://github.com/acme/app/issues/7#issuecomment-1',
};

const store = openStore(dataDir);
const run = await store.create(
  { workflow: workflow.name, job: 'implement', bot: bot.name, harness: bot.harness, event },
  runId(started)
);
await store.update(run.id, { status: 'running', startedAt: started.toISOString() });

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
for (const [seq, agentEvent] of events.entries()) {
  if (values.live) await sleep(delay);
  const ts = new Date(values.live ? Date.now() : started.getTime() + seq * 4000).toISOString();
  await store.append(run.id, { ts, seq, event: agentEvent } satisfies EventRecord);
}

const { proposals, errors } = extractProposals(message);
const { accepted, rejected } = validate(
  proposals,
  { can: effectiveCan(bot, job), paths: job.paths, branch: 'bothub/7-health-endpoint' },
  job.mode
);
const urls: Partial<Record<string, string>> = {
  reply: 'https://github.com/acme/app/issues/7#issuecomment-2',
  'open-pr': 'https://github.com/acme/app/pull/8',
};
const results = accepted.map(({ kind }) => ({
  kind,
  status: 'applied' as const,
  ...(urls[kind] && { url: urls[kind] }),
}));
await store.saveOutcome(run.id, { proposals, errors, accepted, rejected, results, applied: true });

const endedAt = values.live ? new Date() : new Date(started.getTime() + events.length * 4000);
await store.update(run.id, {
  status: end?.ok ? 'succeeded' : 'failed',
  endedAt: endedAt.toISOString(),
  ...(end?.costUsd !== undefined && { costUsd: end.costUsd }),
  ...(end?.turns !== undefined && { turns: end.turns }),
});

console.log(`${styleText('green', 'seeded')} run ${run.id} (${events.length} events) in ${dataDir}`);
