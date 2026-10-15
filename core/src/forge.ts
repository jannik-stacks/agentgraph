import { Context, Data, Layer, type Effect, type Redacted, type Stream } from 'effect';
import { todo, todoStream } from './todo.ts';

/** An issue or a pull request, as GitHub returns it. `pull` is set on pull requests. */
export type Thread = {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  labels: string[];
  author: string;
  parent?: number;
  pull?: { branch: string; into: string; head: string };
  url: string;
};

export type Comment = { id: string; author: string; body: string; at: string; path?: string; line?: number };

/** Something a person or a bot said or did on a thread. */
export type Message = {
  thread: number;
  kind: 'comment' | 'approved' | 'changes' | 'merged' | 'closed' | 'label';
  actor: string;
  trusted: boolean;
  at: string;
  comment?: Comment;
  label?: string;
};

/** What a run may change on the repo, and the two proposals that steer the run. */
export type Proposal =
  | { kind: 'reply'; body: string }
  | { kind: 'label'; add?: string[]; remove?: string[] }
  | { kind: 'push'; branch: string; message: string }
  | { kind: 'pull'; branch: string; into: string; title: string; body: string }
  | { kind: 'merge'; number: number; head: string }
  | { kind: 'issue'; title: string; body: string; parent?: number }
  | { kind: 'ask'; question: string }
  | { kind: 'back'; why: string };

export type Applied = { proposal: Proposal; ok: boolean; url?: string; reason?: string };

export class ForgeError extends Data.TaggedError('ForgeError')<{ status?: number; message: string }> {}

/** The repo as the state: GitHub in production, a JSON file in tests. */
export class Forge extends Context.Tag('bothub/Forge')<
  Forge,
  {
    threads: (filter?: Partial<Pick<Thread, 'state' | 'labels' | 'parent'>>) => Effect.Effect<Thread[], ForgeError>;
    thread: (number: number) => Effect.Effect<Thread & { comments: Comment[] }, ForgeError>;
    since: (cursor: string) => Stream.Stream<Message, ForgeError>;
    apply: (number: number, proposal: Proposal, dir?: string) => Effect.Effect<Applied, ForgeError>;
  }
>() {}

const stub = (name: string): Forge['Type'] => ({
  threads: () => todo(`${name}.threads`),
  thread: () => todo(`${name}.thread`),
  since: () => todoStream(`${name}.since`),
  apply: () => todo(`${name}.apply`),
});

/** GitHub through an App installation, polled with ETags. */
export const githubForge = (_app: { repo: string; id: string; key: Redacted.Redacted }): Layer.Layer<Forge> =>
  Layer.succeed(Forge, stub('githubForge'));

/** Threads, comments and applied proposals in one JSON file. */
export const fileForge = (_file: string): Layer.Layer<Forge> => Layer.succeed(Forge, stub('fileForge'));
