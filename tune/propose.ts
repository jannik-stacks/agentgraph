/**
 * Proposers: turn a tune's failing fit cases or its mined history into one candidate hub.
 *
 *   node tune/propose.ts <tune dir> retro|history|structure --id <id> --from <hub> [--runs <dir>] [--iteration n]
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Effect } from 'effect';
import { failureClass, infra } from '../bin/bench.ts';
import { write } from '../bin/resume.ts';
import { transcript } from '../src/context.ts';
import { type Hub, loadHub } from '../src/hub.ts';
import type { Trace } from '../src/trace.ts';
import type { Run } from '../src/workflow.ts';

export type Proposer = 'retro' | 'history' | 'structure';
/** One file edit: `content` writes the file, `old` with `new` replaces one unique snippet, `delete` removes it. */
type Change = { path: string; content?: string; old?: string; new?: string; delete?: boolean };
export type Usage = { fiveHour: number; week: number };
type Answer = {
  verdict: 'change' | 'nothing';
  missClass?: string;
  rationale: string;
  cases: { id: string; evidence: string }[];
  changes: Change[];
};
/** A proposer's answer; `hub` is set only when the answer is a change and the patched hub passes the hub check. */
type Proposal = Answer & {
  id: string;
  proposer: Proposer;
  hub?: string;
  usd: number;
  usage?: Usage;
  problems: string[];
};

/** The structure proposer's menu, taken round-robin by iteration. */
const edits = ['reviewer', 'drop', 'tries', 'scout', 'warn'] as const;

/** The edits of the menu that can change this hub: nothing added twice, nothing dropped or softened that is not there. */
export const fitting = (hub: Hub) => {
  const steps = Object.values(hub.workflows).flatMap(w => w.steps);
  const work = steps.filter(s => !('wait' in s.does));
  const has = (name: string) => steps.some(s => s.name === name);
  const extra = Object.keys(hub.checks).some(c => c !== 'tests') || Object.keys(hub.skills).length > 0;
  const fits = {
    reviewer: !has('review'),
    drop: work.length > 1 || extra,
    tries: work.some(s => s.checks.length > 0 && s.tries < 4),
    scout: !has('scout'),
    warn: Object.values(hub.checks).some(
      c => c.name !== 'tests' && c.mode === 'block' && steps.some(s => s.checks.includes(c.name))
    ),
  };
  return edits.filter(e => fits[e]);
};

const schema = {
  type: 'object',
  required: ['verdict', 'rationale', 'cases', 'changes'],
  properties: {
    verdict: { enum: ['change', 'nothing'] },
    missClass: { type: 'string' },
    rationale: { type: 'string' },
    cases: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'evidence'],
        properties: { id: { type: 'string' }, evidence: { type: 'string' } },
      },
    },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          old: { type: 'string' },
          new: { type: 'string' },
          delete: { type: 'boolean' },
        },
      },
    },
  },
};
const minCases: Record<Proposer, number> = { retro: 2, history: 2, structure: 1 };
const hubPath = /^(hub\.yaml|(agents|skills|checks|workflows|scripts)(\/[\w-][\w.-]*)+)$/;
const here = (path: string) => join(import.meta.dirname, path);
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const head = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}\n... ${text.length - max} more characters`;
const tail = (text: string, max: number) => (text.length <= max ? text : `...\n${text.slice(-max)}`);
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
/** Compiler warning blocks and build progress lines, which crowd out the failure in a test output tail. */
const noise =
  /^warning[:[][\s\S]*?(?:\n[ \t]*\n|(?![\s\S]))|^ *(Compiling|Finished|Running|Downloaded|Downloading) .*\n/gm;
const fence = (text: string, lang = '') => `\`\`\`${lang}\n${text.replaceAll('```', "'''")}\n\`\`\``;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap(n =>
    statSync(join(dir, n)).isDirectory() ? files(join(dir, n)).map(f => `${n}/${f}`) : [n]
  );

type Material = { id: string; text: string; files: Record<string, string> };

const titleOf = (dir: string) =>
  (JSON.parse(read(join(dir, 'case.json')) || '{}') as { title?: string; pr?: number }).title ?? '';

/** The newest run of each bot arm of a case whose change failed the hidden tests, infra failures left out. */
const failing = (runs: string, id: string) => {
  const dir = join(runs, id);
  if (!existsSync(dir) || (JSON.parse(read(join(dir, 'valid.json')) || '{}') as { invalid?: string }).invalid)
    return [];
  return readdirSync(dir)
    .filter(arm => !['human', 'base', 'judge', 'tree'].includes(arm) && !arm.includes('.'))
    .flatMap(arm => {
      const s = JSON.parse(read(join(dir, arm, 'score.json')) || 'null') as
        | (Parameters<typeof infra>[0] & { hidden?: { ok: boolean; tail: string; class?: string } })
        | null;
      return s?.hidden && !s.hidden.ok && !infra(s) ? [{ at: join(dir, arm), hidden: s.hidden }] : [];
    })
    .slice(0, 1);
};

const traces = (at: string, budget: number) => {
  const data = join(at, 'data');
  const runs = (existsSync(data) ? readdirSync(data) : [])
    .filter(n => n.startsWith('issue-') && existsSync(join(data, n, 'run.json')))
    .sort()
    .map(n => ({
      run: JSON.parse(read(join(data, n, 'run.json'))) as Run,
      lines: read(join(data, n, 'trace.jsonl'))
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l) as Trace),
    }));
  return transcript(1, runs, budget);
};

/** Failing fit cases with their diffs, hidden test output and run transcripts; `small` for the structure proposer. */
const failures = (cases: string, runs: string, ids: string[], small: boolean): Material[] =>
  ids
    .flatMap(id => failing(runs, id).map(f => ({ id, ...f })))
    .slice(0, small ? 4 : 6)
    .map(({ id, at, hidden }) => {
      const issue = read(join(cases, id, 'issue.md'));
      const human = read(join(cases, id, 'merged.diff'));
      const bot = read(join(at, 'diff.patch'));
      const out = hidden.tail.replace(ansi, '').replace(noise, '');
      const full = traces(at, 60_000);
      const text = [
        `### ${id}: ${titleOf(join(cases, id))}`,
        `Issue:\n\n${head(issue, small ? 800 : 2000)}`,
        `Hidden tests (${hidden.class ?? failureClass(out)}):\n\n${fence(tail(out, small ? 700 : 1500))}`,
        ...(small
          ? []
          : [`Bot diff:\n\n${fence(head(bot, 3000), 'diff')}`, `Human diff:\n\n${fence(head(human, 3000), 'diff')}`]),
        `Transcript:\n\n${traces(at, small ? 4000 : 10_000)}`,
      ].join('\n\n');
      return {
        id,
        text,
        files: { 'issue.md': issue, 'human.diff': human, 'bot.diff': bot, 'hidden.txt': out, 'traces.md': full },
      };
    });

/** A seeded shuffle, so an iteration samples the same cases again on resume. */
const shuffle = <T>(xs: T[], seed: number) => {
  const out = [...xs];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

/** How the hub did on cases the proposer never sees: counts per failure class, no ids or content. */
const unseen = (runs: string, ids: string[]) => {
  const ran = ids.filter(id => existsSync(join(runs, id)));
  const classes = ids.flatMap(id => failing(runs, id).map(f => f.hidden.class ?? failureClass(f.hidden.tail)));
  if (!ran.length) return '';
  const by = [...new Set(classes)].map(c => `${classes.filter(x => x === c).length} ${c}`).join(', ');
  return `${classes.length} of ${ran.length} fail the hidden tests${by ? `: ${by}` : ''}.`;
};

/** What earlier candidates of this tune tried and how each ended, one line each. */
const tried = (tune: string) => {
  const verdicts = new Map(
    read(join(tune, 'iterations.jsonl'))
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as { id: string; verdict: string })
      .map(s => [s.id, s.verdict])
  );
  const cands = join(tune, 'cands');
  return (existsSync(cands) ? readdirSync(cands) : [])
    .filter(id => verdicts.has(id) && !id.endsWith('-init'))
    .sort()
    .map(id => {
      const c = JSON.parse(read(join(cands, id, 'candidate.json')) || '{}') as {
        proposer?: string;
        rationale?: string;
      };
      const first = (c.rationale ?? '')
        .replace(/^#.*\n+/, '')
        .split(/(?<=\.)\s/)[0]!
        .trim();
      return `- ${id}, ${c.proposer ?? '?'}, ${verdicts.get(id)}: ${head(first, 300)}`;
    });
};

/** Eight mine cases, those with review comments that ask for something first. */
const history = (cases: string, ids: string[], seed: number): Material[] => {
  const said = (id: string) =>
    read(join(cases, id, 'reviews.md'))
      .replace(/^### review (APPROVED|COMMENTED) \(.*\)$/gm, '')
      .trim().length > 80;
  const order = shuffle(ids, seed + 1);
  return [...order.filter(said), ...order.filter(id => !said(id))].slice(0, 8).map(id => {
    const c = JSON.parse(read(join(cases, id, 'case.json')) || '{}') as { pr?: number; title?: string };
    const issue = read(join(cases, id, 'issue.md'));
    const diff = read(join(cases, id, 'merged.diff'));
    const reviews = read(join(cases, id, 'reviews.md'));
    const touched = [...diff.matchAll(/^diff --git a\/(\S+)/gm)].map(m => m[1]).join('\n');
    const text = [
      `### ${id}: PR #${c.pr ?? '?'} ${c.title ?? ''}`,
      `Issue:\n\n${head(issue, 1200)}`,
      `Files:\n\n${touched}`,
      `Diff excerpt:\n\n${fence(head(diff, 1500), 'diff')}`,
      `Reviews:\n\n${head(reviews, 3500) || '(none)'}`,
    ].join('\n\n');
    return { id, text, files: { 'issue.md': issue, 'merged.diff': diff, 'reviews.md': reviews } };
  });
};

const hubText = (hub: string) =>
  files(hub)
    .sort()
    .map(f => `### ${f}\n\n${fence(head(read(join(hub, f)), 4000))}`)
    .join('\n\n');

type Event = {
  type?: string;
  session_id?: string;
  total_cost_usd?: number;
  structured_output?: unknown;
  result?: string;
  rate_limit_info?: { unifiedWindows?: Record<string, { utilization?: number } | undefined> };
  message?: { content?: unknown };
};
/** The events of a stream-json session, lines that are not JSON left out. */
export const events = (stream: string) =>
  stream.split('\n').flatMap(line => {
    try {
      return [JSON.parse(line) as Event];
    } catch {
      return [];
    }
  });

/** Claude's 5-hour and weekly use in percent, from the newest `rate_limit_event` of a stream-json session. */
export const claudeUsed = (stream: string): Usage | undefined => {
  const w = events(stream)
    .flatMap(e =>
      e.type === 'rate_limit_event' && e.rate_limit_info?.unifiedWindows ? [e.rate_limit_info.unifiedWindows] : []
    )
    .at(-1);
  const pct = (u?: number) => Math.round((u ?? 0) * 1000) / 10;
  return w?.five_hour && w.seven_day
    ? { fiveHour: pct(w.five_hour.utilization), week: pct(w.seven_day.utilization) }
    : undefined;
};

const claude = (args: string[], prompt: string, cwd: string, log: string) =>
  new Promise<string>((done, fail) => {
    const child = spawn(process.env.AGENTGRAPH_CLAUDE ?? 'claude', args, {
      cwd,
      env: { ...process.env, NODE_OPTIONS: '' },
      timeout: 30 * 60_000,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      appendFileSync(log, d);
    });
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', fail);
    child.on('close', code => {
      if (out.includes('"type":"result"')) done(out);
      else fail(new Error(`claude exited ${code}: ${tail(err, 500)}`));
    });
    child.stdin.end(prompt);
  });

const answerOf = (result?: Event): Answer | undefined => {
  if (result?.structured_output) return result.structured_output as Answer;
  const text = result?.result ?? '';
  const json = [...text.matchAll(/```json\n([\s\S]*?)```/g)].at(-1)?.[1] ?? text;
  try {
    return JSON.parse(json) as Answer;
  } catch {
    return undefined;
  }
};

const problemsOf = (a: Answer, ids: string[], min: number) => {
  const known = new Set(a.cases.map(c => c.id).filter(id => ids.includes(id)));
  const unknown = a.cases.map(c => c.id).filter(id => !ids.includes(id));
  if (a.verdict === 'nothing') return unknown.map(id => `case ${id} was not in the material`);
  const added = a.changes.reduce((n, c) => n + (c.content ?? c.new ?? '').split('\n').length, 0);
  return [
    ...(a.changes.length === 0 ? ['a change needs at least one entry in changes'] : []),
    ...(a.changes.length > 3 ? [`${a.changes.length} changes, at most 3`] : []),
    ...(added > 80 ? [`${added} added lines, keep it under 60`] : []),
    ...unknown.map(id => `case ${id} was not in the material`),
    ...(known.size < min ? [`${known.size} cited case(s) from the material, at least ${min} needed`] : []),
    ...a.changes.flatMap(c => {
      const kinds = [c.content !== undefined, c.old !== undefined && c.new !== undefined, c.delete === true];
      return [
        ...(hubPath.test(c.path) ? [] : [`${c.path}: not a hub file you may change`]),
        ...(kinds.filter(Boolean).length === 1
          ? []
          : [`${c.path}: give exactly one of content, old with new, or delete`]),
      ];
    }),
  ];
};

const apply = (hub: string, changes: Change[]) => {
  const problems: string[] = [];
  for (const c of changes) {
    const path = join(hub, c.path);
    if (c.content !== undefined) write(path, c.content);
    else if (!existsSync(path)) problems.push(`${c.path}: no such file in the hub`);
    else if (c.delete) rmSync(path);
    else {
      const found = read(path).split(c.old!).length - 1;
      if (found === 1)
        writeFileSync(
          path,
          read(path).replace(c.old!, () => c.new!)
        );
      else problems.push(`${c.path}: old snippet found ${found} times, it must be found once`);
    }
  }
  return problems;
};

/** The hub check's problems, empty when the hub loads. */
export const hubProblems = (hub: string) =>
  Effect.runPromise(
    loadHub(hub).pipe(
      Effect.map(() => [] as string[]),
      Effect.catchTag('HubError', e => Effect.succeed(e.problems.map(p => `${p.path}: ${p.message}`)))
    )
  );

const diffOf = (cwd: string) =>
  spawnSync('git', ['diff', '--no-index', '--no-color', 'input/hub', 'hub'], { cwd, encoding: 'utf8' }).stdout;

/**
 * Runs one proposer on a tune dir and writes `cands/<id>/hub` (when valid), `proposal.md`, the prompt and the raw
 * stream. `from` is the incumbent hub, `runs` the incumbent's bench out dir with the fit cases' arm runs.
 */
export const propose = async (o: {
  tune: string;
  id: string;
  proposer: Proposer;
  from: string;
  runs?: string;
  iteration?: number;
  cases?: string;
  model?: string;
}): Promise<Proposal> => {
  const dir = join(o.tune, 'cands', o.id);
  if (existsSync(join(dir, 'proposal.md'))) throw new Error(`${dir} already has a proposal`);
  const tune = JSON.parse(read(join(o.tune, 'tune.json'))) as { cases: Record<string, string> };
  const cases = o.cases ?? [join(o.tune, 'cases'), join(o.tune, '..', 'cases')].find(d => existsSync(d));
  if (!cases) throw new Error(`no cases dir beside ${o.tune}`);
  const split = (s: string) => Object.keys(tune.cases).filter(id => tune.cases[id] === s);
  const iteration = o.iteration ?? 0;
  if (o.proposer !== 'history' && !o.runs) throw new Error(`${o.proposer} needs the incumbent's runs dir`);
  const material =
    o.proposer === 'history'
      ? history(cases, split('mine'), iteration)
      : failures(cases, o.runs!, split('fit'), o.proposer === 'structure');
  const ids = material.map(m => m.id);
  const menu = await Effect.runPromise(loadHub(o.from).pipe(Effect.map(fitting))).catch(() => [...edits]);
  const turn = iteration % edits.length;
  const edit = [...edits.slice(turn), ...edits.slice(0, turn)].find(e => menu.includes(e));
  const before = tried(o.tune);
  const key = JSON.stringify({ proposer: o.proposer, from: relative(o.tune, o.from), ids, edit, tried: before.length });
  const cands = join(o.tune, 'cands');
  const again = (existsSync(cands) ? readdirSync(cands) : []).some(id => read(join(cands, id, 'asked.json')) === key);
  const skip = !ids.length
    ? 'no cases to learn from'
    : o.proposer === 'structure' && !edit
      ? 'no edit of the menu fits the hub'
      : again
        ? 'the same question was answered with nothing before'
        : undefined;
  if (skip) {
    console.error(`${o.id}: skipped, ${skip}`);
    return {
      verdict: 'nothing',
      rationale: skip,
      cases: [],
      changes: [],
      id: o.id,
      proposer: o.proposer,
      usd: 0,
      problems: [],
    };
  }
  const input = join(dir, 'input');
  cpSync(o.from, join(input, 'hub'), { recursive: true });
  for (const m of material)
    for (const [name, text] of Object.entries(m.files)) write(join(input, 'cases', m.id, name), text);
  const instructions = read(here(`proposers/${o.proposer}.md`)).replace('{{edit}}', edit ?? '');
  const heading = o.proposer === 'history' ? 'Merged pull requests' : 'Failing cases';
  const others = o.proposer === 'history' ? '' : unseen(o.runs!, split('validate'));
  const prompt = [
    instructions,
    read(here('proposers/patch.md')),
    `## The hub\n\n${hubText(o.from)}`,
    `## ${heading}\n\n${material.map(m => m.text).join('\n\n') || '(none)'}`,
    ...(others ? [`## Held-out cases\n\nOn the held-out cases this hub is scored on, ${others}`] : []),
    ...(before.length ? [`## Tried before\n\n${before.join('\n')}`] : []),
  ].join('\n\n');
  write(join(input, 'prompt.md'), prompt);

  const hub = join(dir, 'hub');
  const base = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    o.model ?? 'opus',
    '--tools',
    'Read,Grep,Glob',
    '--allowedTools',
    'Read,Grep,Glob',
    '--json-schema',
    JSON.stringify(schema),
    '--setting-sources',
    'local',
    '--strict-mcp-config',
    '--disable-slash-commands',
  ];
  let usd = 0;
  let usage: Usage | undefined;
  let session: string | undefined;
  let answer: Answer = { verdict: 'nothing', rationale: 'no answer', cases: [], changes: [] };
  let problems: string[] = [];
  let ask = prompt;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const stream = await claude(
      [...base, ...(session ? ['--resume', session] : [])],
      ask,
      input,
      join(dir, `stream-${attempt}.jsonl`)
    );
    const result = events(stream).findLast(e => e.type === 'result');
    usd += result?.total_cost_usd ?? 0;
    usage = claudeUsed(stream) ?? usage;
    session = result?.session_id ?? session;
    const got = answerOf(result);
    problems = got
      ? problemsOf(got, ids, Math.min(minCases[o.proposer], ids.length))
      : ['the answer was not the structured output asked for'];
    if (got) answer = { ...got, cases: got.cases ?? [], changes: got.changes ?? [] };
    if (!problems.length && answer.verdict === 'change') {
      rmSync(hub, { recursive: true, force: true });
      cpSync(o.from, hub, { recursive: true });
      problems = apply(hub, answer.changes);
      if (!problems.length) problems = await hubProblems(hub);
      if (!problems.length && !diffOf(dir)) problems = ['the changes leave the hub as it was'];
    }
    if (!problems.length) break;
    ask = `Your proposal has these problems:\n\n${problems.map(p => `- ${p}`).join('\n')}\n\nFix them and answer again in full.`;
  }

  const valid = !problems.length && answer.verdict === 'change';
  if (answer.verdict === 'nothing') write(join(dir, 'asked.json'), key);
  const proposal: Proposal = {
    ...answer,
    id: o.id,
    proposer: o.proposer,
    ...(valid && { hub }),
    usd,
    ...(usage && { usage }),
    problems,
  };
  write(
    join(dir, 'proposal.md'),
    [
      `# ${o.id}, ${o.proposer}`,
      answer.rationale,
      [
        `Verdict: ${answer.verdict}${problems.length ? `, invalid: ${problems.join('; ')}` : ''}`,
        ...(answer.missClass ? [`Miss class: ${answer.missClass}`] : []),
        `Cost: $${usd.toFixed(2)}${usage ? `, Claude 5h ${usage.fiveHour}%, week ${usage.week}%` : ''}`,
      ].join('\n'),
      `## Cases\n\n${answer.cases.map(c => `- ${c.id}: ${c.evidence}`).join('\n') || '(none)'}`,
      ...(valid ? [`## Diff\n\n${fence(diffOf(dir), 'diff')}`] : []),
      `## Raw\n\n${fence(JSON.stringify(answer, null, 2), 'json')}`,
    ].join('\n\n') + '\n'
  );
  return proposal;
};

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      id: { type: 'string' },
      from: { type: 'string' },
      runs: { type: 'string' },
      iteration: { type: 'string', default: '0' },
      cases: { type: 'string' },
      model: { type: 'string' },
    },
  });
  const [tune, proposer] = positionals;
  if (!tune || !['retro', 'history', 'structure'].includes(proposer ?? '') || !values.id || !values.from) {
    console.error(
      'usage: node tune/propose.ts <tune dir> retro|history|structure --id <id> --from <hub> [--runs <dir>]'
    );
    process.exit(2);
  }
  const p = await propose({
    tune: resolve(tune),
    id: values.id,
    proposer: proposer as Proposer,
    from: resolve(values.from),
    iteration: Number(values.iteration),
    ...(values.runs && { runs: resolve(values.runs) }),
    ...(values.cases && { cases: resolve(values.cases) }),
    ...(values.model && { model: values.model }),
  });
  console.log(JSON.stringify({ ...p, hub: p.hub && relative(process.cwd(), p.hub) }, null, 2));
}
