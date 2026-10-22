// The triage brief: the reply the triager posts on the issue, in the fixed template the triage skill gives.
//
//   ## Task
//   ## Criteria        1. <one observable result> Test: it('<title>') in tests/<file>.test.ts
//   ## Files
//   ## Out of scope
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const sections = ['Task', 'Criteria', 'Files', 'Out of scope'];
export const maxCriteria = 5;

const criterionLine = /^(\d+)\.\s+(.+?)\s+Test:\s*`?it\((['"`])(.+?)\3\)`?\s+in\s+`?([^`\s]+?)`?\.?\s*$/;
const comment = /^## @(\S+) at \S+$/gm;

/** The brief's sections by heading, and every heading in the order it appears. */
const split = text => {
  const parts = {};
  const headings = [];
  let at;
  for (const line of text.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      at = heading[1];
      headings.push(at);
      parts[at] = [];
    } else if (at) parts[at].push(line);
  }
  return { parts, headings };
};

const items = lines => lines.map(line => line.trim()).filter(line => /^([-*]|\d+\.)\s/.test(line));

/** Parses a brief. `problems` lists every way it breaks the template. */
export const parseBrief = text => {
  const { parts, headings } = split(text);
  const problems = [];
  const order = headings.filter(h => sections.includes(h));
  if (order.join() !== sections.join())
    problems.push(`the headings must be exactly ${sections.map(s => `"## ${s}"`).join(', ')}, in that order`);
  for (const h of headings) if (!sections.includes(h)) problems.push(`"## ${h}" is not a section of the template`);
  const task = (parts.Task ?? []).join(' ').trim();
  if (!task) problems.push('the task is empty');
  const criteria = [];
  for (const line of items(parts.Criteria ?? [])) {
    const m = criterionLine.exec(line);
    if (!m) {
      problems.push(`a criterion does not end with "Test: it('<title>') in tests/<file>.test.ts": ${line.slice(0, 120)}`);
      continue;
    }
    const [, n, what, , title, file] = m;
    criteria.push({ n: Number(n), text: what, title, file });
    if (!/^tests\/.*\.test\.ts$/.test(file)) problems.push(`criterion ${n} names ${file}, not a test file under tests/`);
  }
  if (!criteria.length && !problems.some(p => p.startsWith('a criterion'))) problems.push('there are no criteria');
  if (criteria.length > maxCriteria) problems.push(`${criteria.length} criteria; split the task to keep at most ${maxCriteria}`);
  const titles = criteria.map(c => c.title);
  for (const title of new Set(titles.filter((t, i) => titles.indexOf(t) !== i)))
    problems.push(`two criteria share the test title "${title}"`);
  const files = items(parts.Files ?? [])
    .map(line => /`([^`]+)`/.exec(line)?.[1])
    .filter(Boolean);
  if (!files.length) problems.push('the files section names no file in backticks');
  const outOfScope = items(parts['Out of scope'] ?? []).map(line => line.replace(/^([-*]|\d+\.)\s+/, ''));
  return { task, criteria, files, outOfScope, problems };
};

const issueNumber = () => {
  const n = process.env.AGENTGRAPH_ISSUE ?? /^agentgraph\/(\d+)$/.exec(process.env.AGENTGRAPH_BRANCH ?? '')?.[1];
  return n && Number(n);
};

/** The local issue files under `$AGENTGRAPH_HUB/issues`. */
const issueFiles = () => {
  if (!process.env.AGENTGRAPH_HUB) return [];
  const dir = join(process.env.AGENTGRAPH_HUB, 'issues');
  try {
    return readdirSync(dir)
      .filter(name => /^\d+-.*\.md$/.test(name))
      .map(name => join(dir, name));
  } catch {
    return [];
  }
};

/** The issue as the agent saw it, from the file `AGENTGRAPH_CONTEXT` names, else the local issue `AGENTGRAPH_ISSUE` (or the `agentgraph/<n>` branch) names. */
export const findIssue = () => {
  if (process.env.AGENTGRAPH_CONTEXT) return readFileSync(process.env.AGENTGRAPH_CONTEXT, 'utf8');
  const n = issueNumber();
  const file = n && issueFiles().find(file => basename(file).startsWith(`${n}-`));
  return file ? readFileSync(file, 'utf8') : undefined;
};

/** The reply of the try, from the file `AGENTGRAPH_REPLY` names. */
export const findReply = () => (process.env.AGENTGRAPH_REPLY ? readFileSync(process.env.AGENTGRAPH_REPLY, 'utf8') : undefined);

/** The last timeline entry of a context file that holds a brief, without its `@author: ` lead. */
const briefInContext = source =>
  source
    .slice(source.indexOf('\n## Timeline\n') + 1)
    .split(/\n\n(?=(?:#\d+ )?(?:@\S+[ :]|check \S+: ))/)
    .map(entry => entry.replace(/^(?:#\d+ )?@[^\s:]+: /, ''))
    .reverse()
    .find(body => /^## Criteria\s*$/m.test(body))
    ?.trim();

/** The last comment on a local issue file that holds a brief. */
const briefIn = source => {
  if (process.env.AGENTGRAPH_CONTEXT) return briefInContext(source);
  const heads = [...source.matchAll(comment)];
  const bodies = heads.map((h, i) => source.slice(h.index + h[0].length, heads[i + 1]?.index ?? source.length));
  return bodies.reverse().find(body => /^## Criteria\s*$/m.test(body))?.trim();
};

/**
 * Finds the brief for this run: the file `AGENTGRAPH_BRIEF` names, or the last comment holding one in the context file
 * `AGENTGRAPH_CONTEXT` names, or the local issue `AGENTGRAPH_ISSUE` (or the `agentgraph/<n>` branch) names under
 * `$AGENTGRAPH_HUB/issues`, or else the one open local issue labeled `ready`.
 */
export const findBrief = () => {
  if (process.env.AGENTGRAPH_BRIEF) return readFileSync(process.env.AGENTGRAPH_BRIEF, 'utf8');
  if (process.env.AGENTGRAPH_CONTEXT || issueNumber()) {
    const source = findIssue();
    return source && briefIn(source);
  }
  const ready = issueFiles()
    .map(file => readFileSync(file, 'utf8'))
    .filter(source => /^state:\s*open\s*$/m.test(source) && /^labels:.*\bready\b/m.test(source))
    .map(briefIn)
    .filter(Boolean);
  return ready.length === 1 ? ready[0] : undefined;
};
