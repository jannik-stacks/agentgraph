// Ways around the hub's own guards a change adds: skipping checks, switching the sandbox off, letting a harness
// approve its own tool calls, force pushes, and silencing the type checker or the linter.
import { scan } from './line-rules.mjs';

const code = /^(src|studio\/src|bin)\/.*\.(ts|tsx|mts|js|mjs)$/;
const config = /^examples\/[^/]+\/(.*\.ya?ml|workflows\/.*\.md|bots\/.*\.md|checks\/.*\.md)$/;
const tests = /^tests\//;
const wanted = path => code.test(path) || config.test(path) || tests.test(path);
const notTests = path => !tests.test(path);
const launchers = new Set(['src/runner.ts', 'src/sim.ts']);

scan('escape-hatches', wanted, [
  [/\ballow[-_]?skip|\bskip[-_]?checks?\b|\ballowSkip|\bskipChecks/i, 'a way to skip checks; a check that is not needed is removed', notTests],
  [/--dangerously|dangerouslySkip|bypassPermissions|--yolo\b|--auto-approve/, 'a harness that approves its own tool calls', notTests],
  [/\bsandbox\s*[:=]\s*['"]?(none|off|false|disabled)\b/i, 'the sandbox switched off; it fails closed instead', notTests],
  [/\bunsandboxed\b/, 'the unsandboxed launcher outside the runner and the simulator', path => notTests(path) && !launchers.has(path)],
  [/push[^\n]*(--force\b|\s-f\b|--force-with-lease)/, 'a force push', notTests],
  [/@ts-(ignore|nocheck|expect-error)/, 'a silenced type error'],
  [/\bas any\b|:\s*any\b/, 'an `any` that hides a type', path => /\.(ts|tsx|mts)$/.test(path)],
  [/\b(eslint|oxlint)-disable/, 'a silenced lint rule'],
]);
