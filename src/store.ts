import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { ApplyResult } from './apply.ts';
import type { PlannedJob } from './dispatch.ts';
import type { extractProposals, Validated } from './outputs.ts';
import type { Executor } from './schema.ts';
import type { AgentEvent, BotEvent } from './types.ts';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed-out' | 'skipped';

/** One job execution, or a skipped job with its `reason`, persisted as `runs/<id>/run.json`. */
export type Run = Pick<PlannedJob, 'workflow' | 'job' | 'bot'> &
  Pick<Extract<AgentEvent, { type: 'end' }>, 'costUsd' | 'turns'> & {
    id: string;
    harness?: Executor;
    parent?: string;
    attempt?: number;
    check?: string;
    event: BotEvent;
    status: RunStatus;
    startedAt?: string;
    endedAt?: string;
    error?: string;
    reason?: string;
  };

/** One check's result after an attempt. Only gating checks (not in `shadow` mode) can fail the attempt. */
export type Verdict = { check: string; pass: boolean; gating: boolean; findings?: string; runs?: string[] };

/** What a run proposed, how its checks went and what reached GitHub, persisted as `runs/<id>/outcome.json`. */
export type Outcome = ReturnType<typeof extractProposals> &
  Omit<Validated, 'apply'> & { results: ApplyResult[]; applied: boolean; checks?: Verdict[] };

/** One line of `runs/<id>/events.jsonl`. */
export type EventRecord = { ts: string; seq: number; event: AgentEvent };

/** A time-prefixed, filesystem-safe id that sorts in creation order. */
export const runId = (now = new Date()) =>
  `${now.toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

const harnessFile = /\.jsonl?$/;
const credentials = new Set(['auth.json', '.credentials.json']);

/**
 * An append-only run store rooted at `dir`. Each run lives in `runs/<id>/`: `run.json`, `events.jsonl`,
 * `outcome.json`, the harness's private `home/` and, while it runs, `tmp/`.
 */
export const openStore = (dir: string) => {
  const runDir = (id: string) => join(dir, 'runs', id);
  const home = (id: string) => join(runDir(id), 'home');
  const tmp = (id: string) => join(runDir(id), 'tmp');
  const runFile = (id: string) => join(runDir(id), 'run.json');
  const outcomeFile = (id: string) => join(runDir(id), 'outcome.json');

  const writeJson = async <T>(file: string, value: T) => {
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
    await rename(tmp, file);
    return value;
  };

  const readJson = async <T>(file: string): Promise<T | undefined> => {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch (e) {
      if (missing(e)) return;
      throw e;
    }
  };

  const write = (run: Run) => writeJson(runFile(run.id), run);
  const read = (id: string) => readJson<Run>(runFile(id));

  /** Records a new run, `queued` unless `status` says otherwise. */
  const create = async (fields: Omit<Run, 'id' | 'status'> & Partial<Pick<Run, 'status'>>, id = runId()) => {
    await mkdir(runDir(id), { recursive: true });
    return write({ status: 'queued', ...fields, id });
  };

  const update = async (id: string, patch: Partial<Omit<Run, 'id'>>) => {
    const run = await read(id);
    if (!run) throw new Error(`unknown run "${id}"`);
    return write({ ...run, ...patch });
  };

  const append = (id: string, record: EventRecord) =>
    appendFile(join(runDir(id), 'events.jsonl'), JSON.stringify(record) + '\n');

  /** Newest first. */
  const list = async () => {
    let ids: string[];
    try {
      ids = await readdir(join(dir, 'runs'));
    } catch (e) {
      if (missing(e)) return [];
      throw e;
    }
    const runs = await Promise.all(ids.sort().reverse().map(read));
    return runs.filter(run => run !== undefined);
  };

  /** Events with `seq >= from`; a trailing partial line from an in-flight append is skipped. */
  const events = async (id: string, from = 0) => {
    let text: string;
    try {
      text = await readFile(join(runDir(id), 'events.jsonl'), 'utf8');
    } catch (e) {
      if (missing(e)) return [];
      throw e;
    }
    return text
      .split('\n')
      .slice(0, -1)
      .map(line => JSON.parse(line) as EventRecord)
      .filter(record => record.seq >= from);
  };

  const saveOutcome = (id: string, outcome: Outcome) => writeJson(outcomeFile(id), outcome);
  const outcome = (id: string) => readJson<Outcome>(outcomeFile(id));

  /** The harness's own transcripts and session state under `home/`: JSON and JSON Lines files, minus credentials. */
  const files = async (id: string) => {
    const found: string[] = [];
    const walk = async (rel: string) => {
      let entries;
      try {
        entries = await readdir(join(home(id), rel), { withFileTypes: true });
      } catch (e) {
        if (missing(e)) return;
        throw e;
      }
      for (const entry of entries) {
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && harnessFile.test(entry.name) && !credentials.has(entry.name)) found.push(path);
      }
    };
    await walk('');
    return found.sort();
  };

  /** One of `files(id)`, or undefined for any other path. */
  const file = async (id: string, path: string) => {
    if (!(await files(id)).includes(path)) return;
    try {
      const base = await realpath(home(id));
      const target = await realpath(join(base, path));
      return target.startsWith(base + sep) ? await readFile(target, 'utf8') : undefined;
    } catch (e) {
      if (missing(e)) return;
      throw e;
    }
  };

  return { create, update, append, read, list, events, saveOutcome, outcome, home, tmp, files, file };
};

export type Store = ReturnType<typeof openStore>;
