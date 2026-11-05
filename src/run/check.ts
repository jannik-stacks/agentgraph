import { join, dirname } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { Effect, Stream, Result } from 'effect';
import { type Result as ResultValue, defaultReturns, findMismatch, defaultPass, readScriptResult } from '../result.ts';
import { type Checkout, type Exit, type Sandbox, SandboxError } from '../sandbox.ts';
import type { Graph, Check } from '../folder.ts';
import type { StoreError } from '../store.ts';
import { Store } from '../store.ts';
import { transcript, formatSqueezed } from '../context.ts';
import type { Proposal } from '../proposal.ts';
import type { Run, CheckResult, Step, Outcome } from '../workflow.ts';
import { pickUsed, type Trace, SessionStop } from '../trace.ts';
import { getSha } from '../hash.ts';
import type { Session } from '../session.ts';
import { getStepReturns } from '../graph.ts';
import type { Applied } from '../event.ts';
import { isRetro } from './hear.ts';
import { EachFailed, findFanOutItems, readCheckoutDiff, most } from './checkout.ts';
import { makeAgentSessionSpec, runShell, runJudge } from './execute.ts';

export const getTraceFiles = (work: Checkout) => ({
  AGENTGRAPH_TRACES: join(dirname(work.news), 'traces.md'),
  AGENTGRAPH_RUN_TRACE: join(dirname(work.news), 'trace.jsonl'),
});

/**
 * What checks read beside the news file, where they cannot write: the pending proposals, the issue as agents see it,
 * the reply, the traces of the runs on the issue and this run's raw trace.
 */
const getCheckFiles = (work: Checkout) => ({
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
const formatAnswers = (answers: Run['answers'] = []) =>
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
const passes = new WeakMap<object, Set<string>>();

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

/**
 * One check over what a try left: its items, the command per item, then the agent that judges. Each item gives a
 * result `returns` describes, from the judge when there is one, else from the script; it passes when it matches
 * `pass` and its script exited 0. With `each` the check carries the share of items that passed, else the result
 * itself when it has its own `returns`. The result and each item's go to the run's check record, each with what its
 * judging cost and the judge's transcript as its log.
 */
export const runOneCheck = (step: string, check: Graph['checks'][string], work: Left, graph: Graph, later?: true) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const passed = passes.get(store) ?? new Set<string>();
    passes.set(store, passed);
    const run = work.run;
    const returns = check.returns ?? defaultReturns;
    const info = check.mode === 'info';
    const started = Date.now();
    const minutes = graph.limits.minutes;
    const base = { ...makeScriptEnv(work, work.issue), ...getCheckFiles(work) };
    const all: Effect.Effect<(string | undefined)[], EachFailed | SandboxError, Sandbox> = check.each
      ? findFanOutItems(check.each, graph, work, minutes, base)
      : Effect.succeed([undefined]);
    const listed = yield* all.pipe(Effect.catchTag('EachFailed', e => Effect.succeed(e)));
    const items: (string | undefined)[] = listed instanceof EachFailed ? [] : listed;
    const diff = check.agent && !check.reads ? yield* readCheckoutDiff(work) : '';
    const settle = (
      item: string | undefined,
      value: ResultValue | undefined,
      exit?: number,
      output?: string,
      usd = 0
    ): Item => {
      const exited = exit === undefined ? {} : { exit };
      const unread = value === undefined ? 'its last line is no JSON object' : findMismatch(returns, value);
      if (unread || !value)
        return {
          item,
          pass: info,
          findings: `unreadable: ${unread}`,
          ...exited,
          unread: true,
          ...(output && { output }),
          usd,
        };
      const why = typeof value.why === 'string' ? value.why : '';
      const failed = info ? undefined : exit ? `exit ${exit}` : findMismatch(check.pass ?? defaultPass, value);
      const { why: _why, ...rest } = value;
      return {
        item,
        pass: !failed,
        ...(check.returns && { value: rest }),
        findings: check.pass && failed ? [failed, why].filter(Boolean).join('\n') : why || failed || '',
        ...exited,
        output: output ?? why,
        usd,
      };
    };
    const one = (item: string | undefined) =>
      Effect.gen(function* () {
        const env = {
          ...base,
          ...(item !== undefined && { AGENTGRAPH_ITEM: item }),
        };
        const out = check.run ? yield* runShell(check.run, graph, work.dir, env, minutes) : undefined;
        if (out?.code === 127) {
          const command = check.run?.match(/^[\t ]*([A-Za-z0-9_./][A-Za-z0-9_./-]*)(?:\s|$)/)?.[1];
          if (command && (yield* runShell(`command -v '${command}'`, graph, work.dir, env, minutes)).code !== 0)
            return yield* new SandboxError({
              reason: 'infra',
              detail: `${check.name}: command not found: ${formatSqueezed(out.output, 400)}`,
            });
        }
        if (!check.agent) {
          const output = out?.output ?? '';
          const value = check.returns ? readScriptResult(output) : { pass: (out?.code ?? 0) === 0, why: output };
          return { ...settle(item, value, out?.code, output), ...pickUsed(out) };
        }
        const agent = graph.agents[check.agent]!;
        const reads = agent.reads ?? check.reads;
        const prompt = [
          check.body,
          out?.output ?? item ?? formatSqueezed(diff, 200_000),
          formatAnswers(work.answers),
          reads && formatTracesPrompt(work),
          'Call the result tool once you have decided.',
        ]
          .filter(Boolean)
          .join('\n\n');
        const key = getSha(
          [run, check.name, check.agent, agent.model, agent.harness, agent.body, agent.tools, prompt, diff].join('\0')
        );
        if (!reads && !check.returns && passed.has(key)) return settle(item, { pass: true });
        const lines: Trace[] = [];
        const transcript = () => lines.map(line => JSON.stringify(line) + '\n').join('');
        const cost = () => lines.reduce((sum, line) => sum + ('session' in line ? line.session.usd : 0), 0);
        const judged = yield* runJudge(
          graph,
          lines,
          step,
          {
            ...makeAgentSessionSpec(graph, check.agent, work),
            check: check.name,
            returns,
            prompt,
            ...(reads && { read: [dirname(work.news)] }),
          },
          item
        ).pipe(
          Effect.catchTag('SessionStop', e =>
            (check.mode === 'warn' || info) && e.reason !== 'human' ? Effect.succeed(e) : Effect.fail(e)
          ),
          Effect.tapError(e =>
            Effect.flatMap(store.log(transcript(), false), log =>
              store.addChecks(run, {
                at: new Date().toISOString(),
                step,
                version: check.version,
                check: {
                  check: check.name,
                  pass: false,
                  empty: true,
                  findings: formatSqueezed(e instanceof SessionStop ? (e.detail ?? e.reason) : String(e)),
                  ms: 0,
                },
                usd: cost(),
                ...(item !== undefined && { item }),
                ...(log && { log }),
                ...(later && { later }),
              })
            )
          )
        );
        if (judged instanceof SessionStop)
          return {
            item,
            pass: info,
            findings: judged.detail ?? judged.reason,
            unread: true as const,
            output: transcript(),
            usd: cost(),
          };
        const { usd: _usd, ...value } = judged;
        const settled = settle(item, value, undefined, transcript(), cost());
        if (settled.pass && !check.returns) passed.add(key);
        return settled;
      });
    const max = check.max ?? most;
    const over = items.length > max;
    const results: Item[] =
      listed instanceof EachFailed
        ? [{ item: undefined, pass: info, findings: `each failed: ${listed.detail}`, unread: true, usd: 0 }]
        : over
          ? [
              {
                item: undefined,
                pass: info,
                findings: [
                  `${items.length} items, more than ${max}:`,
                  ...items.map(i => (i ?? '').split('\n')[0]),
                ].join('\n'),
                unread: true,
                usd: 0,
              },
            ]
          : yield* Effect.forEach(items, one, { concurrency: 'unbounded' });
    const usd = results.reduce((sum, r) => sum + r.usd, 0);
    const noted = results.filter(r => !r.pass || r.unread);
    const none = check.each !== undefined && items.length === 0 && !(listed instanceof EachFailed);
    const unread = results.some(r => r.unread);
    const share =
      check.each !== undefined && !info && !unread && items.length > 0
        ? results.filter(r => r.pass).length / results.length
        : undefined;
    const value = check.each === undefined ? results[0]?.value : undefined;
    const result: CheckResult = {
      check: check.name,
      pass: results.every(r => r.pass),
      ...(value && { value }),
      ...(share !== undefined && { share }),
      ...((none || unread) && { empty: true as const }),
      ...(none && { findings: 'Judged nothing: each found no items.' }),
      ...(noted.length > 0 && {
        findings: formatSqueezed(
          noted.map(r => (r.item ? `${r.item.split('\n')[0]}\n${r.findings}` : r.findings)).join('\n')
        ),
      }),
      ms: Date.now() - started,
    };
    const logs = yield* Effect.forEach(results, r =>
      r.output === undefined ? Effect.succeed(undefined) : store.log(r.output, r.pass)
    );
    const at = new Date().toISOString();
    const entry = { at, step, version: check.version, ...(later && { later }) };
    yield* store.addChecks(
      run,
      ...results
        .flatMap((r, i) => (r.item === undefined ? [] : [{ ...r, log: logs[i] }]))
        .map(r => ({
          ...entry,
          check: {
            check: check.name,
            pass: r.pass,
            ...(r.value && { value: r.value }),
            ...(r.unread && { empty: true as const }),
            ...((!r.pass || r.unread) && { findings: formatSqueezed(r.findings) }),
            ms: 0,
          },
          usd: r.usd,
          item: r.item!,
          ...(r.exit !== undefined && { exit: r.exit }),
          ...pickUsed(r),
          ...(r.log && { log: r.log }),
        })),
      {
        ...entry,
        check: result,
        usd: check.each ? 0 : usd,
        ...(!check.each && results[0]?.exit !== undefined && { exit: results[0].exit }),
        ...(!check.each && pickUsed(results[0])),
        ...(!check.each && logs[0] && { log: logs[0] }),
      }
    );
    return result;
  });

/**
 * The step's checks over what a try left behind, all at once, so every finding of a try comes back together.
 */
export const runStepChecks = (
  step: Step,
  left: Left,
  given: Graph
): Effect.Effect<{ outcome: Outcome }, SandboxError | SessionStop | StoreError, Sandbox | Session | Store> =>
  Effect.gen(function* () {
    const graph = step.limits ? { ...given, limits: { ...given.limits, ...step.limits } } : given;
    const checks = step.checks.map(name => ({ ...graph.checks[name]!, name }));
    yield* writeCheckFiles(graph, left, checks.length > 0);
    const settled = yield* Effect.forEach(checks, c => Effect.result(runOneCheck(step.name, c, left, graph)), {
      concurrency: 'unbounded',
    });
    const all = settled.flatMap(r => (Result.isSuccess(r) ? [r.success] : []));
    const failed = (mode: Check['mode']) =>
      all.filter(v => !v.pass && checks.find(c => c.name === v.check)?.mode === mode);

    const stops = failed('stop');
    if (stops.length > 0)
      return {
        outcome: {
          kind: 'stop',
          why: stops.map(v => `${v.check}: ${v.findings ?? 'failed'}`).join('\n'),
        },
      };
    const error = settled.find(Result.isFailure);
    if (error) return yield* error.failure;
    const returns = getStepReturns(step, graph.agents);
    const marks = new Set(Object.values(graph.workflows).flatMap(w => w.on.issues?.label ?? []));
    const refusal = (p: Proposal) =>
      !returns.some(k => k === p.kind)
        ? `${step.name} may not propose ${p.kind}`
        : p.kind === 'label' && p.add?.some(l => marks.has(l))
          ? `only a human adds ${p.add.filter(l => marks.has(l)).join(', ')}`
          : undefined;
    const proposals: Applied[] = left.proposals.flatMap(p => {
      const reason = refusal(p);
      return reason === undefined ? [] : [{ proposal: p, ok: false, reason }];
    });
    const blocking = failed('block');
    const outcome: Outcome =
      blocking.length > 0 || proposals.length > 0
        ? { kind: 'failed', checks: blocking, proposals, problems: [] }
        : { kind: 'pass' };
    return { outcome };
  });
