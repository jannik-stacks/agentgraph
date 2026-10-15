import { userInfo } from 'node:os';
import { join } from 'node:path';
import { localIssues } from './issues-local.ts';
import type { Issues } from './issues.ts';
import { commentOn, pullsFile } from './pulls.ts';

/** Who writes from this machine: the local operator. */
export const operator = () => {
  try {
    return userInfo().username || 'human';
  } catch {
    return 'human';
  }
};

/** Where a conversation happens: an issue or a merge request of a repository. */
export type Thread = { repo: string; issue?: number; pull?: number };

/** One message in a thread, with whether the source trusts its author to start work. */
export type Message = { thread: Thread; author: string; trusted: boolean; text: string };

/**
 * A message source bothub answers in: GitHub, the local forge, later Slack. Incoming messages arrive through the
 * source's own transport and go to `hear` (see `ops.ts`); `post` writes in a thread, as `author` where the source can
 * write as someone other than the bot.
 */
export type Channel = { post: (thread: Thread, text: string, author?: string) => Promise<void> };

/** The local forge: issue files under `<hub>/issues` and merge requests in `<data>/pulls.jsonl`. */
export const localChannel = ({ hub, data }: { hub: string; data: string }): Channel => ({
  post: async (thread, text, author = 'bothub[bot]') => {
    if (thread.pull !== undefined) await commentOn(pullsFile(data), thread.pull, { author, body: text });
    else if (thread.issue !== undefined)
      await localIssues(join(hub, 'issues'), { repo: thread.repo, as: author }).comment(thread.issue, text);
    else throw new Error('a thread names an issue or a merge request');
  },
});

/** A channel that posts through an issue tracker as the bot, where issues and requests share one comment thread. */
export const trackerChannel = (issues: (repo: string) => Promise<Issues | undefined>): Channel => ({
  post: async (thread, text) => {
    const number = thread.pull ?? thread.issue;
    const tracker = await issues(thread.repo);
    if (number === undefined || !tracker) throw new Error(`cannot post in ${thread.repo}`);
    await tracker.comment(number, text);
  },
});
