/**
 * Benchmarks the tune-graph skill against the tune loop. The skill tune starts from the loop tune's cases, point,
 * engine and minimal hub; each round a `claude -p` session with the skill proposes hubs in a workspace that holds only
 * the incumbent, the fit and mine cases and the tune's history, and `step` evaluates them as the loop does.
 *
 *   node tune/skill.ts <loop tune dir> --version 1 [--name skill@1] [--rounds 6] [--k 4] [--parallel 6] [--keys f]
 *     [--max-codex 25] [--max-claude-5h 40] [--max-claude-week 12] [--stop-claude-5h 100] [--stop-claude-week 100]
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { codexUsed } from '../bin/bench.ts';
import { checkpoint, guard, init, propose, type Split, type Step, step, tuneRows } from '../bin/tune.ts';
import { claudeUsed, events, hubProblems, type Usage } from './propose.ts';

type Io = Parameters<typeof step>[2];
type Limits = { codex: number; claude5h: number; claudeWeek: number };
type Options = {
  version: string;
  name?: string;
  rounds: number;
  k: number;
  parallel: number;
  limits: Limits;
  stop: { fiveHour: number; week: number };
  keys?: string;
  model?: string;
};
/** One skill session, `skill/r<iteration>/round.json`; written once its proposals are queued. */
type Round = {
  iteration: number;
  version: string;
  skill: string;
  session?: string;
  usd: number;
  minutes: number;
  claude: { before?: Usage; after?: Usage };
  slots: { slot: string; id?: string; problems?: string[] }[];
  leaks: string[];
  stopped?: string;
};

const agentgraph = join(import.meta.dirname, '..');
const skillDir = join(agentgraph, 'skills/tune-graph');
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const save = (path: string, v: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, typeof v === 'string' ? v : `${JSON.stringify(v, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
};
const pad = (n: number) => String(n).padStart(3, '0');
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const fence = (text: string, lang = '') => `\`\`\`${lang}\n${text.replaceAll('```', "'''")}\n\`\`\``;
const idsOf = (cases: Record<string, Split>, ...splits: Split[]) =>
  Object.keys(cases)
    .filter(id => splits.includes(cases[id]!))
    .sort();
const skillSha = () =>
  createHash('sha256')
    .update(read(join(skillDir, 'SKILL.md')))
    .digest('hex')
    .slice(0, 12);

/** Copies the loop tune's settings, cases and minimal hub into `skill@<version>` and scores that hub as the start. */
const start = async (like: string, o: Pick<Options, 'version' | 'name' | 'parallel' | 'keys'>, io?: Io) => {
  const { tune: t, steps } = tuneRows(like);
  const first = steps.find(s => s.iteration === 0);
  if (!first) throw new Error(`${like} has no starting hub yet`);
  const name = o.name ?? `skill@${o.version}`;
  const dir = join(dirname(like), name);
  if (!existsSync(join(dir, 'tune.json'))) {
    cpSync(join(like, 'cases'), join(dir, 'cases'), { recursive: true });
    cpSync(join(like, 'cands', first.id, 'hub'), join(dir, 'cands/i000-init/hub'), { recursive: true });
    for (const id of idsOf(t.cases, 'fit', 'validate').filter(id => existsSync(join(like, 'runs', first.id, id))))
      cpSync(join(like, 'runs', first.id, id), join(dir, 'runs/i000-init', id), {
        recursive: true,
        filter: src => !skipped.has(basename(src)),
      });
    spawnSync('git', ['init', '-q', '--bare', join(dir, 'hub.git')]);
    save(join(dir, 'tune.json'), t);
  }
  const made = await init(
    t.repo.split('/').pop()!,
    { cases: '', splits: '', repos: '', point: t.point, name, parallel: o.parallel, ...(o.keys && { keys: o.keys }) },
    io
  );
  if (resolve(made) !== resolve(dir)) throw new Error(`${like} is not under the tune root ${dirname(dirname(made))}`);
  return dir;
};

const skipped = new Set(['tree', 'forge', 'homes', 'mirror.git', 'work', 'index', '.locks', 'news', 'logs']);

/** The round's workspace: the incumbent hub, fit and mine cases, the incumbent's fit runs, the history and `k` slots. */
const workspace = (dir: string, w: string, k: number) => {
  const { tune: t, steps } = tuneRows(dir);
  const inc = steps.filter(s => s.verdict === 'kept').at(-1)!;
  const seen = idsOf(t.cases, 'mine', 'fit');
  const hidden = idsOf(t.cases, 'validate', 'test');
  const redact = (text: string) => hidden.reduce((s, id) => s.replaceAll(id, 'a held-out case'), text);
  cpSync(join(dir, 'cands', inc.id, 'hub'), join(w, 'hub'), { recursive: true });
  for (const id of seen) cpSync(join(dir, 'cases', id), join(w, 'cases', id), { recursive: true });
  save(join(w, 'cases.json'), Object.fromEntries(seen.map(id => [id, t.cases[id]])));
  for (const id of idsOf(t.cases, 'fit')) {
    const from = join(dir, 'runs', inc.id, id);
    if (existsSync(from))
      cpSync(from, join(w, 'runs', id), { recursive: true, filter: src => !skipped.has(basename(src)) });
  }
  const tried = steps
    .filter(s => s.iteration > 0)
    .map(s =>
      [
        `## ${s.id}, ${s.proposer}, ${s.verdict}`,
        redact(s.why),
        redact(s.rationale),
        ...(s.diff ? [fence(s.diff, 'diff')] : []),
      ].join('\n\n')
    );
  save(
    join(w, 'tried.md'),
    `# Tried before\n\nThe incumbent is ${inc.id}.\n\n${tried.join('\n\n') || 'Nothing yet.'}\n`
  );
  for (let n = 1; n <= k; n++) cpSync(join(w, 'hub'), join(w, 'out', `d${n}`, 'hub'), { recursive: true });
};

/** Each slot with a why and a change, and the problems that keep a slot from being queued. */
const slotsOf = async (w: string) =>
  Promise.all(
    readdirSync(join(w, 'out'))
      .filter(n => existsSync(join(w, 'out', n, 'hub')))
      .sort()
      .map(async slot => {
        const at = join(w, 'out', slot);
        const why = read(join(at, 'why.md')).trim();
        const diff = spawnSync('git', ['diff', '--no-index', '--stat', join(w, 'hub'), join(at, 'hub')], {
          encoding: 'utf8',
        }).stdout;
        if (!why && !diff) return { slot, hub: join(at, 'hub'), why, problems: [], empty: true };
        const problems = [
          ...(why ? [] : ['no why.md']),
          ...(diff ? [] : ['the hub is unchanged']),
          ...(diff ? await hubProblems(join(at, 'hub')) : []),
        ];
        return { slot, hub: join(at, 'hub'), why, problems, empty: false };
      })
  );

type Live = { usage?: Usage; first?: Usage; stopped?: string };

/** Runs one claude session in the workspace, stopping it when a reading passes a cap. */
const session = (
  w: string,
  args: string[],
  prompt: string,
  log: string,
  over: (u: Usage) => string | undefined,
  live: Live
) =>
  new Promise<string>((done, fail) => {
    const child = spawn(process.env.AGENTGRAPH_CLAUDE ?? 'claude', args, {
      cwd: w,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const timer = setTimeout(() => {
      live.stopped = 'the session ran past 60 minutes';
      child.kill();
    }, 60 * 60_000);
    let out = '';
    let partial = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      writeFileSync(log, d, { flag: 'a' });
      const lines = (partial + d.toString()).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines.filter(l => l.includes('rate_limit_event'))) {
        const u = claudeUsed(line);
        if (!u) continue;
        live.first ??= u;
        live.usage = u;
        const why = over(u);
        if (why && !live.stopped) {
          live.stopped = why;
          child.kill();
        }
      }
    });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', fail);
    child.on('close', code => {
      clearTimeout(timer);
      if (out.includes('"type":"result"') || live.stopped) done(out);
      else fail(new Error(`claude exited ${code}: ${err.slice(-500)}`));
    });
    child.stdin.end(prompt);
  });

/** Tool calls that name a held-out case or a path of the tune outside the workspace. */
const leaksOf = (stream: string, dir: string, w: string, hidden: string[]) =>
  events(stream).flatMap(e => {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) return [];
    return (e.message.content as { type?: string; name?: string; input?: unknown }[])
      .filter(c => c.type === 'tool_use')
      .flatMap(c => {
        const text = JSON.stringify(c.input ?? {});
        const ids = hidden.filter(id => text.includes(id));
        const paths = [...text.matchAll(new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"\\s]*`, 'g'))]
          .map(m => m[0])
          .filter(p => !p.startsWith(w));
        return ids.length || paths.length ? [`${c.name}: ${[...ids, ...paths].join(', ')}`] : [];
      });
  });

const pluginOf = (dir: string) => {
  const plugin = join(dir, 'skill', 'plugin');
  save(join(plugin, '.claude-plugin/plugin.json'), { name: 'agentgraph' });
  cpSync(skillDir, join(plugin, 'skills/tune-graph'), { recursive: true });
  return plugin;
};

const promptOf = (iteration: number, o: Options) =>
  `Use the agentgraph:tune-graph skill in benchmark mode. This is round ${iteration} of ${o.rounds}. ` +
  `The workspace is the current folder: start with tried.md and cases.json. Fill at most ${o.k} slots ` +
  `(out/d1 to out/d${o.k}), each a different direction, and answer with one line per slot.`;

/** Readings past a cap: the loop's caps as points over the tune's first reading, and the absolute stops. */
const overOf = (dir: string, o: Options) => (u: Usage) => {
  const b = JSON.parse(read(join(dir, 'budget.json')) || '{}') as {
    claude?: { fiveHour?: { start: number }; week?: { start: number } };
  };
  const start5 = b.claude?.fiveHour?.start ?? u.fiveHour;
  const startW = b.claude?.week?.start ?? u.week;
  if (u.fiveHour >= o.stop.fiveHour) return `Claude 5h at ${u.fiveHour}%, the stop is ${o.stop.fiveHour}%`;
  if (u.week >= o.stop.week) return `Claude week at ${u.week}%, the stop is ${o.stop.week}%`;
  if (u.fiveHour - start5 > o.limits.claude5h) return `Claude 5h ${u.fiveHour}% is past ${o.limits.claude5h} points`;
  if (u.week - startW > o.limits.claudeWeek) return `Claude week ${u.week}% is past ${o.limits.claudeWeek} points`;
  return undefined;
};

/** One round: the skill session in a fresh workspace, its hubs checked and queued as `skill` candidates. */
const ask = async (dir: string, iteration: number, o: Options, io?: Io): Promise<Round> => {
  const budget = guard(dir, { codex: io?.codex ?? codexUsed }, o.limits);
  const before =
    budget.claude?.fiveHour && budget.claude.week
      ? { fiveHour: budget.claude.fiveHour.now, week: budget.claude.week.now }
      : undefined;
  const over = overOf(dir, o);
  const pre = before && over(before);
  if (pre) throw new Error(pre);
  const w = join(dir, 'skill', `r${pad(iteration)}`);
  if (existsSync(w)) renameSync(w, `${w}.${Date.now()}`);
  workspace(dir, w, o.k);
  const hidden = idsOf(tuneRows(dir).tune.cases, 'validate', 'test');
  const live: Live = {};
  const r: Round = {
    iteration,
    version: o.version,
    skill: skillSha(),
    usd: 0,
    minutes: 0,
    claude: { ...(before && { before }) },
    slots: [],
    leaks: [],
  };
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    o.model ?? 'opus',
    '--restricted',
    '--plugin-dir',
    pluginOf(dir),
    '--tools',
    'Read,Grep,Glob,Edit,Write,Agent,Skill',
    '--permission-mode',
    'acceptEdits',
    '--strict-mcp-config',
  ];
  const began = Date.now();
  let prompt = promptOf(iteration, o);
  let slots: Awaited<ReturnType<typeof slotsOf>> = [];
  for (let attempt = 1; attempt <= 2 && !live.stopped; attempt++) {
    const stream = await session(
      w,
      [...args, ...(r.session ? ['--resume', r.session] : [])],
      prompt,
      join(w, `stream-${attempt}.jsonl`),
      over,
      live
    );
    const result = events(stream).findLast(e => e.type === 'result');
    const id = result?.session_id ?? events(stream).find(e => e.session_id)?.session_id;
    if (id) r.session = id;
    r.usd = round3(r.usd + (result?.total_cost_usd ?? 0));
    r.leaks.push(...leaksOf(stream, dir, w, hidden));
    slots = await slotsOf(w);
    const bad = slots.filter(s => !s.empty && s.problems.length);
    if (!bad.length || !r.session) break;
    prompt = `The harness found these problems; fix them in place:\n\n${bad.map(s => `- out/${s.slot}: ${s.problems.join('; ')}`).join('\n')}`;
  }
  r.minutes = round3((Date.now() - began) / 60_000);
  const after = live.usage;
  const first = before ?? live.first;
  r.claude = { ...(first && { before: first }), ...(after && { after }) };
  if (live.stopped) {
    save(join(w, 'stopped.json'), { ...r, stopped: live.stopped });
    throw new Error(`round ${iteration} stopped: ${live.stopped}`);
  }
  if (r.leaks.length) console.error(`round ${iteration}: tool calls outside the workspace\n${r.leaks.join('\n')}`);
  for (const s of slots.filter(s => !s.empty)) {
    if (s.problems.length) {
      r.slots.push({ slot: s.slot, problems: s.problems });
      continue;
    }
    const c = propose(dir, s.hub, s.why, 'skill');
    r.slots.push({ slot: s.slot, id: c.id });
  }
  if (after) guard(dir, { codex: io?.codex ?? codexUsed }, o.limits, after);
  save(join(w, 'round.json'), r);
  return r;
};

/** Claude 5h points of a round, shared evenly by the candidates it queued. */
const claudeOf = (r: Round) => {
  const queued = r.slots.flatMap(s => (s.id ? [s.id] : []));
  const used = r.claude.before && r.claude.after ? Math.max(0, r.claude.after.fiveHour - r.claude.before.fiveHour) : 0;
  return Object.fromEntries(queued.map(id => [id, round3(used / queued.length)]));
};

const rounds = (dir: string) =>
  (existsSync(join(dir, 'skill')) ? readdirSync(join(dir, 'skill')) : [])
    .filter(n => /^r\d+$/.test(n) && existsSync(join(dir, 'skill', n, 'round.json')))
    .map(n => JSON.parse(read(join(dir, 'skill', n, 'round.json'))) as Round);

const flatSince = (steps: Step[]) => {
  const its = [...new Set(steps.filter(s => s.iteration > 0).map(s => s.iteration))].sort((a, b) => b - a);
  const i = its.findIndex(n => steps.some(s => s.iteration === n && s.verdict === 'kept'));
  return i === -1 ? its.length : i;
};

/**
 * Runs the skill until `rounds`, three rounds in a row keep nothing, a round proposes nothing, or a cap stops it.
 * Resumes from the tune dir: a round with a `round.json` is not asked again, its queued candidates are evaluated.
 */
export const skill = async (like: string, o: Options, io?: Io) => {
  const dir = await start(like, o, io);
  const sha = skillSha();
  const pinned = rounds(dir).find(r => r.skill !== sha);
  if (pinned) throw new Error(`SKILL.md changed since round ${pinned.iteration}: start a new --version`);
  for (;;) {
    const { steps } = tuneRows(dir);
    const iteration = Math.max(0, ...steps.map(s => s.iteration)) + 1;
    if (iteration > o.rounds || flatSince(steps) >= 3) break;
    const done = rounds(dir).find(r => r.iteration === iteration);
    const r = done ?? (await ask(dir, iteration, o, io));
    const made = await step(
      dir,
      {
        k: o.k,
        proposers: ['manual'],
        parallel: o.parallel,
        limits: o.limits,
        claude: claudeOf(r),
        ...(o.keys && { keys: o.keys }),
      },
      io
    );
    if (!made.length) break;
    const kept = tuneRows(dir).steps.filter(s => s.verdict === 'kept').length;
    if (made.some(s => s.verdict === 'kept') && kept % 3 === 1) await checkpoint(dir, o, io);
  }
  return dir;
};

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      version: { type: 'string' },
      name: { type: 'string' },
      rounds: { type: 'string', default: '6' },
      k: { type: 'string', default: '4' },
      parallel: { type: 'string', default: '6' },
      model: { type: 'string' },
      keys: { type: 'string' },
      'max-codex': { type: 'string', default: '25' },
      'max-claude-5h': { type: 'string', default: '40' },
      'max-claude-week': { type: 'string', default: '12' },
      'stop-claude-5h': { type: 'string', default: '100' },
      'stop-claude-week': { type: 'string', default: '100' },
    },
  });
  const [like] = positionals;
  if (!like || !values.version) {
    console.error('usage: node tune/skill.ts <loop tune dir> --version <v> [--rounds 6] [--k 4]');
    process.exit(2);
  }
  console.log(
    await skill(resolve(like), {
      version: values.version,
      ...(values.name && { name: values.name }),
      rounds: Number(values.rounds),
      k: Number(values.k),
      parallel: Number(values.parallel),
      limits: {
        codex: Number(values['max-codex']),
        claude5h: Number(values['max-claude-5h']),
        claudeWeek: Number(values['max-claude-week']),
      },
      stop: { fiveHour: Number(values['stop-claude-5h']), week: Number(values['stop-claude-week']) },
      ...(values.keys && { keys: resolve(values.keys) }),
      ...(values.model && { model: values.model }),
    })
  );
}
