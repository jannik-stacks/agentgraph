import { join, dirname } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { Effect, Stream } from 'effect';
import type { Result as ResultValue } from '../result.ts';
import type { Checkout, Exit } from '../sandbox.ts';
import type { Graph } from '../folder.ts';
import { Store } from '../store.ts';
import { isRetro } from './hear.ts';
import { transcript, formatSqueezed } from '../context.ts';
import type { Proposal } from '../proposal.ts';
import type { Run } from '../workflow.ts';

export const getTraceFiles = (work: Checkout) => ({
  AGENTGRAPH_TRACES: join(dirname(work.news), 'traces.md'),
  AGENTGRAPH_RUN_TRACE: join(dirname(work.news), 'trace.jsonl'),
});

/**
 * What checks read beside the news file, where they cannot write: the pending proposals, the issue as agents see it,
 * the reply, the traces of the runs on the issue and this run's raw trace.
 */
export const getCheckFiles = (work: Checkout) => ({
  AGENTGRAPH_PROPOSALS: join(dirname(work.news), 'proposals.json'),
  AGENTGRAPH_CONTEXT: join(dirname(work.news), 'context.md'),
  AGENTGRAPH_REPLY: join(dirname(work.news), 'reply.md'),
  ...getTraceFiles(work),
});

export const makeScriptEnv = (work: Pick<Checkout, 'base'>, issue: number | undefined) => ({
  AGENTGRAPH_BASE: work.base,
  ...(issue !== undefined && { AGENTGRAPH_ISSUE: String(issue) }),
});

/** Writes the traces of the runs on `issue` that are not retros, oldest first, and the raw trace of `run` beside the news file. */
export const writeTraces = (graph: Graph, issue: number, run: string, work: Checkout) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const runs = (yield* store.list({ issue }))
      .filter(r => !isRetro(graph, r))
      .toSorted((a, b) => a.started.localeCompare(b.started));
    const read = yield* Effect.forEach(runs, run =>
      Effect.zipWith(Stream.runCollect(store.read(run.id)), store.readChecks(run.id), (lines, checks) => ({
        run,
        lines,
        checks,
      }))
    );
    const own = yield* Stream.runCollect(store.read(run));
    const files = getTraceFiles(work);
    yield* Effect.promise(() =>
      Promise.all([
        writeFile(files.AGENTGRAPH_TRACES, transcript(issue, read)),
        writeFile(files.AGENTGRAPH_RUN_TRACE, own.map(line => JSON.stringify(line) + '\n').join('')),
      ])
    );
  });

/** The prompt line that points an agent that reads traces at them. */
export const formatTracesPrompt = (work: Checkout) =>
  `The traces of the runs on this issue are in \`${getTraceFiles(work).AGENTGRAPH_TRACES}\`, an absolute path outside the checkout: open it exactly as written. Per session they hold the prompt, thinking, tool calls and replies, then checks, proposals and moves. Read it in pages and grep it; cite entries by run and line.`;

/** What a try left for its checks: the checkout, the run and its issue, the issue as agents saw it, the reply, the proposals and the human answers so far. */
export type Left = Checkout & {
  run: string;
  issue?: number;
  context: string;
  reply: string;
  proposals: Proposal[];
  answers?: Run['answers'];
};

/** The human answers of a run as a section every check reads, so a judge does not raise again what an answer settled. */
export const formatAnswers = (answers: Run['answers'] = []) =>
  answers.length === 0
    ? ''
    : [
        '## What a human answered during this run',
        'A point an answer settles is not a finding.',
        ...answers.map(a =>
          a.asked ? `Asked: ${formatSqueezed(a.asked, 600)}\n\nAnswered: ${a.said}` : `Said: ${a.said}`
        ),
      ].join('\n\n');

export type Item = Pick<Exit, 'used'> & {
  item: string | undefined;
  pass: boolean;
  value?: ResultValue;
  findings: string;
  exit?: number;
  output?: string;
  unread?: true;
  usd: number;
};

/** The judge prompts that passed per data dir, run, check, judge and diff; the same judge, prompt and diff is not judged again. */
export const passes = new WeakMap<object, Set<string>>();

export const writeCheckFiles = (graph: Graph, left: Left, traces: boolean) =>
  Effect.gen(function* () {
    const files = getCheckFiles(left);
    yield* Effect.promise(() =>
      Promise.all([
        writeFile(files.AGENTGRAPH_PROPOSALS, JSON.stringify(left.proposals)),
        writeFile(files.AGENTGRAPH_CONTEXT, [left.context, formatAnswers(left.answers)].filter(Boolean).join('\n\n')),
        writeFile(files.AGENTGRAPH_REPLY, left.reply),
      ])
    );
    if (traces && left.issue !== undefined) yield* writeTraces(graph, left.issue, left.run, left);
  });
