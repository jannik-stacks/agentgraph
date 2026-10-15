import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Document, isScalar, visit } from 'yaml';
import { z } from 'zod';
import { matches, type Comment, type Issue, type Issues } from './issues.ts';
import { parseMarkdown } from './markdown.ts';
import { IssueFile } from './schema.ts';

const fileName = /^(\d+)-[a-z0-9-]*\.md$/;

/** The number of a new issue: one above the highest of the numbered issue file names. */
const nextIssueNumber = (names: string[]) =>
  Math.max(0, ...names.map(name => Number(/^(\d+)-/.exec(name)?.[1] ?? 0))) + 1;
const commentHeading = /^## @(\S+) at (\d{4}-\d\d-\d\dT[\d:.]+Z)$/gm;

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 50)
    .replace(/^-+|-+$/g, '') || 'issue';

/** Parses one `<n>-<slug>.md` issue file. Comments are `## @<author> at <ISO time>` sections after the body. */
export const parseIssue = (file: string, source: string): Issue => {
  const number = Number(fileName.exec(file)?.[1]);
  if (!number) throw new Error(`${file}: issue files are named <number>-<slug>.md`);
  const { data, body } = parseMarkdown(source);
  const parsed = IssueFile.safeParse(data ?? {});
  if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
  const heads = [...body.matchAll(commentHeading)];
  const comments: Comment[] = heads.map((head, i) => ({
    author: head[1] ?? '',
    ts: head[2] ?? '',
    body: body.slice((head.index ?? 0) + head[0].length, heads[i + 1]?.index ?? body.length).trim(),
    url: `issues/${file}#comment-${i + 1}`,
  }));
  return {
    number,
    ...parsed.data,
    body: body.slice(0, heads[0]?.index ?? body.length).trim(),
    comments,
    url: `issues/${file}`,
  };
};

/** Renders an issue back to its file, the inverse of `parseIssue`. */
export const renderIssue = ({ title, state, labels, author, parent, links, changes, human, body, comments }: Issue) => {
  const data = { title, state, labels, author, parent, links, changes, human };
  const doc = new Document(Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
  visit(doc, {
    Seq: (_, seq) => {
      seq.flow = seq.items.every(isScalar);
    },
    Map: (_, map) => {
      map.flow = map !== doc.contents;
    },
  });
  const front = doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
  const sections = comments.map(c => `## @${c.author} at ${c.ts}\n\n${c.body.trim()}`);
  return `---\n${front}---\n\n${[body.trim(), ...sections].filter(Boolean).join('\n\n')}\n`;
};

/**
 * Issues as Markdown files in `<dir>/<n>-<slug>.md`, written as `as`. Numbers only grow: the next is one above the
 * highest file, claimed with an exclusive `.<n>.lock` so concurrent writers on one directory never share a number,
 * and issues are closed rather than deleted. Labels and closes made here are recorded under `changes` and attributed to
 * `as`; a change without a record is a hand edit, attributed to the issue's author. Authors ending in `[bot]` count as
 * untrusted (`NONE`), everyone else as `OWNER`, since writing to the hub already takes repository access.
 */
export const localIssues = (dir: string, { as = 'bothub[bot]' }: { repo: string; as?: string }): Issues => {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>) => {
    const next = queue.catch(() => {}).then(task);
    queue = next;
    return next;
  };
  const files = async () => (await readdir(dir).catch(() => [])).filter(name => fileName.test(name)).sort();
  const all = async () =>
    Promise.all((await files()).map(async name => parseIssue(name, await readFile(join(dir, name), 'utf8'))));
  const find = async (number: number) => (await files()).find(name => fileName.exec(name)?.[1] === String(number));
  const get = async (number: number) => {
    const name = await find(number);
    return name ? parseIssue(name, await readFile(join(dir, name), 'utf8')) : undefined;
  };
  const save = async (issue: Issue) => {
    const name = (await find(issue.number)) ?? `${issue.number}-${slugify(issue.title)}.md`;
    const tmp = join(dir, `.${name}.tmp`);
    await writeFile(tmp, renderIssue(issue));
    await rename(tmp, join(dir, name));
    return parseIssue(name, renderIssue(issue));
  };
  const update = (number: number, change: (issue: Issue) => Issue) =>
    serial(async () => {
      const issue = await get(number);
      if (!issue) throw new Error(`no issue #${number}`);
      return save(change(issue));
    });

  const claim = (number: number) =>
    open(join(dir, `.${number}.lock`), 'wx').then(
      file => file.close().then(() => true),
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') return false;
        throw error;
      }
    );

  const record = (issue: Issue, entries: NonNullable<Issue['changes']>) =>
    entries.length ? { changes: [...(issue.changes ?? []), ...entries] } : {};

  return {
    backend: 'local',
    list: async filter => (await all()).filter(issue => matches(issue, filter)).map(i => ({ ...i, comments: [] })),
    get,
    create: ({ title, body = '', labels = [], parent, links }) =>
      serial(async () => {
        await mkdir(dir, { recursive: true });
        for (let number = nextIssueNumber(await files()); ; number++) {
          if (!(await claim(number))) continue;
          try {
            if (await find(number)) continue;
            return await save({
              number,
              title,
              state: 'open',
              labels,
              author: as,
              ...(parent !== undefined && { parent }),
              ...(links?.length && { links }),
              body,
              comments: [],
            });
          } finally {
            await rm(join(dir, `.${number}.lock`), { force: true });
          }
        }
      }),
    comment: async (number, body) => {
      const issue = await update(number, i => ({
        ...i,
        comments: [...i.comments, { author: as, ts: new Date().toISOString(), body }],
      }));
      return issue.comments.at(-1) as Comment;
    },
    label: async (number, { add = [], remove = [] }) => {
      await update(number, i => ({
        ...i,
        labels: [...new Set([...i.labels, ...add])].filter(l => !remove.includes(l)),
        ...record(
          i,
          add
            .filter(l => !i.labels.includes(l) && !remove.includes(l))
            .map(label => ({ by: as, action: 'labeled' as const, label }))
        ),
      }));
    },
    close: async number => {
      await update(number, i => ({
        ...i,
        state: 'closed',
        ...record(i, i.state === 'closed' ? [] : [{ by: as, action: 'closed' }]),
      }));
    },
    link: async (parent, child) => {
      if (!(await get(parent))) throw new Error(`no issue #${parent}`);
      await update(child, i => ({ ...i, parent }));
    },
  };
};
