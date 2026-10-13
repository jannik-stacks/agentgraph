import { userInfo } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { compile, type Config } from './config.ts';
import { localIssues } from './issues-local.ts';
import { readHub } from './load.ts';
import { Missing, commentOn, localPull, pullsFile } from './pulls.ts';
import { type Continue, Review } from './schema.ts';

/** Input that does not describe a comment. */
export class Invalid extends Error {}

/** Who writes from this machine: the local operator, trusted like a repository owner. */
export const operator = () => {
  try {
    return userInfo().username || 'human';
  } catch {
    return 'human';
  }
};

/** The comment command of `workflow`, or of the first workflow that has one. */
export const commandOf = (config: Config, workflow?: string): string | undefined => {
  const commands = (only?: string) =>
    Object.values(config.workflows)
      .filter(w => only === undefined || w.name === only)
      .flatMap(w => w.on.issue_comment?.command ?? []);
  return commands(workflow)[0] ?? commands()[0];
};

/** The comment text that continues the bot as `how` says: the command, its rerun word, then what was said. */
export const continueText = (command: string | undefined, how: Continue, said: string) => {
  if (how === 'none') return said;
  if (!command) throw new Invalid('no workflow starts on a comment command');
  return [command, how === 'changed' ? '' : how, said].filter(Boolean).join(' ');
};

/**
 * Writes a human's comment to the local backend of the hub in `dir` with data in `data`: line comments then the
 * comment on a merge request's op log, or the comment in an issue's file, as the local operator. Unless `continue` is
 * `none`, the comment carries the workflow's command, so the served hub picks it up as one event and continues once.
 * Throws {@link Invalid} for bad input and {@link Missing} for an unknown merge request or issue.
 */
export const comment = async ({ dir, data }: { dir: string; data: string }, input: unknown) => {
  const parsed = Review.safeParse(input);
  if (!parsed.success) throw new Invalid(z.prettifyError(parsed.error));
  const { pull, issue, body, lines, continue: how } = parsed.data;
  const author = operator();
  const compiled = compile(await readHub(dir));
  if (!compiled.ok && how !== 'none')
    throw new Invalid(`the hub does not compile: ${compiled.errors.map(e => `${e.path}: ${e.message}`).join('; ')}`);
  const config = compiled.ok ? compiled.config : undefined;
  if (pull !== undefined) {
    const file = pullsFile(data);
    const opened = await localPull(file, pull);
    const workflow = opened.origin?.job.split('/')[0];
    const text = continueText(config && commandOf(config, workflow), how, body);
    await commentOn(
      file,
      pull,
      ...lines.map(({ body, ...at }) => ({ author, body, ...at })),
      ...(text ? [{ author, body: text }] : [])
    );
    return { text };
  }
  const issues = localIssues(join(dir, 'issues'), { repo: 'local/hub', as: author });
  if (!(await issues.get(issue!))) throw new Missing(`no issue #${issue}`);
  const text = continueText(config && commandOf(config), how, body);
  await issues.comment(issue!, text);
  return { text };
};
