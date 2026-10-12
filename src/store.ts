import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlannedJob } from './dispatch.ts';
import type { Executor } from './schema.ts';
import type { AgentEvent, BotEvent } from './types.ts';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed-out';

/** One job execution, persisted as `runs/<id>/run.json`. */
export type Run = Pick<PlannedJob, 'workflow' | 'job' | 'persona'> &
  Pick<Extract<AgentEvent, { type: 'end' }>, 'costUsd' | 'turns'> & {
    id: string;
    executor: Executor;
    event: BotEvent;
    status: RunStatus;
    startedAt?: string;
    endedAt?: string;
    error?: string;
  };

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

  const write = async (run: Run) => {
    const tmp = `${runFile(run.id)}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(run, null, 2) + '\n');
    await rename(tmp, runFile(run.id));
    return run;
  };

  const read = async (id: string): Promise<Run | undefined> => {
    try {
      return JSON.parse(await readFile(runFile(id), 'utf8')) as Run;
    } catch (e) {
      if (missing(e)) return;
      throw e;
    }
  };

  const create = async (fields: Omit<Run, 'id' | 'status'>, id = runId()) => {
    await mkdir(runDir(id), { recursive: true });
    return write({ ...fields, id, status: 'queued' });
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

  return { create, update, append, read, list, events };
};

export type Store = ReturnType<typeof openStore>;
