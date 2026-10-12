import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { Issues } from './issues.ts';
import { accepted } from './preload.ts';
import { HubTool, Note, NoteKind } from './schema.ts';
import type { Store } from './store.ts';

const protocolVersion = '2025-06-18';

type Sources = { config: Config; issues?: Issues; store?: Store };
type Tool = { description: string; input: z.ZodObject; call: (input: never, s: Sources) => Promise<unknown> };

const need = <T>(source: T | undefined, name: string): T => {
  if (!source) throw new Error(`this server has no ${name}`);
  return source;
};

const State = z.enum(['open', 'closed', 'all']);
const NoteStatus = Note.shape.status.unwrap();
const runLimit = 200;

const tools: Record<HubTool, Tool> = {
  issues_list: {
    description: 'List issues without comments. Filter by label (plan, spec, unsure, ...), state and parent issue.',
    input: z.object({ label: z.string().optional(), state: State.optional(), parent: z.int().optional() }),
    call: async (filter: { label?: string; state?: z.infer<typeof State>; parent?: number }, { issues }) =>
      (await need(issues, 'issues').list(filter)).map(({ comments: _, body: __, ...issue }) => issue),
  },
  issues_get: {
    description: 'Read one issue with its body and comments.',
    input: z.object({ number: z.int().positive() }),
    call: async ({ number }: { number: number }, { issues }) =>
      (await need(issues, 'issues').get(number)) ?? `no issue #${number}`,
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
        .map(({ kind, name, title, paths, status }) => ({ kind, slug: name, title, status, paths }));
    },
  },
  notes_get: {
    description: 'Read one hub note by kind and slug.',
    input: z.object({ kind: NoteKind, slug: z.string() }),
    call: async ({ kind, slug }: { kind: NoteKind; slug: string }, { config }) => {
      const note = config.notes.find(n => n.kind === kind && n.name === slug);
      if (!note) return `no ${kind} note "${slug}"`;
      const { path: _, name, ...rest } = note;
      return { slug: name, ...rest };
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

/** The MCP tool descriptors for `granted`, with JSON Schemas for their inputs. */
export const toolList = (granted: HubTool[]) =>
  granted.map(name => ({
    name,
    description: tools[name].description,
    inputSchema: z.toJSONSchema(tools[name].input, { io: 'input' }),
  }));

/** Calls one granted tool and returns MCP tool-call content. Errors come back as `isError` results. */
export const callTool = async (granted: HubTool[], name: string, args: unknown, sources: Sources) => {
  const parsed = HubTool.safeParse(name);
  if (!parsed.success || !granted.includes(parsed.data))
    return { content: [{ type: 'text', text: `unknown tool "${name}"` }], isError: true };
  const tool = tools[parsed.data];
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
 * A read-only MCP server over newline-delimited JSON-RPC on stdio: `initialize`, `ping`, `tools/list` and
 * `tools/call` for the granted tools. Writes never happen here; they go through proposals.
 */
export const serveMcp = (
  granted: HubTool[],
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
        return { tools: toolList(granted) };
      case 'tools/call':
        return callTool(granted, String(params?.name), params?.arguments, sources);
      default:
        throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
    }
  };
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
    handle(request).then(
      result => send({ jsonrpc: '2.0', id, result }),
      (e: Error & { code?: number }) =>
        send({ jsonrpc: '2.0', id, error: { code: e.code ?? -32603, message: e.message } })
    );
  });
  return new Promise<void>(resolve => lines.once('close', resolve));
};
