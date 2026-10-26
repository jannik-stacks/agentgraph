import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { parse } from 'yaml';
import settings from '../agentgraph.config.ts';
import type { Check, Graph } from '../src/folder.ts';
import type { Result } from '../src/result.ts';
import type { SessionEvent } from '../src/trace.ts';
import { compileWorkflow, type Problem, type Workflow } from '../src/workflow.ts';
import { git, tmp, write } from './kit.ts';

export const { harnesses } = settings;

/**
 * What a session could leave in its worktree to steer host git: a `.git` pointing at its own repo whose config runs a
 * script through fsmonitor, a clean filter and hooks, and, given the admin dir, a commondir and gitdir pointing away.
 * The script touches `marker`.
 */
export const plant = (dir: string, admin?: string) => {
  const evil = tmp('evil');
  const marker = join(evil, 'marker');
  const script = join(evil, 'run.sh');
  writeFileSync(script, `#!/bin/sh\ntouch ${marker}\ncat\n`);
  chmodSync(script, 0o755);
  git(evil, 'init', '-q', '--bare');
  for (const [key, value] of [
    ['core.fsmonitor', script],
    ['core.hooksPath', join(evil, 'hooks')],
    ['filter.evil.clean', script],
    ['filter.evil.required', 'true'],
  ] as const)
    git(evil, 'config', key, value);
  mkdirSync(join(evil, 'hooks'), { recursive: true });
  for (const hook of ['pre-commit', 'post-commit', 'reference-transaction', 'post-checkout', 'post-index-change'])
    writeFileSync(join(evil, 'hooks', hook), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  writeFileSync(join(dir, '.git'), `gitdir: ${evil}\n`);
  writeFileSync(join(dir, '.gitattributes'), '* filter=evil\n');
  const victim = tmp('victim');
  writeFileSync(join(victim, 'keep.txt'), 'mine\n');
  if (admin) {
    writeFileSync(join(admin, 'commondir'), `${evil}\n`);
    writeFileSync(join(admin, 'gitdir'), `${join(victim, '.git')}\n`);
  }
  return { marker, victim };
};

const root = join(import.meta.dirname, 'fixtures');

export const graphs = ['agentgraph', 'clarinet', 'kit', 'graph', 'loop'];

/** A fixture graph: the names its workflows may use, each check's mode and agent, and every workflow loaded. */
export const fixture = (graph: string) => {
  const dir = join(root, graph);
  const file = parse(readFileSync(join(dir, 'settings.yaml'), 'utf8')) as {
    agents: string[];
    skills: string[];
    checks: Record<string, Check['mode'] | Pick<Check, 'mode' | 'agent'>>;
  };
  const names = {
    agents: file.agents,
    skills: file.skills,
    checks: Object.keys(file.checks),
    judged: Object.entries(file.checks).flatMap(([n, c]) => (typeof c === 'object' && c.agent ? [n] : [])),
  };
  const checks = Object.fromEntries(
    Object.entries(file.checks).map(([name, check]) => [name, typeof check === 'string' ? { mode: check } : check])
  );
  const workflows: Record<string, Workflow> = {};
  const problems: Problem[] = [];
  for (const name of readdirSync(join(dir, 'workflows'))) {
    const path = join(dir, 'workflows', name);
    const loaded = compileWorkflow(path, readFileSync(path, 'utf8'), names);
    problems.push(...loaded.problems);
    if (loaded.workflow) workflows[loaded.workflow.name] = loaded.workflow;
  }
  return { names, checks, workflows, problems };
};

const kinds = ['comment', 'label', 'push', 'pull_request', 'merge', 'issue', 'ask', 'back'] as const;
const doc = <T>(name: string, fields: T) => ({ ...fields, name, path: `${name}.md`, body: `You are ${name}.` });

/** A fixture as a whole graph: every agent on opencode may propose anything, only an implementor code, and `checks` fills in commands and agents. */
export const makeTestGraph = (graph: string, checks: Record<string, Omit<Check, 'mode'>> = {}): Graph => {
  const f = fixture(graph);
  return {
    dir: '/graph',
    repo: `local/${graph}`,
    sha: 'fixture',
    agents: Object.fromEntries(
      f.names.agents.map(b => [
        b,
        doc(b, {
          harness: 'opencode' as const,
          tools: [],
          returns: b === 'implementor' ? [...kinds] : kinds.filter(k => k !== 'push' && k !== 'pull_request'),
        }),
      ])
    ),
    skills: Object.fromEntries(f.names.skills.map(s => [s, doc(s, {})])),
    checks: Object.fromEntries(Object.entries(f.checks).map(([n, { mode }]) => [n, doc(n, { mode, ...checks[n] })])),
    workflows: f.workflows,
    limits: { minutes: 1, usdPerRun: 10, parallel: 2, sessions: 4 },
  };
};

/**
 * Runs `f` with a fake `docker` that logs its arguments and prints `out` for the first key its arguments start with;
 * a `*` in a key matches anything. Each call gets its own state dir.
 */
export const faked = async <A>(out: Record<string, string>, f: (log: () => string) => Promise<A>) => {
  const bin = tmp('bin');
  const log = join(bin, 'log');
  const cases = Object.entries(out)
    .map(
      ([k, v]) =>
        `  ${k
          .split('*')
          .map(p => `"${p}"`)
          .join('*')}*) printf '${v}' ;;`
    )
    .join('\n');
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$*" >> ${log}\ncase "$*" in\n${cases}\nesac\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  const saved = { PATH: process.env.PATH, AGENTGRAPH_STATE: process.env.AGENTGRAPH_STATE };
  process.env.PATH = `${bin}${delimiter}${saved.PATH}`;
  process.env.AGENTGRAPH_STATE = tmp('state');
  try {
    return await f(() => (existsSync(log) ? readFileSync(log, 'utf8') : ''));
  } finally {
    Object.assign(process.env, saved);
    if (saved.AGENTGRAPH_STATE === undefined) delete process.env.AGENTGRAPH_STATE;
  }
};

/** A temp root holding `seed`, a repo with `files` committed on main, and the path of a `data` dir. */
export const seeded = (name: string, files: Record<string, string>) => {
  const root = tmp(name);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', '-b', 'main', seed);
  write(seed, files);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  return { root, seed, data: join(root, 'data') };
};

export const start = (session: string): SessionEvent => ({
  type: 'start',
  session,
  harness: 'test',
  model: 'test',
  home: `/homes/${session}`,
});

/** A session writing `content` to `path`. */
export const wrote = (path: string, content: string): SessionEvent => ({
  type: 'tool',
  id: path,
  name: 'write',
  input: { path, content },
  ok: true,
});

export const result = (input: Result): SessionEvent => ({
  type: 'tool',
  id: 'result',
  name: 'mcp__agentgraph__result',
  input,
  ok: true,
});

export const stop: Extract<SessionEvent, { type: 'end' }> = { type: 'end', final: '', ended: 'stop', exit: 0 };

/** A session ending with `proposals` in its agentgraph block. */
export const reply = (...proposals: unknown[]): SessionEvent => ({
  type: 'end',
  final: `Done.\n\n\`\`\`agentgraph\n${proposals.map(p => JSON.stringify(p)).join('\n')}\n\`\`\``,
  ended: 'stop',
  exit: 0,
});
