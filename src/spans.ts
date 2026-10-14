import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { timeKinds } from './schema.ts';
import type { EventRecord, Outcome, Run, Store } from './store.ts';

type TimeKind = (typeof timeKinds)[number];

/** Shell command patterns, tried in order after a hub's own (see `timeKind`). */
const defaultPatterns: [TimeKind, string][] = [
  ['wait', String.raw`^\s*sleep\b`],
  ['read', String.raw`^\s*(cat|head|tail|ls|find|grep|rg|wc|sed -n|git (diff|log|show|status|blame))\b`],
  ['test', String.raw`\b(test|tests|vitest|jest|pytest|mocha|nextest|playwright)\b`],
  ['build', String.raw`\b(build|compile|install|ci|tsc|make|cargo|gradle|mvn|wasm-pack)\b`],
];

/** Hub patterns by kind, as `hub.yaml`'s `time-kinds` gives them. */
type TimePatterns = Partial<Record<TimeKind, string[]>>;

const shells = /^(bash|shell|sh)$/i;
const edits = /edit|write|patch/i;
const reads = /read|grep|glob|list|search|fetch|history|notes_|issues_|runs_/i;

/** The kind of a tool call: edits and reads by tool name, shell commands by the hub's patterns, then the defaults. */
export const timeKind = (tool: string, input: unknown, hub: TimePatterns = {}): TimeKind => {
  if (!shells.test(tool)) return edits.test(tool) ? 'edit' : reads.test(tool) ? 'read' : 'other';
  const command = (input as { command?: unknown } | undefined)?.command;
  if (typeof command !== 'string') return 'other';
  const own = Object.entries(hub).flatMap(([kind, list]) => list.map(p => [kind as TimeKind, p] as const));
  return [...own, ...defaultPatterns].find(([, p]) => new RegExp(p).test(command))?.[0] ?? 'other';
};

type Value = string | number | boolean | string[];

/**
 * One span in OpenTelemetry's shape, metadata only: content stays in the run's `prompt.md` and `events.jsonl`. A run's
 * spans share the trace of its issue; `bothub.time.kind` says what a leaf span's time went to.
 */
export type Span = {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: 'run' | 'model_request' | 'tool_use' | 'check' | 'ask' | 'human_wait' | 'stall';
  start: string;
  end?: string;
  status: { code: 'ok' | 'error' | 'unset'; error_type?: string };
  attributes: Record<string, Value>;
};

const hex = (length: number, ...parts: string[]) =>
  createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, length);

const iso = (ms: number) => new Date(ms).toISOString();

const defined = (attributes: Record<string, Value | undefined>) =>
  Object.fromEntries(Object.entries(attributes).filter(([, v]) => v !== undefined)) as Record<string, Value>;

/**
 * The spans of one run: the run, each model request, tool use, check, stall, ask and human wait. A model request runs
 * from the end of the one before to its first tool call, or to its usage when it called none. A tool use without the
 * harness's own timing runs from its call to its result as seen; with neither, its `bothub.timing` says `unknown`.
 * `asked` is when the run an answer answers asked its human.
 */
export const runSpans = (
  run: Run,
  records: EventRecord[],
  outcome: Outcome | undefined,
  { patterns, asked = {} }: { patterns?: TimePatterns; asked?: Record<string, string> } = {}
): Span[] => {
  const trace_id = hex(32, run.event.repo, String(run.event.number ?? run.event.id));
  const own = hex(16, run.id, 'run');
  let n = 0;
  const span = (
    name: Span['name'],
    start: string,
    end: string | undefined,
    attributes: Record<string, Value | undefined>,
    status: Span['status'] = { code: 'ok' }
  ): Span => ({
    trace_id,
    span_id: hex(16, run.id, String(n++)),
    parent_span_id: own,
    name,
    start,
    ...(end && { end }),
    status,
    attributes: defined(attributes),
  });
  const failed = run.status !== 'succeeded' && run.status !== 'skipped' && run.status !== 'running';
  const spans: Span[] = [
    {
      trace_id,
      span_id: own,
      ...(run.parent && { parent_span_id: hex(16, run.parent, 'run') }),
      name: 'run',
      start: run.startedAt ?? run.event.ts,
      ...(run.endedAt && { end: run.endedAt }),
      status: failed
        ? { code: 'error', error_type: run.stopped ?? run.status }
        : { code: run.status === 'succeeded' ? 'ok' : 'unset' },
      attributes: defined({
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': run.bot,
        'gen_ai.request.model': run.model,
        'bothub.run.id': run.id,
        'bothub.run.parent': run.parent,
        'bothub.run.previous': run.previous,
        'bothub.workflow': run.workflow,
        'bothub.job': run.job,
        'bothub.check': run.check,
        'bothub.attempt': run.attempt,
        'bothub.repo': run.event.repo,
        'bothub.issue': run.event.number,
        'bothub.event': run.event.id,
        'bothub.harness': run.harness,
        'bothub.engine.commit': run.engine?.commit,
        'bothub.engine.dirty': run.engine?.dirty,
        'bothub.engine.src': run.engine?.src,
        'bothub.hub': run.hub,
        'bothub.base': run.base,
        'bothub.head': run.head,
        'bothub.closure': run.closure,
        'bothub.cost_usd': run.costUsd,
        'bothub.prompt.file': 'prompt.md',
        'bothub.events.file': 'events.jsonl',
      }),
    },
  ];
  const calls = new Map<string, { tool: string; input: unknown; start: number; seq: number }>();
  let step = Date.parse(run.startedAt ?? records[0]?.ts ?? run.event.ts);
  let firstTool: number | undefined;
  let model: string | undefined;
  for (const { ts, seq, event: e } of records) {
    const at = Date.parse(ts);
    if (e.type === 'start') model = e.model ?? model;
    if (e.type === 'tool_call') {
      const start = e.at ? Date.parse(e.at) : at;
      calls.set(e.id, { tool: e.tool, input: e.input, start, seq });
      if (start >= step) firstTool = Math.min(firstTool ?? start, start);
    }
    if (e.type === 'tool_result') {
      const call = calls.get(e.id);
      if (!call) continue;
      const end = e.ms !== undefined ? call.start + e.ms : at;
      const unknown = e.ms === undefined && run.harness === 'opencode';
      spans.push(
        span(
          'tool_use',
          iso(call.start),
          iso(end),
          {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': call.tool,
            'gen_ai.tool.call.id': e.id,
            'bothub.time.kind': timeKind(call.tool, call.input, patterns),
            'bothub.timing': unknown ? 'unknown' : e.ms !== undefined ? 'harness' : 'observed',
            'bothub.events.seq': `${call.seq}-${seq}`,
          },
          e.ok ? { code: 'ok' } : { code: 'error', error_type: 'tool_error' }
        )
      );
    }
    if (e.type === 'usage') {
      const ms = e.ms ?? 0;
      const own = !e.source;
      const start = own ? step : at - ms;
      const end = own ? (firstTool ?? at) : at;
      spans.push(
        span(
          'model_request',
          iso(start),
          iso(Math.max(start, end)),
          {
            'gen_ai.operation.name': 'chat',
            'gen_ai.request.model': run.model,
            'gen_ai.response.model': e.model ?? model,
            'gen_ai.usage.input_tokens': e.inputTokens,
            'gen_ai.usage.output_tokens': e.outputTokens,
            'gen_ai.usage.cache_read.input_tokens': e.cachedInputTokens,
            'gen_ai.usage.cache_write.input_tokens': e.cacheWriteTokens,
            'gen_ai.usage.reasoning.output_tokens': e.reasoningTokens,
            'gen_ai.response.finish_reasons': e.finish ? [e.finish] : undefined,
            'bothub.cost_usd': e.costUsd,
            'bothub.source': e.source,
            'bothub.time.kind': own ? 'model' : undefined,
            'bothub.events.seq': String(seq),
          },
          e.error ? { code: 'error', error_type: 'model_error' } : { code: 'ok' }
        )
      );
      if (own) {
        step = at;
        firstTool = undefined;
      }
    }
    if (e.type === 'human' && e.on === 'ask') spans.push(span('ask', ts, ts, { 'bothub.url': e.url }));
    if (e.type === 'human' && e.on === 'answer') {
      const answered = e.at ?? ts;
      spans.push(
        span('human_wait', (e.asked && asked[e.asked]) ?? answered, answered, {
          'bothub.time.kind': 'wait',
          'bothub.human.by': e.by,
          'bothub.run.asked': e.asked,
        })
      );
    }
  }
  for (const v of outcome?.checks ?? [])
    spans.push(
      span(
        'check',
        v.startedAt ?? run.endedAt ?? run.event.ts,
        v.endedAt,
        {
          'bothub.check': v.check,
          'bothub.check.gating': v.gating,
          'bothub.check.skipped': v.skipped,
          'bothub.check.runs': v.runs,
          'bothub.time.kind': v.runs?.length || v.skipped ? undefined : 'test',
        },
        v.pass ? { code: 'ok' } : { code: 'error', error_type: v.blocked ? 'blocked' : 'failed' }
      )
    );
  const last = records.at(-1)?.ts;
  if (run.stopped === 'stalled' && last && run.endedAt)
    spans.push(
      span('stall', last, run.endedAt, { 'bothub.time.kind': 'stall' }, { code: 'error', error_type: 'stalled' })
    );
  return spans;
};

/**
 * Writes a run's spans to `runs/<id>/spans.jsonl`, derived from what the store holds (see `runSpans`). Never
 * rejects: spans are a view of the run, not part of it.
 */
export const writeSpans = async (store: Store, id: string, patterns?: TimePatterns) => {
  try {
    const run = await store.read(id);
    if (!run) return;
    const records = await store.events(id);
    const asked: Record<string, string> = {};
    for (const { event: e } of records)
      if (e.type === 'human' && e.on === 'answer' && e.asked) {
        const ask = (await store.events(e.asked)).findLast(r => r.event.type === 'human' && r.event.on === 'ask');
        if (ask) asked[e.asked] = ask.ts;
      }
    const spans = runSpans(run, records, await store.outcome(id), { ...(patterns && { patterns }), asked });
    await writeFile(join(store.dir, 'runs', id, 'spans.jsonl'), spans.map(s => JSON.stringify(s)).join('\n') + '\n');
  } catch {}
};
