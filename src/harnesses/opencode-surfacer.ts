import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { compile } from '../config.ts';
import { defaultDecideUrl } from '../decide.ts';
import { readHub } from '../load.ts';
import { accepted } from '../preload.ts';
import { index, judgeWith, lineOf, loadSynonyms, noteDocs, summaryDocs, weigh, type Doc } from '../recall.ts';
import type { Preload } from '../schema.ts';
import {
  askerOf,
  endpointOf,
  fit,
  history,
  loadSummaries,
  visible,
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
 * What the surfacer plugin gets from bothub, as opencode plugin options. Paths are as seen by the harness. `recall`
 * turns recall on with the text it searches with; without it the plugin serves only `history`.
 */
export type SurfacerOptions = {
  run: string;
  bot: string;
  data: string;
  hub: string;
  scope?: History;
  history?: boolean;
  recall?: Extract<Preload, { recall: unknown }>['recall'] & { query: string };
  llm?: Endpoint;
};

const runId = /^[A-Za-z0-9_][\w.-]*$/;
const maxOutput = 16_000;
const maxQuery = 300;
const judgeTimeoutMs = 10_000;
const round = (n: number) => Math.round(n * 1000) / 1000;
type RecallItem = Extract<AgentEvent, { type: 'recall' }>['items'][number];
const itemOf = (doc: Doc): Omit<RecallItem, 'fate'> => ({ pointer: doc.pointer, title: doc.title, kind: doc.kind });

/**
 * opencode server plugin: before the first model turn, surfaces the accepted hub notes and earlier-run summaries most
 * relevant to the run's task, and offers a `history` tool when allowed. Every lookup is reported as a `recall` event
 * with each candidate's scores and fate, or the error that stopped it, and every judge call as a `usage` event.
 */
export const surfacer = async (_input: unknown, raw?: Record<string, unknown>) => {
  const o = raw as SurfacerOptions;
  await markLoaded(surfacerId);
  const asker = askerOf(o.data, o.run, o.bot, o.scope ?? 'issue');
  const llm = o.llm ?? endpointOf(process.env);

  const corpus = (async () => {
    const seer = await asker;
    const [records, words, hub] = await Promise.all([
      seer.history === 'none' ? [] : loadSummaries(o.data, origin => visible(seer, origin)),
      loadSynonyms(join(o.hub, 'synonyms.yaml')),
      readHub(o.hub).then(compile),
    ]);
    if (!hub.ok) throw new Error(`the hub does not load: ${hub.errors.map(e => `${e.path}: ${e.message}`).join('; ')}`);
    return index(
      [...summaryDocs(records.filter(r => r.run !== o.run)), ...noteDocs(hub.config.notes.filter(accepted))],
      words
    );
  })();
  corpus.catch(() => {});

  const surface = async ({ query, judge, ...settings }: NonNullable<SurfacerOptions['recall']>) => {
    try {
      const { weighed, error } = await weigh({
        index: await corpus,
        query,
        asker: await asker,
        ...settings,
        ...(judge && {
          judge: judgeWith(judge, {
            url: process.env.BOTHUB_DECIDE_URL || defaultDecideUrl,
            llm,
            timeoutMs: judgeTimeoutMs,
            onUsage: usage => report({ ...usage, source: 'recall' }),
          }),
        }),
      });
      const kept = weighed.filter(w => w.fate === 'kept').map(w => lineOf(w.doc));
      report({
        type: 'recall',
        on: 'turn',
        query: fit(query, maxQuery),
        tokens: kept.reduce((n, line) => n + tokensOf(line.length + 1), 0),
        items: weighed.map(({ doc, score, p, fate }) => ({
          ...itemOf(doc),
          score: round(score),
          ...(p !== undefined && { p }),
          tokens: tokensOf(lineOf(doc).length + 1),
          fate: fate === 'kept' ? 'surfaced' : fate,
        })),
        ...(error !== undefined && { error }),
      });
      return kept;
    } catch (e) {
      report({
        type: 'recall',
        on: 'turn',
        query: fit(query, maxQuery),
        tokens: 0,
        items: [],
        error: e instanceof Error ? e.message : String(e),
      });
      return [];
    }
  };
  const shown = o.recall && surface(o.recall);

  const readHistory = async (query: string): Promise<{ text: string; items: RecallItem[] }> => {
    const q = query.trim();
    const h = history(o.data, await asker);
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
    const hits = (await corpus).search(q, { limit: 10, keep: d => d.kind === 'summary' });
    return {
      text: hits.map(({ doc }) => `${doc.pointer} ${doc.text}`).join('\n') || 'nothing found',
      items: hits.map(({ doc, score }) => ({ ...itemOf(doc), score: round(score), fate: 'returned' })),
    };
  };

  return {
    'experimental.chat.system.transform': async (_: unknown, { system }: { system: string[] }) => {
      const lines = await shown;
      if (lines?.length)
        system.push(
          [
            `## Hub notes and earlier runs for this task\n\nThe most relevant, in full. Read another note with \`notes_get\` (kind and slug as in its heading), find more with \`notes_search\`${o.history ? ', and read an earlier run with `history` and its `<run>#<from>-<to>` pointer' : ''}.`,
            ...lines,
          ].join('\n\n')
        );
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
  };
};

const surfacerId = 'bothub-surfacer';

export default { id: surfacerId, server: surfacer };
