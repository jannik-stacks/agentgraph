# Code style

The rules for agentgraph code. If a rule and the code disagree, fix the code or raise the rule.
Don't quietly work around it.

## Philosophy

**Small tools, plain data between them.** This is the Unix philosophy: a program does one thing, and
programs talk through text or JSON. The engine runs workflows and nothing else. Scripts slice and score,
and write JSON that the studio only reads. Experiments such as tune loops live in a workflow instance or
an example, not in the engine. Every piece runs from the CLI on its own. See Layout and Simplicity.

**Simple is not the same as easy.** Rich Hickey's "Simple Made Easy" splits the two. Simple means
untangled: one concept, one role, nothing braided together. Easy means familiar or close at hand. A
copied type, an extra option or a compat shim is easy today and tangles the code tomorrow. Keep lines of
code and complexity low; a good abstraction is a simple one. When a part underperforms, fix its
abstraction instead of cutting it or wrapping it. See Types and the reduce pass.

**Deep modules.** From John Ousterhout's _A Philosophy of Software Design_, popularized by Matt Pocock: a
module hides a lot of functionality behind a small interface. Storage, git, the sandbox and the harnesses
are each one opinionated module with few entry points, and tests sit at that interface. A shallow wrapper
that only renames its callee has to earn its place. Replaceable parts plug in through a small typed seam.

Good code reads well from its types and signatures alone, with bodies that are plain composition. Design
at that level first.

## Types

1. **Derive types, never copy them.** A variant is `Pick`, `Omit`, `Partial`, an indexed access,
   `ReturnType`/`Parameters` or `typeof X.Type` at the use site.
   ```ts
   type Made = { mounts: Mount[]; image: string; network?: string }; // bad
   type Made = { mounts: Mount[] } & Pick<Graph, 'image' | 'network'>; // good
   ```
2. Anything handwritten twice is a red flag: types, schemas, helpers.
3. Schemas first: Effect schemas define graph files and types are inferred.
4. No early names. A one-field variation stays inline; a pair is `{ harness, model }`, not a `Point`.
5. A new type name needs a reason. If only one place uses it, inline it.
6. Options that apply to one case belong to that case: a union on `kind`, not a bag of optional fields.

## Naming

7. Exported functions start with a verb from the fixed set in `docs/patterns.md#names` (`parse`,
   `compile`, `format`, `make`, `get`, `find`, `read`, `write`, `run`, ...).
8. `is` returns a boolean, `why` returns a reason or undefined: `isAgentBranch`, `whyUnpushable`.
9. No `xOf`, `xFor` or `xFrom` names: `splitTraceIntoVisitedSteps`, not `visitsOf`.
10. Types and components are a qualifier plus a noun: `RunLink`, `DiskCacheEntry`, never `Mark` or `Item`.
11. Spell words out: no `Repo`, `Dep` or `Cfg` in type names. The allowed abbreviations are
    `Dirs`, `Ms`, `Id`, `Url`, `Json`, `Sha`, `Ast`, `Api`, `Cli`, `Pid` and `Env`.
12. Name what a thing is for, not what it holds: `SharedMount`, not `DependencyVolume`.
13. Type suffixes mean one thing each: `Spec` is an input describing what to make, `Result` what one action
    hands back, `Entry` one keyed record of a cache, store or log, `Settings` configuration (never Config or
    Options), `Point` a position, `Lookup` a value for a key, and `XWithY` a pair. There is no `Index` or
    `Map` suffix.
14. Core code in `src/` uses the short words from `docs/index.md#words`. Edge code (bench, tune, studio,
    `bin/`, graph scripts, test doubles) uses long, self-explaining names.
15. Edge types never take a core word: `TuneProposerResult`, not `Proposal`.
16. One word per concept, one export per name. Retired words, each with a clearer word to start from, are
    listed once in [src/retired.ts](src/retired.ts); lint, the loader and the agentgraph example's checks read that
    list. The lint asks for a clearer word rather than a one-for-one swap. A word without a `text` pattern
    is retired for names only, since text keeps other meanings of it (git's `core.bare`, `stacks-core`, a `timestamp`).
17. Don't overload taken words: session is a harness session, run is one workflow execution, no `core`,
    no export named like an Effect or platform type (`TokenScope`, not `Scope`).

## Comments and docs links

18. No code comments. The one exception is `// UNEXPECTED: <what and why>`. TSDoc counts as a comment;
    lint directives and knip's `@internal` stay.
19. Explanation lives in `docs/`. A claim links to its code with a hidden `<!-- code: src/engine.ts#land -->`,
    never a visible `workflow.ts#load`.
20. Links are checked both ways: `bin/refs.mjs` fails on dead ones, and review checks the docs when
    linked code changes.
21. Docs show the defining parts (types, signatures, short excerpts), not whole files.

## Simplicity and reuse

22. Plan first: two to four options as types and signatures, ranked by lines and complexity. Pick the
    simplest.
23. Design structural changes twice, have another model challenge the pick, then build.
24. Smallest correct change, but holistic: wire both sides and miss no caller.
25. No option, field or layer the data doesn't demand. Not needed now means removed. A needed part that
    works badly is different: fix its implementation or abstraction instead of cutting it, so a reduce pass
    removes only what nothing needs.
26. Search before adding a function: `rg` the verb and the noun, check Node and Effect.
27. Delegate: a built-in or maintained library (`util.parseEnv`, `Effect.timeoutFail`, LiteLLM) beats our
    own code.
28. One source of truth: `src/` owns logic; CLI, studio and API are thin wrappers.
29. Work the model doesn't need to know about is plain engine code.
30. Storage, git, sandbox and harnesses are deep modules with small interfaces.
31. Replaceable parts are plugins with small adapters, and ours use the same seam anyone else would.
32. No compat code: no old-name tables, legacy defaults or old-shape readers. Git history is the reference.
33. End every implementation with a reduce pass: un-export unused, drop aliases, delete dead code, merge
    exact copies.

## Layout

34. `src/` is production code only. Test doubles live in `tests/doubles/`, named after the file they
    replace. Tests assert outside loops and branches: one `it.each` row per case, or collect the results
    and assert once.
35. Layer folders; imports only go down; no cycles.
36. The engine repo holds the engine and one minimal example. A repo's graph lives in its `.agentgraph/` folder or in a
    `<repo>-agentgraph` repo.
37. The engine is the SDK; the runner is where it runs. Keep them apart.
38. Everything runs through plain npm scripts and the CLI. Agent instructions live in `AGENTS.md`; there
    is no `CLAUDE.md`, not even a stub.

## Workflow and config fields

39. Fields users type stay short (`back`, `until`, `tries`, `checks`, `judge`); types may qualify them
    (`CheckJudge`).
40. Values read as words: `context: summary | resume`.
41. Every field is explainable in one sentence, or it goes.
42. Borrow shapes people know, such as GitHub Actions `on:` and cancel-in-progress.
43. A workflow file compiles to one checked state machine; unknown keys fail with their path.
44. Config stays minimal and safe, with nothing hackable in it.
45. Workflow and check edits need evidence from traces; without it they are a proposal.

## Lint and enforcement

46. If a tool can check a rule, a tool checks it. This is the one list of what tools enforce:
    - `bin/style.mjs` (oxlint) fails `verb-first` (rule 7), `no-of-for` (9), `unique-export` (16),
      `retired-word` (16) and `no-comment` (18).
    - The agentgraph example's [rules check](examples/agentgraph/scripts/rules.mjs), over the lines a change adds, fails
      the prose bans (55), unicode diagram arrows (55), retired terms (16), a two-dot range to
      `HEAD`, a force push and an `update-ref` without its old sha (59), and a `CLAUDE.md` (38).
    - `test-guards` fails assertions in loops and branches (34); `bin/refs.mjs` fails dead docs links (20).
47. Old violations sit in `bin/style-baseline.txt`; after a rename batch run `node bin/style.mjs --write`.
48. A setting nothing reads can't exist: knip and static analysis run after every big change.
49. Checks name exact tools and commands; judged checks cover only what no tool decides.
50. `npm run check` passes before every commit. Rules here carry good and bad examples.

## Prose in repo docs

51. Plain, short sentences. Open with what was decided, then the specifics.
52. Say where things happen: "opened a local PR in the dogfood forge".
53. Explain each term on first use (arm, case set); if it needs too much explaining, rename it.
54. Keep pages short; have a second model rewrite stiff paragraphs.
55. No em-dash taglines on headings, no `·`, no math symbols, no marketing words. Diagram arrows in fenced
    blocks are ASCII `>` `<` `v` `^`; a plain `→` in prose is fine.

## Exceptions

A rule may have an exception when following it reads worse. Every exception is listed here with its
reason, and the lint baseline or allowlist points back to this list. On every implementation loop,
reread this list and ask whether a restructure or rename would remove an exception. Don't add a new
one without that check.

- **Layer constructors are named `<how><Service>`, without a verb:** `fileForge`, `githubForge`,
  `fileStore`, `harnessSession`, `dockerSandbox`, `remoteSandbox`, `hostSandbox` and the test double `replaySession`.
  They read as values handed to `Effect.provide`. `bin/style.mjs` exempts exactly the ones it
  would flag.
- **Harness plugins are named after their harness:** `opencode()`, `claude()` and `pi()` read in
  `agentgraph.config.ts` the way Vite's `vue()` does. Their schema helper `some` reads as
  `some(Str, 'type', 'id')`, a list of optional fields. `bin/style.mjs` exempts the four names.

## Commits

56. Small linear commits, one change each; no merge commits; never rewrite pushed history.
57. One conventional-commit subject line; optional body of one to three lines on why only.
    `bin/commit-msg.mjs` checks it.
58. Never commit secrets. Agents don't sign or push.
59. A one-off review diffs the branch against its merge-base, `base...HEAD` with three dots; two dots
    are fine between two recorded shas. Anything persisted or rerun (end checks, exports, baselines,
    patches) uses the sha recorded when the work settled, never a merge-base or tip recomputed against a
    live branch. An engine ref update names the old sha it expects: `update-ref <ref> <new> <old>`,
    `--force-with-lease=<ref>:<sha>`.
