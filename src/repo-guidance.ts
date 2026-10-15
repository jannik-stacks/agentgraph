import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { effectiveRun, type Config, type Defined } from './config.ts';
import { supports } from './harnesses/supports.ts';
import type { Bot, Load, LoadEntry } from './schema.ts';

export type Loaded = {
  kind: 'instruction' | 'skill' | 'tool' | 'mcp';
  name: string;
  source: 'hub' | 'repo';
  shadowed?: true;
};

/** The repo's instruction files and skill directories a run's harness loads, and the repo skills a hub skill shadows. */
export type RepoFiles = { instructions: string[]; skills: string[]; shadowed: string[] };

const skillRoots = ['.agents/skills', '.claude/skills', '.opencode/skills'];

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  );

/**
 * The repo's own files a harness loads from the checkout at `cwd` for the `loads` entries: AGENTS.md and CLAUDE.md
 * (once when their text is the same), and the skills `skills` or `skills/<name>` ask for, except those a hub skill of
 * the same name shadows.
 * @throws when a named skill is not in the repo.
 */
export const repoFiles = async (cwd: string, loads: LoadEntry[], hubSkills: string[]): Promise<RepoFiles> => {
  const seen = new Set<string>();
  const instructions: string[] = [];
  for (const file of loads.includes('instructions') ? ['AGENTS.md', 'CLAUDE.md'] : []) {
    const text = (await readFile(join(cwd, file), 'utf8').catch(() => undefined))?.trim();
    if (text === undefined || seen.has(text)) continue;
    seen.add(text);
    instructions.push(file);
  }
  const named = loads.flatMap(entry => (entry.startsWith('skills/') ? [entry.slice('skills/'.length)] : []));
  const all = loads.includes('skills');
  const found = new Map<string, string>();
  for (const root of all || named.length ? skillRoots : [])
    for (const name of await readdir(join(cwd, root)).catch(() => [] as string[]))
      if ((all || named.includes(name)) && !found.has(name) && (await exists(join(cwd, root, name, 'SKILL.md'))))
        found.set(name, `${root}/${name}`);
  for (const name of named)
    if (!found.has(name)) throw new Error(`loads "skills/${name}": no such skill in ${skillRoots.join(', ')}`);
  const shadowed = [...found].filter(([name]) => hubSkills.includes(name)).map(([, dir]) => dir);
  return { instructions, skills: [...found.values()].filter(dir => !shadowed.includes(dir)), shadowed };
};

/** Everything a run loads with where it came from: the hub's bot, skills, tools and MCP server, and the repo's files. */
export const loadedItems = (
  { bot, skills, tools, mcp }: { bot: string; skills: string[]; tools: string[]; mcp: boolean },
  repo: RepoFiles | undefined
): Loaded[] => [
  { kind: 'instruction', name: bot, source: 'hub' },
  ...skills.map((name): Loaded => ({ kind: 'skill', name, source: 'hub' })),
  ...tools.map((name): Loaded => ({ kind: 'tool', name, source: 'hub' })),
  ...(mcp ? [{ kind: 'mcp', name: 'bothub', source: 'hub' } as const] : []),
  ...(repo?.instructions ?? []).map((name): Loaded => ({ kind: 'instruction', name, source: 'repo' })),
  ...(repo?.skills ?? []).map((name): Loaded => ({ kind: 'skill', name, source: 'repo' })),
  ...(repo?.shadowed ?? []).map((name): Loaded => ({ kind: 'skill', name, source: 'repo', shadowed: true })),
];

/** The repo files a bot's harness loads in the checkout at `cwd`: what `loads` names, as far as the harness supports. */
export const repoFor = async (config: Config, bot: Defined<Bot> | undefined, cwd: string) => {
  if (!bot) return;
  const supported = supports[bot.harness];
  const entries = effectiveRun(config.hub, bot).loads.filter(entry => supported.includes(entry.split('/')[0] as Load));
  return repoFiles(cwd, entries, Object.keys(config.skills));
};
