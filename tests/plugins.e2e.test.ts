import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { harnesses } from '../src/harnesses/index.ts';
import { runJob } from '../src/runner.ts';
import { containerEnv, sandboxConfig, sandboxNetwork } from '../src/sandbox.ts';
import { openStore } from '../src/store.ts';
import type { SummaryRecord } from '../src/summaries.ts';
import { commit, git, temp } from './kit.ts';

const up = async () => {
  if (process.env.BOTHUB_E2E !== '1') return false;
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
    return (await fetch('http://127.0.0.1:4000/health/liveliness', { signal: AbortSignal.timeout(5000) })).ok;
  } catch {
    return false;
  }
};

const key = () =>
  (parseEnv(readFileSync(new URL('../infra/local/.keys.env', import.meta.url), 'utf8')) as Record<string, string>)
    .BOTHUB_LLM_API_KEY_TRIAGER!;

/** Whether the decision model answers at the URL run containers are given. */
const tevInside = () => {
  try {
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--pull',
        'never',
        '--network',
        sandboxNetwork,
        '--entrypoint',
        'node',
        sandboxConfig().image,
        '-e',
        `fetch('${containerEnv().BOTHUB_DECIDE_URL}/api/tags').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))`,
      ],
      { stdio: 'ignore', timeout: 60_000 }
    );
    return true;
  } catch {
    return false;
  }
};

const past: SummaryRecord = {
  id: 'r-old:item:0',
  run: 'r-old',
  from: 0,
  to: 1,
  kind: 'tool',
  line: 'tool read filePath=src/rates.ts: ok, the rate constant is 4217 and is returned by rate() in src/rates.ts',
  by: 'extractive',
};

describe.skipIf(!(await up()))('bothub opencode plugins in the sandbox', () => {
  it('load in a real run: the surfacer writes and surfaces, the decider nudges', { timeout: 600_000 }, async () => {
    const work = temp('e2e-plugins-repo');
    git(work, 'init', '-q', '-b', 'main');
    commit(work, { 'README.md': 'Rates.\n' });
    const data = temp('e2e-plugins-data');
    mkdirSync(join(data, 'runs', 'r-old'), { recursive: true });
    writeFileSync(
      join(data, 'runs', 'r-old', 'run.json'),
      JSON.stringify({ id: 'r-old', bot: 'triager', workflow: 'w', job: 'j', status: 'succeeded' })
    );
    writeFileSync(join(data, 'runs', 'r-old', 'summaries.jsonl'), `${JSON.stringify(past)}\n`);
    const hub = temp('e2e-plugins-hub');
    const store = openStore(data);
    const run = await store.create({
      workflow: 'w',
      job: 'j',
      bot: 'triager',
      harness: 'opencode',
      event: {
        id: 'e',
        ts: new Date().toISOString(),
        source: 'cli',
        trigger: 'issue_comment',
        repo: 'acme/rates',
        actor: { login: 'morgan', association: 'OWNER' },
      },
      status: 'queued',
    });
    const done = await Effect.runPromise(
      runJob({
        adapter: harnesses.opencode,
        spec: {
          prompt:
            'What number does rate() in src/rates.ts return? The file is not in this checkout; use only what you were given. Reply with the number alone, or UNKNOWN.',
          system: 'You answer in one line.',
          cwd: work,
          model: 'smart',
          tools: ['read'],
          maxTurns: 3,
          surfacer: { run: run.id, bot: 'triager', data, hub, cutoff: 0.3 },
          decider: {
            questions: [
              { on: 'stop', ask: 'Is this message written in French?', say: 'decider-loaded', unreachable: 'act' },
            ],
          },
        },
        timeoutMinutes: 8,
        store,
        runId: run.id,
        secrets: { BOTHUB_LLM_API_KEY: key() },
      })
    );
    const events = (await store.events(run.id)).map(r => r.event);
    const texts = events.flatMap(e => (e.type === 'text' ? [e.text] : []));
    const recall = events.find(e => e.type === 'recall');
    expect(recall).toMatchObject({ on: 'turn' });
    if (tevInside() && recall?.type === 'recall')
      expect(recall.items).toContainEqual(expect.objectContaining({ pointer: 'r-old#0-1', fate: 'surfaced' }));
    expect(done.status, done.error).toBe('succeeded');
    expect(texts.join('\n')).toContain('[bothub] decider-loaded');
    if (tevInside()) expect(texts.join('\n')).toContain('4217');
    const live = readFileSync(join(store.home(run.id), '.bothub', 'summaries.jsonl'), 'utf8');
    expect(live).toContain(`"id":"${run.id}:live:0"`);
  });
});
