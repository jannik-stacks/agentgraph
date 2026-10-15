import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { Issues } from './issues.ts';
import { accepted } from './preload.ts';
import { opNames, ops, type Rpc } from './ops.ts';
import { NoteProposal } from './outputs.ts';
import { HubTool, Note, NoteKind } from './schema.ts';
import type { Store } from './store.ts';

const protocolVersion = '2025-06-18';

/** The tools this server serves: the hub tools other than `history`, and `notes_add` for runs that return notes. */
export const McpTool = z.enum([...HubTool.exclude(['history']).options, 'notes_add']);
export type McpTool = z.infer<typeof McpTool>;

/** Where `notes_add` records the notes a run proposes, under the run's home. */
export const proposalsFile = (home: string) => join(home, '.bothub', 'proposals.jsonl');

type Sources = { config: Config; issues?: Issues; store?: Store; home?: string; runner?: Rpc };
type Tool = { description: string; input: z.ZodObject; call: (input: never, s: Sources) => Promise<unknown> };

const need = <T>(source: T | undefined, name: string): T => {
  if (!source) throw new Error(`this server has no ${name}`);
  return source;
};

const State = z.enum(['open', 'closed', 'all']);
const NoteStatus = Note.shape.status.unwrap();
const runLimit = 200;

const NoteInput = NoteProposal.omit({ kind: true });

const tools: Record<McpTool, Tool> = {
  issues_list: {
    description: 'List issues without comments. Filter by label (plan, spec, unsure, ...), state and parent issue.',
    input: z.object({ label: z.string().optional(), state: State.optional(), parent: z.int().optional() }),
    call: async (filter: { label?: string; state?: z.infer<typeof State>; parent?: number }, { issues }) =>
      (await need(issues, 'issues').list(filter)).map(({ comments: _, body: __, human: ___, ...issue }) => issue),
  },
  issues_get: {
    description: 'Read one issue with its body and comments.',
    input: z.object({ number: z.int().positive() }),
    call: async ({ number }: { number: number }, { issues }) => {
      const issue = await need(issues, 'issues').get(number);
      if (!issue) return `no issue #${number}`;
      const { human: _, ...rest } = issue;
      return rest;
    },
  },
  notes_search: {
    description:
      'Search accepted hub notes by words in their title or body. Optionally limit to one kind, or pass a status to search proposed, superseded or retired notes instead.',
    input: z.object({ query: z.string(), kind: NoteKind.optional(), status: NoteStatus.optional() }),
    call: async (
      { query, kind, status }: { query: string; kind?: NoteKind; status?: z.infer<typeof NoteStatus> },
      { config }
    ) => {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const wanted = (n: Config['notes'][number]) => (status ? (n.status ?? 'accepted') === status : accepted(n));
      return config.notes
        .filter(n => wanted(n) && (!kind || n.kind === kind))
        .filter(n => words.every(w => `${n.title}\n${n.body}`.toLowerCase().includes(w)))
        .map(({ kind, name, title, status }) => ({ kind, slug: name, title, status }));
    },
  },
  notes_get: {
    description: 'Read one hub note by kind and slug.',
    input: z.object({ kind: NoteKind, slug: z.string() }),
    call: async ({ kind, slug }: { kind: NoteKind; slug: string }, { config }) => {
      const note = config.notes.find(n => n.kind === kind && n.name === slug);
      if (!note) return `no ${kind} note "${slug}"`;
      const { path: _, human: __, name, ...rest } = note;
      return { slug: name, ...rest };
    },
  },
  notes_add: {
    description:
      'Propose a note for the hub: a decision (what was chosen and why), style (how code and docs should look) or caveat (a known sharp edge). A human accepts it before it is surfaced to anyone.',
    input: NoteInput,
    call: async (note: Omit<z.infer<typeof NoteProposal>, 'kind'>, { home }) => {
      const file = proposalsFile(need(home, 'run home'));
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify({ kind: 'note', ...note })}\n`);
      return `proposed notes/${note.note}/${note.slug}.md; it lands when the run ends`;
    },
  },
  runs_read: {
    description: "Without an id, list recent runs. With an id, read that run's events and outcome.",
    input: z.object({ id: z.string().optional() }),
    call: async ({ id }: { id?: string }, { store }) => {
      const runs = need(store, 'runs');
      if (!id) return (await runs.list()).slice(0, 50);
      const [run, events, outcome] = await Promise.all([runs.read(id), runs.events(id), runs.outcome(id)]);
      return run ? { run, events: events.slice(-runLimit), outcome } : `no run "${id}"`;
    },
  },
};

/**
 * The operator tools: every op of a runner (see `ops.ts`), served only with a `runner` to send them to and never
 * granted to a bot.
 */
const opTools = (runner: Rpc): Record<string, Tool> =>
  Object.fromEntries(
    opNames.map(name => [
      name,
      { description: ops[name].description, input: ops[name].input, call: async input => runner(name, input) },
    ])
  );

const served = (granted: McpTool[], sources: Pick<Sources, 'runner'>): Record<string, Tool> => ({
  ...Object.fromEntries(granted.map(name => [name, tools[name]])),
  ...(sources.runner && opTools(sources.runner)),
});

/** The MCP tool descriptors for `granted`, and the ops with a `runner`, with JSON Schemas for their inputs. */
export const toolList = (granted: McpTool[], sources: Pick<Sources, 'runner'> = {}) =>
  Object.entries(served(granted, sources)).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.input, { io: 'input' }),
  }));

/** Calls one served tool and returns MCP tool-call content. Errors come back as `isError` results. */
export const callTool = async (granted: McpTool[], name: string, args: unknown, sources: Sources) => {
  const tool = served(granted, sources)[name];
  if (!tool) return { content: [{ type: 'text', text: `unknown tool "${name}"` }], isError: true };
  const input = tool.input.safeParse(args ?? {});
  if (!input.success) return { content: [{ type: 'text', text: z.prettifyError(input.error) }], isError: true };
  try {
    const result = await tool.call(input.data as never, sources);
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
  }
};

type Request = { jsonrpc: '2.0'; id?: string | number; method: string; params?: Record<string, unknown> };

/**
 * An MCP server over newline-delimited JSON-RPC on stdio: `initialize`, `ping`, `tools/list` and
 * `tools/call` for the granted tools. Those write nothing but a run's own proposals, which land only when the run
 * ends; with a `runner`, the operator ops are served too and act on that runner. Resolves once the input ends and
 * every call has been answered.
 */
export const serveMcp = (
  granted: McpTool[],
  sources: Sources,
  { input = process.stdin, output = process.stdout }: { input?: Readable; output?: Writable } = {}
) => {
  const send = (message: unknown) => output.write(`${JSON.stringify(message)}\n`);
  const handle = async ({ method, params }: Request): Promise<unknown> => {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'bothub', version: '0.0.0' },
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: toolList(granted, sources) };
      case 'tools/call':
        return callTool(granted, String(params?.name), params?.arguments, sources);
      default:
        throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
    }
  };
  const pending = new Set<Promise<unknown>>();
  const lines = createInterface({ input });
  lines.on('line', line => {
    if (!line.trim()) return;
    let request: Request;
    try {
      request = JSON.parse(line) as Request;
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    if (request.id === undefined) return;
    const { id } = request;
    const answered = handle(request).then(
      result => send({ jsonrpc: '2.0', id, result }),
      (e: Error & { code?: number }) =>
        send({ jsonrpc: '2.0', id, error: { code: e.code ?? -32603, message: e.message } })
    );
    pending.add(answered);
    void answered.finally(() => pending.delete(answered));
  });
  return new Promise<void>(resolve =>
    lines.once('close', () => void Promise.allSettled([...pending]).then(() => resolve()))
  );
};
