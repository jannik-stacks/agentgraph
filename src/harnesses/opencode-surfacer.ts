import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { compile } from '../config.ts';
import { decide, defaultDecideModel, defaultDecideUrl } from '../decide.ts';
import { readHub } from '../load.ts';
import { accepted } from '../preload.ts';
import { allowedFor, index, loadSynonyms, noteDocs, summaryDocs, weigh, type Doc, type Index } from '../recall.ts';
import type { EventRecord } from '../store.ts';
import {
  askerOf,
  endpointOf,
  fit,
  history,
  items,
  loadSummaries,
  modelLine,
  Summarizer,
  type Endpoint,
  type History,
  type SummaryRecord,
} from '../summaries.ts';
import type { AgentEvent } from '../types.ts';
import { tokensOf } from '../usage.ts';

/** The file a bothub plugin writes in the run home when opencode loads it; a run whose plugin left none fails. */
export const loadedMarker = (home: string, id: string) => join(home, '.bothub', 'loaded', id);

/** Marks plugin `id` as loaded in the run home. */
export const markLoaded = async (id: string) => {
  const file = loadedMarker(process.env.HOME ?? '/tmp', id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${process.pid}\n`);
};

/** Reports a plugin event to bothub as a line on opencode's stdout, where the harness adapter reads it. */
export const report = (event: AgentEvent) => {
  try {
    process.stdout.write(`${JSON.stringify({ type: 'bothub', event })}\n`);
  } catch {}
};

/**
 * What the surfacer plugin gets from bothub, as opencode plugin options. Paths are as seen by the harness. `surface`
 * false keeps recall off and serves only `history`.
 */
export type SurfacerOptions = {
  surface?: boolean;
  run: string;
  bot: string;
  data: string;
  hub: string;
  scope?: History;
  summarizer?: string | Partial<Summarizer>;
  history?: boolean;
  cutoff?: number;
  budget?: number;
  summaries?: string;
  decide?: { url?: string; model?: string; timeoutMs?: number };
  llm?: Endpoint;
};

type Part = { type: string; text?: string; synthetic?: boolean };
type Session = { task?: string; shown: Set<string>; lines: string[]; pending?: Promise<void> };

const runId = /^[A-Za-z0-9_][\w.-]*$/;
const maxOutput = 16_000;

const textOf = (parts: Part[]) =>
  parts
    .filter(p => p.type === 'text' && !p.synthetic && p.text?.trim())
    .map(p => p.text)
    .join('\n');

const hitLine = (doc: Doc) => `- [${doc.pointer}] ${doc.kind === 'note' ? `${doc.title}: ` : ''}${fit(doc.text, 400)}`;
const maxQuery = 300;
const round = (n: number) => Math.round(n * 1000) / 1000;
type RecallItem = Extract<AgentEvent, { type: 'recall' }>['items'][number];
const itemOf = (doc: Doc): Omit<RecallItem, 'fate'> => ({ pointer: doc.pointer, title: doc.title, kind: doc.kind });

/**
 * opencode server plugin: surfaces relevant past-run summaries and accepted hub notes before model turns, writes a
 * one-line summary of each assistant message and tool call, and offers a `history` tool when allowed. Every lookup is
 * reported as a `recall` event with each candidate's scores and fate, and every model call as a `usage` event.
 */
export const surfacer = async (_input: unknown, raw?: Record<string, unknown>) => {
  const o = raw as SurfacerOptions;
  await markLoaded(surfacerId);
  const settings = Summarizer.parse(o.summarizer ?? 'extractive');
  let asker: ReturnType<typeof askerOf> | undefined;
  const asking = () => (asker ??= askerOf(o.data, o.run, o.bot, o.scope ?? 'bot'));
  const url = o.decide?.url ?? (process.env.BOTHUB_DECIDE_URL || defaultDecideUrl);
  const model = o.decide?.model ?? (process.env.BOTHUB_DECIDE_MODEL || defaultDecideModel);
  const timeoutMs = o.decide?.timeoutMs ?? 20_000;
  const llm = o.llm ?? endpointOf(process.env);
  const file = o.summaries ?? join(process.env.HOME ?? '/tmp', '.bothub', 'summaries.jsonl');

  let corpus: Promise<Index> | undefined;
  const load = () =>
    (corpus ??= Promise.all([
      loadSummaries(o.data),
      loadSynonyms(join(o.hub, 'synonyms.yaml')),
      readHub(o.hub).then(compile),
    ]).then(([records, words, hub]) =>
      index(
        [
          ...summaryDocs(records.filter(r => r.run !== o.run)),
          ...(hub.ok ? noteDocs(hub.config.notes.filter(accepted)) : []),
        ],
        words
      )
    ));

  const sessions = new Map<string, Session>();
  const session = (id: string) => {
    if (!sessions.has(id)) sessions.set(id, { shown: new Set(), lines: [] });
    return sessions.get(id)!;
  };

  const surface = (s: Session, query: string) => {
    s.task ??= query;
    const task = s.task;
    s.pending = (async () => {
      const all = await load();
      const fresh: Index = {
        ...all,
        search: (q, opts) => all.search(q, { ...opts, keep: d => !s.shown.has(d.id) && (opts?.keep?.(d) ?? true) }),
      };
      const { weighed, error } = await weigh({
        index: fresh,
        task,
        query,
        asker: await asking(),
        ...(o.cutoff !== undefined && { cutoff: o.cutoff }),
        ...(o.budget !== undefined && { budget: o.budget }),
        url,
        model,
        decide: request =>
          decide({ ...request, llm, timeoutMs, onUsage: usage => report({ ...usage, source: 'recall' }) }),
      });
      const items: RecallItem[] = weighed.map(({ doc, score, p, fate }) => {
        const line = hitLine(doc);
        const surfaced = fate === 'kept' && p !== undefined && !s.shown.has(doc.id);
        if (surfaced) {
          s.shown.add(doc.id);
          s.lines.push(line);
        }
        return {
          ...itemOf(doc),
          score: round(score),
          ...(p !== undefined && { p }),
          tokens: tokensOf(line.length + 1),
          fate: surfaced ? 'surfaced' : fate === 'kept' ? 'unjudged' : fate,
        };
      });
      report({
        type: 'recall',
        on: 'turn',
        query: fit(query, maxQuery),
        tokens: items.reduce((n, i) => n + (i.fate === 'surfaced' ? (i.tokens ?? 0) : 0), 0),
        items,
        ...(error !== undefined && { error }),
      });
    })().catch(() => {});
  };

  let seq = 0;
  let writes = Promise.resolve();
  const write = (record: SummaryRecord) => {
    writes = writes
      .then(() => mkdir(dirname(file), { recursive: true }))
      .then(() => appendFile(file, `${JSON.stringify(record)}\n`))
      .catch(() => {});
  };
  const summarize = (events: AgentEvent[]) => {
    if (settings.mode === 'off') return;
    const records: EventRecord[] = events.map(event => ({ ts: new Date().toISOString(), seq: seq++, event }));
    const [item] = items(records);
    if (!item) return;
    const record: SummaryRecord = {
      id: `${o.run}:live:${item.from}`,
      run: o.run,
      from: item.from,
      to: item.to,
      kind: item.kind,
      line: fit(item.line, settings['max-bytes']),
      by: 'extractive',
    };
    write(record);
    if (settings.mode === 'model' && llm)
      modelLine(settings, llm, item.source, usage => report({ ...usage, source: 'summarizer' })).then(
        line => write({ ...record, line, by: settings.model! }),
        () => {}
      );
  };

  const readHistory = async (query: string): Promise<{ text: string; items: RecallItem[] }> => {
    const q = query.trim();
    const h = history(o.data, await asking());
    if (!q) {
      const runs = await h.list();
      return {
        text: JSON.stringify(runs, null, 2),
        items: runs.map(r => ({ pointer: r.id, title: `${r.workflow}/${r.job}`, kind: 'run', fate: 'returned' })),
      };
    }
    const pointer = /^(\S+)#(\d+)-(\d+)$/.exec(q);
    if (pointer && runId.test(pointer[1]!)) {
      const events = await h.read(pointer[1]!, { from: Number(pointer[2]), to: Number(pointer[3]) });
      return events
        ? { text: JSON.stringify(events, null, 2), items: [{ pointer: q, kind: 'run', fate: 'returned' }] }
        : { text: `no run "${pointer[1]}" you may read`, items: [] };
    }
    const own = runId.test(q) ? ((await h.read(q)) as SummaryRecord[] | undefined) : undefined;
    if (own)
      return {
        text: own.map(r => `${r.run}#${r.from}-${r.to} ${r.line}`).join('\n') || `run "${q}" has no summaries`,
        items: own.map(r => ({ pointer: `${r.run}#${r.from}-${r.to}`, kind: 'summary', fate: 'returned' })),
      };
    const allowed = allowedFor(await asking());
    const hits = (await load()).search(q, { limit: 10, keep: d => d.kind === 'summary' && allowed(d) });
    return {
      text: hits.map(({ doc }) => `${doc.pointer} ${doc.text}`).join('\n') || 'nothing found',
      items: hits.map(({ doc, score }) => ({ ...itemOf(doc), score: round(score), fate: 'returned' })),
    };
  };

  return {
    'chat.message': async ({ sessionID }: { sessionID: string }, { parts }: { parts: Part[] }) => {
      const text = textOf(parts);
      if (text && o.surface !== false) surface(session(sessionID), text);
    },
    'experimental.chat.system.transform': async (
      { sessionID }: { sessionID?: string },
      { system }: { system: string[] }
    ) => {
      const s = sessionID ? sessions.get(sessionID) : undefined;
      await s?.pending;
      if (s?.lines.length)
        system.push(
          `Possibly relevant, from earlier runs and hub notes. Check before relying on it.\n${s.lines.join('\n')}`
        );
    },
    'experimental.text.complete': async (_: unknown, { text }: { text: string }) => {
      if (text.trim()) summarize([{ type: 'text', text }]);
    },
    'tool.execute.after': async (
      { tool, callID, args }: { tool: string; callID: string; args: unknown },
      { output }: { output: string }
    ) => {
      summarize([
        { type: 'tool_call', id: callID, tool, input: args },
        { type: 'tool_result', id: callID, ok: true, output },
      ]);
    },
    ...(o.history && {
      tool: {
        history: {
          description:
            'Search and read earlier runs you may see. Pass words to search their summaries, a run id to read its summaries, a pointer like <run>#<from>-<to> to read those original events, or nothing to list recent runs.',
          args: { query: { type: 'string', description: 'Words, a run id, a <run>#<from>-<to> pointer, or empty' } },
          execute: async ({ query }: { query?: string }) => {
            const q = String(query ?? '');
            const { text, items } = await readHistory(q);
            const out = text.slice(0, maxOutput);
            report({ type: 'recall', on: 'history', query: fit(q, maxQuery), tokens: tokensOf(out.length), items });
            return out;
          },
        },
      },
    }),
    dispose: () => writes,
  };
};

const surfacerId = 'bothub-surfacer';

export default { id: surfacerId, server: surfacer };
