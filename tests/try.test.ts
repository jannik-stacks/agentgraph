import { describe, expect, it } from 'vitest';
import type { Graph } from '../src/folder.ts';
import type { Said } from '../src/proposal.ts';
import type { Step } from '../src/workflow.ts';
import { pickTryOutcome } from '../src/run/attempt.ts';

const step: Step = { name: 'code', does: { agent: 'coder' }, checks: [], tries: 1 };
const graph = {
  agents: { coder: { returns: ['comment', 'push', 'pull_request', 'merge', 'issue'] } },
} as unknown as Graph;
const push: Said = { kind: 'push', branch: 'agent/1', message: 'fix' };
const comment: Said = { kind: 'comment', body: 'done' };
const facts = {
  step,
  graph,
  run: {},
  branch: undefined,
  own: 'agent/1',
  proposals: [push],
  problems: [],
  asked: false,
  held: true,
  open: true,
  merges: {},
  diff: 'diff --git a/x b/x\n+++ b/x\n+x',
  untouched: false,
  dirty: false,
};

describe('pickTryOutcome', () => {
  it.each([
    [
      'refuses a kind the step may not propose',
      { proposals: [{ kind: 'label' }] as Said[] },
      ['code may not propose label'],
    ],
    [
      'refuses changed files without a push',
      { proposals: [comment], dirty: true },
      ['files changed but nothing was pushed: end with a push proposal, which the runner commits and pushes, or ask'],
    ],
    [
      'refuses a comment-only answer to work that does not exist yet',
      { proposals: [comment], asked: true, held: false },
      ['a pass needs a pull request or an ask'],
    ],
    [
      'refuses a try that changed nothing',
      { proposals: [], held: false, diff: '' },
      ['no change was made: change the files the issue needs and push them, or ask'],
    ],
  ])('%s', (_, given, problems) => {
    expect(pickTryOutcome({ ...facts, ...given })).toEqual({
      outcome: { kind: 'failed', checks: [], proposals: [], problems },
    });
  });

  it.each([
    [
      'asks for a pull request when the branch has none',
      { branch: 'agent/{issue}', open: false },
      ['a pass needs a pull request or an ask'],
    ],
    [
      'refuses a push to another branch',
      { proposals: [{ ...push, branch: 'other' }] },
      ["branch other is not this run's branch agent/1"],
    ],
    [
      'refuses a merge of a pull request from another branch',
      { proposals: [{ kind: 'merge', number: 4, head: 'x' }] as Said[], merges: { 4: 'other' } },
      ["merge #4 is not from this run's branch agent/1"],
    ],
    [
      'refuses a push that leaves conflict markers',
      { diff: 'diff --git a/x b/x\n+++ b/x\n+<<<<<<< HEAD' },
      ['conflict markers left in x'],
    ],
    ['passes a clean push to the checks', {}, []],
  ])('%s', (_, given, problems) => {
    expect(pickTryOutcome({ ...facts, ...given })).toMatchObject({ problems });
  });

  it.each([
    [
      'ends on an ask',
      { proposals: [push, { kind: 'ask', question: 'which?' }] as Said[] },
      { kind: 'ask', question: 'which?' },
    ],
  ])('%s', (_, given, outcome) => {
    expect(pickTryOutcome({ ...facts, ...given })).toEqual({ outcome });
  });

  it.each([
    ['answers a comment that asked nothing of the files', { proposals: [comment], asked: true, untouched: true }, true],
    ['does not answer when the files changed', { proposals: [comment], asked: true, untouched: false }, false],
  ])('%s', (_, given, answered) => {
    expect(pickTryOutcome({ ...facts, ...given })).toMatchObject({ answered });
  });

  it('stacks a pull request on the base run and lands a push onto its commit', () => {
    const verdict = pickTryOutcome({
      ...facts,
      run: { base: { branch: 'agent/2', pull: 3, sha: 'def' }, onto: { sha: 'abc' } },
      proposals: [
        push,
        { kind: 'pull_request', branch: 'agent/1', base: 'main', title: 't', body: 'Stacks on #9. Body' },
      ],
    });
    expect(verdict).toMatchObject({
      world: [
        { ...push, onto: 'abc' },
        { kind: 'pull_request', base: 'agent/2', body: 'Body\n\nStacks on #3' },
      ],
    });
  });
});
