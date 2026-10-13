import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { ApplyResult } from './apply.ts';
import type { PlannedJob } from './dispatch.ts';
import type { extractProposals, Validated } from './outputs.ts';
import type { Closure, Harness } from './schema.ts';
import type { AgentEvent, BotEvent } from './types.ts';
import type { Workspaces } from './workspace.ts';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed-out'
  | 'skipped'
  | 'interrupted';

/** The process that created a run: its pid and a token minted once per process start. */
export type Owner = { pid: number; token: string };

/** This process. */
export const self: Owner = { pid: process.pid, token: randomBytes(8).toString('hex') };

/**
 * One job execution, or a skipped job with its `reason`, persisted as `runs/<id>/run.json`. `closure` says what
 * happened to the work, `base` is the commit its worktree started from, `model` the model the harness reported and
 * `approval` the issue a gated job waits on.
 */
export type Run = Pick<PlannedJob, 'workflow' | 'job' | 'bot'> &
  Pick<Extract<AgentEvent, { type: 'end' }>, 'costUsd' | 'turns'> & {
    id: string;
    harness?: Harness;
    model?: string;
    parent?: string;
    attempt?: number;
    check?: string;
    event: BotEvent;
    status: RunStatus;
    closure?: Closure;
    owner?: Owner;
    base?: string;
    approval?: number;
    startedAt?: string;
    endedAt?: string;
    error?: string;
    reason?: string;
    /** Rewinds of this run: events after the smallest `after` are archived, kept for humans and never shown to bots. */
    archived?: { after: number; lesson: string; by: 'bot' | 'retry'; patch?: string }[];
  };

/**
 * One check's result after an attempt. Only gating checks (not in `shadow` mode) can fail the attempt; a `skipped`
 * check matched no changed file and passes only when the check allows it.
 */
export type Verdict = {
  check: string;
  pass: boolean;
  gating: boolean;
  skipped?: boolean;
  findings?: string;
  runs?: string[];
};

/**
 * What a run proposed, how its checks went and what reached GitHub, persisted as `runs/<id>/outcome.json`. `results`
 * is written before anything is applied and updated as each effect lands. `branch` and `pr` are the work it hands to
 * the jobs that need it.
 */
export type Outcome = ReturnType<typeof extractProposals> &
  Omit<Validated, 'apply'> & {
    results: ApplyResult[];
    applied: boolean;
    checks?: Verdict[];
    branch?: string;
    pr?: number;
  };

/** One line of `runs/<id>/events.jsonl`. */
export type EventRecord = { ts: string; seq: number; event: AgentEvent };

/** A time-prefixed, filesystem-safe id that sorts in creation order. */
export const runId = (now = new Date()) =>
  `${now.toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

/**
 * Whether the process that owns a run may still be running. A run from this process is alive; one from an earlier
 * process with this pid is not; any other pid is alive while the OS still knows it.
 */
export const alive = (owner: Owner | undefined, me: Owner = self) => {
  if (!owner) return false;
  if (owner.token === me.token) return true;
  if (owner.pid === me.pid) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (e) {
    return code(e) === 'EPERM';
  }
};

const hashed = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 40);

const harnessFile = /\.jsonl?$/;
const credentials = new Set(['auth.json', '.credentials.json']);

/**
 * An append-only run store rooted at `dir`. Each run lives in `runs/<id>/`: `run.json`, `events.jsonl`,
 * `outcome.json`, the harness's private `home/` and, while it runs, `tmp/`.
 */
export const openStore = (dir: string, owner: Owner = self) => {
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
    return write({ status: 'queued', owner, ...fields, id });
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
  const memoryFile = (id: string) => join(runDir(id), 'memory.md');
  const saveMemory = async (id: string, text: string) => {
    await writeFile(memoryFile(id), text);
  };
  const memory = async (id: string) => {
    try {
      return await readFile(memoryFile(id), 'utf8');
    } catch (e) {
      if (missing(e)) return;
      throw e;
    }
  };

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

  /** Records a delivery id; true the first time it is seen, false for every repeat. */
  const deliver = async (id: string) => {
    await mkdir(join(dir, 'deliveries'), { recursive: true });
    try {
      await (await open(join(dir, 'deliveries', hashed(id)), 'wx')).close();
      return true;
    } catch (e) {
      if (code(e) === 'EEXIST') return false;
      throw e;
    }
  };

  /**
   * Takes the lock `name` for `run`. Resolves to a release function, or to the run holding it. A lock whose owner
   * process is gone is taken over.
   */
  const lock = async (name: string, run: string): Promise<{ release: () => Promise<void> } | { holder: string }> => {
    const file = join(dir, 'locks', hashed(name));
    await mkdir(join(dir, 'locks'), { recursive: true });
    for (let tries = 0; ; tries++) {
      try {
        const handle = await open(file, 'wx');
        await handle.writeFile(JSON.stringify({ name, run, owner }));
        await handle.close();
        return { release: () => rm(file, { force: true }) };
      } catch (e) {
        if (code(e) !== 'EEXIST') throw e;
      }
      const held = await readJson<{ run: string; owner: Owner }>(file).catch(() => undefined);
      if (tries || (held && alive(held.owner, owner))) return { holder: held?.run ?? 'unknown' };
      await rm(file, { force: true });
    }
  };

  return {
    create,
    update,
    append,
    read,
    list,
    events,
    saveOutcome,
    outcome,
    memory,
    saveMemory,
    home,
    tmp,
    files,
    file,
    deliver,
    lock,
  };
};

export type Store = ReturnType<typeof openStore>;

const unfinished = (run: Run, outcome: Outcome | undefined) =>
  run.status === 'queued' ||
  run.status === 'running' ||
  (outcome?.results.some(result => result.status === 'pending') ?? false);

/**
 * Marks runs left unfinished by a process that is gone as `interrupted`: still queued or running, or stopped while
 * applying. Removes their worktrees and temporary files and resolves to the runs it marked. Runs whose process may
 * still be alive are left alone.
 */
export const reconcile = async (store: Store, workspaces: Pick<Workspaces, 'remove'>, me: Owner = self) => {
  const marked: Run[] = [];
  for (const run of await store.list()) {
    if (!unfinished(run, await store.outcome(run.id)) || alive(run.owner, me)) continue;
    const reason =
      run.status === 'queued' || run.status === 'running'
        ? `the process running it stopped while it was ${run.status}`
        : 'the process running it stopped while applying';
    marked.push(
      await store.update(run.id, { status: 'interrupted', error: reason, endedAt: new Date().toISOString() })
    );
    await workspaces.remove(run.event.repo, run.id);
    await rm(store.tmp(run.id), { recursive: true, force: true });
  }
  return marked;
};
