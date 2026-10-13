import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { compile } from '../config.ts';
import { decide, defaultDecideModel, defaultDecideUrl } from '../decide.ts';
import { readHub } from '../load.ts';
import { accepted } from '../preload.ts';
import { allowedFor, index, loadSynonyms, noteDocs, recall, summaryDocs, type Doc, type Index } from '../recall.ts';
import type { EventRecord } from '../store.ts';
import {
  fit,
  history,
  items,
  loadSummaries,
  modelLine,
  Summarizer,
  type Endpoint,
  type Share,
  type SummaryRecord,
} from '../summaries.ts';
import type { AgentEvent } from '../types.ts';

/** What the surfacer plugin gets from bothub, as opencode plugin options. Paths are as seen by the harness. */
export type SurfacerOptions = {
  run: string;
  bot: string;
  data: string;
  hub: string;
  share?: Record<string, Share>;
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

/**
 * opencode server plugin: surfaces relevant past-run summaries and accepted hub notes before model turns, writes a
 * one-line summary of each assistant message and tool call, and offers a `history` tool when allowed.
 */
export const surfacer = async (_input: unknown, raw?: Record<string, unknown>) => {
  const o = raw as SurfacerOptions;
  const settings = Summarizer.parse(o.summarizer ?? 'extractive');
  const shareOf = (bot: string | undefined) => o.share?.[bot ?? ''] ?? 'bot';
  const url = o.decide?.url ?? (process.env.BOTHUB_DECIDE_URL || defaultDecideUrl);
  const model = o.decide?.model ?? (process.env.BOTHUB_DECIDE_MODEL || defaultDecideModel);
  const timeoutMs = o.decide?.timeoutMs ?? 20_000;
  const llm =
    o.llm ??
    (process.env.BOTHUB_LLM_BASE_URL
      ? {
          url: process.env.BOTHUB_LLM_BASE_URL,
          ...(process.env.BOTHUB_LLM_API_KEY && { apiKey: process.env.BOTHUB_LLM_API_KEY }),
        }
      : undefined);
  const file = o.summaries ?? join(process.env.HOME ?? '/tmp', '.bothub', 'summaries.jsonl');

  let corpus: Promise<Index> | undefined;
  const load = () =>
    (corpus ??= Promise.all([
      loadSummaries(o.data, shareOf),
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
      const hits = await recall({
        index: fresh,
        task,
        query,
        bot: o.bot,
        ...(o.cutoff !== undefined && { cutoff: o.cutoff }),
        ...(o.budget !== undefined && { budget: o.budget }),
        url,
        model,
        decide: request => decide({ ...request, timeoutMs }),
      });
      for (const { doc, p } of hits)
        if (p !== undefined && !s.shown.has(doc.id)) {
          s.shown.add(doc.id);
          s.lines.push(hitLine(doc));
        }
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
      modelLine(settings, llm, item.source).then(
        line => write({ ...record, line, by: settings.model! }),
        () => {}
      );
  };

  const h = history(o.data, o.bot, shareOf);
  const readHistory = async (query: string) => {
    const q = query.trim();
    if (!q) return JSON.stringify(await h.list(), null, 2);
    const pointer = /^(\S+)#(\d+)-(\d+)$/.exec(q);
    if (pointer && runId.test(pointer[1]!)) {
      const events = await h.read(pointer[1]!, { from: Number(pointer[2]), to: Number(pointer[3]) });
      return events ? JSON.stringify(events, null, 2) : `no run "${pointer[1]}" you may read`;
    }
    const own = runId.test(q) ? ((await h.read(q)) as SummaryRecord[] | undefined) : undefined;
    if (own) return own.map(r => `${r.run}#${r.from}-${r.to} ${r.line}`).join('\n') || `run "${q}" has no summaries`;
    const hits = (await load()).search(q, { limit: 10, keep: d => d.kind === 'summary' && allowedFor(o.bot)(d) });
    return hits.map(({ doc }) => `${doc.pointer} ${doc.text}`).join('\n') || 'nothing found';
  };

  return {
    'chat.message': async ({ sessionID }: { sessionID: string }, { parts }: { parts: Part[] }) => {
      const text = textOf(parts);
      if (text) surface(session(sessionID), text);
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
          execute: async ({ query }: { query?: string }) =>
            (await readHistory(String(query ?? ''))).slice(0, maxOutput),
        },
      },
    }),
    dispose: () => writes,
  };
};

export default { id: 'bothub-surfacer', server: surfacer };
