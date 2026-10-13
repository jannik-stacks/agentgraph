import type { Proposal } from './outputs.ts';
import type { EventRecord, Outcome, Run } from './store.ts';

/** A short, deterministic record of what a finished run did, kept next to its events. */
export type Memory = Pick<Run, 'workflow' | 'job' | 'bot' | 'status' | 'closure' | 'attempt' | 'check' | 'error'> & {
  runId: string;
  tools: Record<string, number>;
  proposed: string[];
  failed: { check: string; gating: boolean; findings: string }[];
  landed: { kind: Proposal['kind']; url?: string; sha?: string }[];
  rejected: string[];
  files: string[];
  durationMs?: number;
  tokens: { input: number; output: number };
  costUsd?: number;
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

type Describers = Partial<{ [K in Proposal['kind']]: (proposal: Extract<Proposal, { kind: K }>) => string }>;

const describers: Describers = {
  reply: () => 'reply',
  label: ({ add = [], remove = [] }) => ['label', ...add.map(l => `+${l}`), ...remove.map(l => `-${l}`)].join(' '),
  push: ({ branch, files }) => `push ${branch}${files ? ` (${files.length} files)` : ''}`,
  'merge-request': ({ title, branch }) => `merge-request ${branch} "${clip(title, 80)}"`,
  merge: ({ request }) => `merge #${request}`,
  note: ({ note, slug }) => `note ${note}/${slug}`,
  ask: ({ question }) => `ask "${clip(question, 120)}"`,
  close: ({ as, reason }) => `close as ${as}: ${clip(reason, 120)}`,
};

const describe = (proposal: Proposal) =>
  (describers[proposal.kind] as ((p: Proposal) => string) | undefined)?.(proposal) ?? proposal.kind;

const writing = /edit|write|patch/i;
const pathKeys = ['file_path', 'filePath', 'path', 'notebook_path'];

const touched = (input: unknown): string[] => {
  if (!input || typeof input !== 'object') return [];
  const record = input as Record<string, unknown>;
  const direct = pathKeys.map(key => record[key]).filter((v): v is string => typeof v === 'string');
  const changes = Array.isArray(record.changes)
    ? record.changes.map(c => (c as { path?: unknown })?.path).filter((v): v is string => typeof v === 'string')
    : [];
  return [...direct, ...changes];
};

const durationOf = (run: Run, events: EventRecord[]) => {
  const start = run.startedAt ?? events[0]?.ts;
  const end = run.endedAt ?? events.at(-1)?.ts;
  if (!start || !end) return;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
};

/** Summarizes a finished run from its stored events and outcome. No model is involved. */
export const summarize = (run: Run, events: EventRecord[], outcome: Outcome | undefined): Memory => {
  const tools: Record<string, number> = {};
  const files = new Set<string>();
  const tokens = { input: 0, output: 0 };
  for (const { event } of events) {
    if (event.type === 'tool_call') {
      tools[event.tool] = (tools[event.tool] ?? 0) + 1;
      if (writing.test(event.tool)) for (const file of touched(event.input)) files.add(file);
    }
    if (event.type === 'usage') {
      tokens.input += event.inputTokens;
      tokens.output += event.outputTokens;
    }
  }
  for (const proposal of outcome?.accepted ?? [])
    if (proposal.kind === 'push') for (const file of proposal.files ?? []) files.add(file);
  const durationMs = durationOf(run, events);
  return {
    runId: run.id,
    workflow: run.workflow,
    job: run.job,
    ...(run.bot && { bot: run.bot }),
    status: run.status,
    ...(run.closure && { closure: run.closure }),
    ...(run.attempt && { attempt: run.attempt }),
    ...(run.check && { check: run.check }),
    ...(run.error && { error: run.error }),
    tools,
    proposed: (outcome?.proposals ?? []).map(describe),
    failed: (outcome?.checks ?? [])
      .filter(v => !v.pass)
      .map(v => ({ check: v.check, gating: v.gating, findings: clip(v.findings ?? 'failed without output', 500) })),
    landed: (outcome?.results ?? [])
      .filter(r => r.status === 'applied')
      .map(r => ({ kind: r.kind, ...(r.url && { url: r.url }), ...(r.sha && { sha: r.sha }) })),
    rejected: (outcome?.rejected ?? []).map(r => `${describe(r.proposal)}: ${r.reason}`),
    files: [...files].sort(),
    ...(durationMs !== undefined && { durationMs }),
    tokens,
    ...(run.costUsd !== undefined && { costUsd: run.costUsd }),
  };
};

const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

const section = (title: string, lines: string[]) => (lines.length ? [`## ${title}`, ...lines].join('\n') : undefined);

/** The memory as short Markdown, for a bot to read. */
export const renderMemory = (m: Memory) => {
  const facts = [
    m.bot && `bot ${m.bot}`,
    `status ${m.status}`,
    m.closure && `closure ${m.closure}`,
    m.attempt && `attempt ${m.attempt}`,
    m.check && `check ${m.check}`,
  ].filter(Boolean);
  const cost = [
    m.durationMs !== undefined && `took ${duration(m.durationMs)}`,
    (m.tokens.input || m.tokens.output) && `${m.tokens.input} tokens in, ${m.tokens.output} out`,
    m.costUsd !== undefined && `$${m.costUsd.toFixed(2)}`,
  ].filter(Boolean);
  const tools = Object.entries(m.tools).map(([tool, n]) => `${tool} (${n})`);
  return [
    `# ${m.workflow}/${m.job} run ${m.runId}`,
    [facts.join(', '), cost.join(', ')].filter(Boolean).join('\n'),
    m.error && `Error: ${m.error}`,
    section('Tried', [
      ...(tools.length ? [`- Tools: ${tools.join(', ')}`] : []),
      ...m.proposed.map(p => `- Proposed ${p}`),
    ]),
    section(
      'Failed',
      m.failed.map(f => `- ${f.check}${f.gating ? '' : ' (shadow)'}: ${f.findings.replaceAll('\n', ' ')}`)
    ),
    section(
      'Rejected',
      m.rejected.map(r => `- ${r}`)
    ),
    section(
      'Landed',
      m.landed.map(l => `- ${l.kind}${l.url ? ` ${l.url}` : ''}${l.sha ? ` ${l.sha.slice(0, 12)}` : ''}`)
    ),
    section(
      'Files',
      m.files.map(f => `- ${f}`)
    ),
  ]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n');
};

/** Where a run's memory lives, relative to the store's data dir. */
export const memoryPath = (runId: string) => `runs/${runId}/memory.md`;

/** The run store calls memory needs; the store reads and writes memory at `memoryPath(id)`. */
export type MemoryStore = {
  list: () => Promise<Run[]>;
  memory: (id: string) => Promise<string | undefined>;
  saveMemory: (id: string, text: string) => Promise<void>;
};

/** Summarizes a finished run and saves its memory. */
export const writeMemory = async (
  store: Pick<MemoryStore, 'saveMemory'>,
  run: Run,
  events: EventRecord[],
  outcome: Outcome | undefined
) => {
  const memory = summarize(run, events, outcome);
  await store.saveMemory(run.id, renderMemory(memory));
  return memory;
};

/** The last `n` memories of runs matching `filter`, newest first. Runs without a memory are skipped. */
export const recentMemory = async (
  store: Pick<MemoryStore, 'list' | 'memory'>,
  filter: Partial<Pick<Run, 'bot' | 'workflow' | 'job'>>,
  n = 10
) => {
  const matches = (run: Run) =>
    (filter.bot === undefined || run.bot === filter.bot) &&
    (filter.workflow === undefined || run.workflow === filter.workflow) &&
    (filter.job === undefined || run.job === filter.job);
  const found: { runId: string; memory: string }[] = [];
  for (const run of (await store.list()).filter(matches)) {
    if (found.length >= n) break;
    const memory = await store.memory(run.id);
    if (memory !== undefined) found.push({ runId: run.id, memory });
  }
  return found;
};
