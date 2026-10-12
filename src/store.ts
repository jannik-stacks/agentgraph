import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApplyResult } from './apply.ts';
import type { PlannedJob } from './dispatch.ts';
import type { extractProposals, Validated } from './outputs.ts';
import type { Executor } from './schema.ts';
import type { AgentEvent, BotEvent } from './types.ts';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed-out' | 'skipped';

/** One job execution, or a skipped job with its `reason`, persisted as `runs/<id>/run.json`. */
export type Run = Pick<PlannedJob, 'workflow' | 'job' | 'persona'> &
  Pick<Extract<AgentEvent, { type: 'end' }>, 'costUsd' | 'turns'> & {
    id: string;
    executor?: Executor;
    event: BotEvent;
    status: RunStatus;
    startedAt?: string;
    endedAt?: string;
    error?: string;
    reason?: string;
  };

/** What a run proposed and what reached GitHub, persisted as `runs/<id>/outcome.json`. */
export type Outcome = ReturnType<typeof extractProposals> &
  Omit<Validated, 'apply'> & { results: ApplyResult[]; applied: boolean };

/** One line of `runs/<id>/events.jsonl`. */
export type EventRecord = { ts: string; seq: number; event: AgentEvent };

/** A time-prefixed, filesystem-safe id that sorts in creation order. */
export const runId = (now = new Date()) =>
  `${now.toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

/** An append-only run store rooted at `dir`. */
export const openStore = (dir: string) => {
  const runDir = (id: string) => join(dir, 'runs', id);
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

  return { create, update, append, read, list, events, saveOutcome, outcome };
};

export type Store = ReturnType<typeof openStore>;
