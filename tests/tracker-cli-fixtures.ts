import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { afterEach } from 'vitest';
import { folderTracker, Tracker, writeIssueFile } from '../src/tracker.ts';
import { mergePull, writeClosed, writeComment, writeReview } from '../src/instance.ts';
import { formatIssueList, formatIssueTimeline } from '../src/status.ts';
import { type Instruction } from '../src/run/trigger.ts';
import { fileStore } from '../src/store.ts';
import { start as main } from '../src/main.ts';
import { Sandbox, SandboxError } from '../src/sandbox.ts';
import type { Settings } from '../src/services.ts';
import type { SessionEvent } from '../src/trace.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { seeded } from './fixtures.ts';
import { git, issuePath } from './kit.ts';

const sandboxGraph = join(import.meta.dirname, '..', 'examples', 'sandbox');

export const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.AGENTGRAPH_TRACKER;
  delete process.env.AGENTGRAPH_PROXY_KEYS;
  delete process.env.AGENTGRAPH_TRUST;
});

export const makeTrackerWorld = () => {
  const { root, seed, data } = seeded('tracker-cli', {
    'package.json': JSON.stringify({ scripts: { test: '! grep -q TODO hello.txt' } }),
  });
  dirs.push(root);
  const dir = join(root, 'tracker');
  const as = 'morgan';
  const tracker = async (verb: string, ...args: string[]): Promise<string> => {
    const flag = (name: string) => {
      const at = args.indexOf(`--${name}`);
      return at < 0 ? undefined : args.splice(at, 2)[1];
    };
    const n = Number(args[0]);
    const issues = Effect.provide(Tracker, folderTracker(dir));
    switch (verb) {
      case 'init':
        git(root, 'init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git'));
        git(seed, 'push', '-q', join(dir, 'origin.git'), `${flag('at') ?? 'main'}:refs/heads/main`);
        return '';
      case 'issue': {
        const body = flag('body');
        const label = flag('label');
        const text = body ? readFileSync(body, 'utf8').trim() : '';
        return `#${await writeIssueFile(dir, { title: args[0]!, author: as, labels: label ? [label] : [] }, text)}`;
      }
      case 'label':
        await Effect.runPromise(
          Effect.flatMap(Tracker, f => f.apply(n, { kind: 'label', add: [args[1]!] })).pipe(
            Effect.provide(folderTracker(dir, as))
          )
        );
        return '';
      case 'comment': {
        const line = flag('line');
        await writeComment(dir, as, n, args.slice(1).join(' '), line);
        return '';
      }
      case 'review':
        await writeReview(
          dir,
          as,
          n,
          args[1] === 'approve' ? 'approved' : 'changes_requested',
          args.slice(2).join(' ')
        );
        return '';
      case 'close':
        await writeClosed(dir, as, n);
        return '';
      case 'merge': {
        const pull = await mergePull({ tracker: dir, owner: as }, n);
        return `${pull.base} at ${pull.head}`;
      }
      case 'show': {
        const f = await Effect.runPromise(issues);
        if (!args[0]) return formatIssueList(await Effect.runPromise(f.issues()));
        const diff = issuePath(dir, n, 'diff.patch');
        return formatIssueTimeline(
          await Effect.runPromise(f.issue(n)),
          existsSync(diff) ? readFileSync(diff, 'utf8') : ''
        ).trim();
      }
    }
    throw new Error(`no tracker verb ${verb}`);
  };
  Object.assign(process.env, { AGENTGRAPH_TRACKER: dir, AGENTGRAPH_PROXY_KEYS: 'implementor=k1,reviewer=k2' });
  const seen: Settings[] = [];
  const run = (
    turns: SessionEvent[][],
    issue: number | 'all' = 'all',
    instruction?: Instruction,
    failures = 0,
    marked?: true
  ) => {
    let left = failures;
    const services = (s: Settings) => {
      seen.push(s);
      const trackerDir = s.tracker as string;
      return Layer.mergeAll(
        folderTracker(trackerDir),
        fileStore(s.data),
        Layer.effect(
          Sandbox,
          Effect.map(Sandbox, sandbox => ({
            ...sandbox,
            checkout: (...args) =>
              Effect.suspend(() =>
                left-- > 0
                  ? Effect.fail(new SandboxError({ reason: 'infra', detail: 'no commit for main' }))
                  : sandbox.checkout(...args)
              ),
          }))
        ).pipe(Layer.provide(hostSandbox(join(trackerDir, 'origin.git')))),
        replaySession(turns)
      );
    };
    return main(
      { graph: sandboxGraph, issue, data, ...(instruction && { instruction }), ...(marked && { marked }) },
      services
    );
  };
  return { root, seed, dir, origin: join(dir, 'origin.git'), tracker, run, seen };
};
