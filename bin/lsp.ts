/**
 * Find references and rename across the project from the command line, through the TypeScript language server
 * the project already depends on. Positions are 1-based; the project is the current directory.
 *
 *   node bin/lsp.ts refs <file>:<line>:<col>
 *   node bin/lsp.ts rename <file>:<line>:<col> <newName> [--dry]
 *   node bin/lsp.ts symbol <name>
 *   node bin/lsp.ts rename-symbol <name> <newName> [--dry]
 *
 * `symbol` prints where a name is declared; `rename-symbol` renames it when exactly one declaration matches.
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

type Position = { line: number; character: number };
type Range = { start: Position; end: Position };
type TextEdit = { range: Range; newText: string };
type Location = { uri: string; range: Range };
type WorkspaceEdit = {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: { textDocument?: { uri: string }; edits?: TextEdit[]; kind?: string }[];
};
type Message = { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { dry: { type: 'boolean', default: false }, timeout: { type: 'string', default: '60' } },
});
const [command, target, newName] = positionals;
const root = process.cwd();
const tsc = fileURLToPath(new URL('../node_modules/.bin/tsc', import.meta.url));
let log = '';
const fail = (why: string): never => {
  console.error(`${log}lsp: ${why}`);
  process.exit(1);
};

const server = spawn(tsc, ['--lsp', '--stdio'], { cwd: root, stdio: 'pipe' });
server.stderr.on('data', (d: Buffer) => (log += d));
const timer = setTimeout(
  () => {
    server.kill();
    fail(`no answer from the language server within ${values.timeout}s`);
  },
  Number(values.timeout) * 1000
);
server.on('error', e => fail(`cannot start ${tsc}: ${e.message}`));
server.on('exit', code => pending.size && fail(`the language server stopped (exit ${code})`));

const send = (m: Message) => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...m });
  server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
const pending = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void }>();
let next = 0;
const request = <T>(method: string, params: unknown) =>
  new Promise<T>((ok, no) => {
    pending.set(++next, { ok: ok as (v: unknown) => void, no });
    send({ id: next, method, params });
  });

let buf = Buffer.alloc(0);
server.stdout.on('data', (chunk: Buffer) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const head = buf.indexOf('\r\n\r\n');
    if (head < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, head).toString())?.[1]);
    if (buf.length < head + 4 + length) return;
    const m = JSON.parse(buf.subarray(head + 4, head + 4 + length).toString()) as Message;
    buf = buf.subarray(head + 4 + length);
    if (m.method && m.id !== undefined) send({ id: m.id, result: m.method === 'workspace/configuration' ? [] : null });
    else if (m.id !== undefined) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p?.no(new Error(m.error.message));
      else p?.ok(m.result);
    }
  }
});

const uri = (file: string) => pathToFileURL(resolve(root, file)).href;
const path = (u: string) => relative(root, fileURLToPath(u)) || '.';
const opened = new Set<string>();
const open = (file: string) => {
  const u = uri(file);
  if (opened.has(u)) return;
  opened.add(u);
  const languageId = /\.[cm]?tsx?$/.test(file) ? 'typescript' : 'javascript';
  send({
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: u, languageId, version: 1, text: readFileSync(resolve(root, file), 'utf8') } },
  });
};

const at = (spec = '') => {
  const m = /^(.+):(\d+):(\d+)$/.exec(spec) ?? fail(`expected <file>:<line>:<col>, got "${spec}"`);
  const [, file = '', line, col] = m;
  open(file);
  return { textDocument: { uri: uri(file) }, position: { line: Number(line) - 1, character: Number(col) - 1 } };
};
const show = (l: Location) => `${path(l.uri)}:${l.range.start.line + 1}:${l.range.start.character + 1}`;

const anySource = (dir: string): string | undefined => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    if (e.isFile() && /\.[cm]?tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) return join(dir, e.name);
    if (e.isDirectory()) {
      const found = anySource(join(dir, e.name));
      if (found) return found;
    }
  }
  return undefined;
};

type Found = { name: string; location: Location };
const symbols = async (name: string) => {
  open(relative(root, anySource(root) ?? fail('no TypeScript file under the current directory')));
  const all = (await request<Found[] | null>('workspace/symbol', { query: name })) ?? [];
  return all.filter(s => s.name === name && !s.location.uri.includes('/node_modules/'));
};
const declaration = async (name: string) => {
  const found = await symbols(name);
  if (found.length !== 1)
    fail(`${found.length} declarations named "${name}"${found.map(s => `\n  ${show(s.location)}`).join('')}`);
  return show((found[0] as Found).location);
};

const offset = (text: string, p: Position) => {
  let i = 0;
  for (let line = 0; line < p.line; line++) i = text.indexOf('\n', i) + 1;
  return i + p.character;
};
const apply = (edit: WorkspaceEdit) => {
  const byFile = new Map<string, TextEdit[]>(Object.entries(edit.changes ?? {}));
  for (const c of edit.documentChanges ?? []) {
    if (c.kind) fail(`the edit wants to ${c.kind} a file, which this tool does not do`);
    if (c.textDocument && c.edits)
      byFile.set(c.textDocument.uri, [...(byFile.get(c.textDocument.uri) ?? []), ...c.edits]);
  }
  for (const [u, edits] of byFile) {
    const file = fileURLToPath(u);
    let text = readFileSync(file, 'utf8');
    const sorted = edits
      .map(e => ({ ...e, from: offset(text, e.range.start), to: offset(text, e.range.end) }))
      .sort((a, b) => b.from - a.from);
    if (values.dry) {
      for (const e of sorted.reverse())
        console.log(`${path(u)}:${e.range.start.line + 1}:${e.range.start.character + 1}  ${e.newText}`);
      continue;
    }
    for (const e of sorted) text = text.slice(0, e.from) + e.newText + text.slice(e.to);
    writeFileSync(file, text);
    console.log(path(u));
  }
  if (!byFile.size) fail('nothing to rename there');
};

const rename = async (spec: string | undefined, name: string | undefined) => {
  if (!name) fail('missing <newName>');
  const params = at(spec);
  const ok = await request<unknown>('textDocument/prepareRename', params);
  if (!ok) fail(`nothing to rename at ${spec}`);
  apply((await request<WorkspaceEdit | null>('textDocument/rename', { ...params, newName: name })) ?? {});
};

const main = async () => {
  const rootUri = pathToFileURL(root).href;
  await request('initialize', {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: 'root' }],
    capabilities: {
      workspace: {
        workspaceEdit: { documentChanges: true },
        symbol: {},
        didChangeWatchedFiles: { dynamicRegistration: true },
      },
      textDocument: { rename: { prepareSupport: true }, references: {} },
    },
  });
  send({ method: 'initialized', params: {} });
  if (command === 'refs') {
    const refs = await request<Location[] | null>('textDocument/references', {
      ...at(target),
      context: { includeDeclaration: true },
    });
    for (const r of refs ?? []) console.log(show(r));
  } else if (command === 'rename') await rename(target, newName);
  else if (command === 'symbol')
    for (const s of await symbols(target ?? fail('missing <name>'))) console.log(show(s.location));
  else if (command === 'rename-symbol') await rename(await declaration(target ?? fail('missing <name>')), newName);
  else fail('usage: node bin/lsp.ts refs|rename|symbol|rename-symbol ... (see the top of bin/lsp.ts)');
  await request('shutdown', undefined);
  send({ method: 'exit' });
  clearTimeout(timer);
  server.stdin.end();
};

main().catch((e: Error) => {
  server.kill();
  fail(e.message);
});
