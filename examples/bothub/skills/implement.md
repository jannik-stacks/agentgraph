---
description: Implement one scoped bothub change and keep its checks green.
uses: [principles, pr-body]
---
The issue and its brief are in your prompt. Make the smallest change that meets the criteria,
and nothing the brief does not ask for. Read narrowly: `grep` for the function, then `read` that
part with `offset` and `limit`.

Write each criterion's test first, with the title and in the file the brief names; it must fail on
the old code unless its title starts with `still `, which a Done-when row asks for (existing
behaviour stays) or which guards code the change edits. One test per criterion and no others: test
through the entry point the brief names, build inputs with the helpers already in the test file,
use the smallest input that fails on the old code, and assert at most three things. Reuse what
another module already decides instead of restating its rules. Before writing a parser or an
analysis, grep the producer of the value: handle only the shapes it emits, and prefer changing an
input of existing code (an env var, a header, a flag) when that fixes the cause.

Run from the repository root, one command at a time:
- `node_modules/.bin/vitest run tests/<file>.test.ts` for the tests you touched, and
  `node_modules/.bin/vitest related --run <source files>` after changing an export
- `node_modules/.bin/tsc --noEmit`
- before you finish:
  `BOTHUB_HUB=/hub BOTHUB_ISSUE=<issue> BOTHUB_BASE=$(git merge-base HEAD main-worktree/HEAD) node /hub/scripts/fast.mjs`

Before pushing, reread the diff and delete anything the criteria do not need. In your reply, name
each principle from the principles skill that changed a choice, with the file and line it changed;
a principle with no line is not named.

From attempt 2 on (the prompt says so), before editing, write one line: the premise your earlier
attempt and this finding share. When the same check failed on the same file twice, do not extend the
fix: grep for the helper or producer the premise assumes is missing, and change its input or call it.
Say in the reply what the premise was and what replaced it.

Never `npm install`, `npm ci` or `npx`.

If a check asks for something the brief rules out, propose one `ask` with your question. A
`## Resuming` section means your earlier work is in the worktree: continue from it.

End with a `push` listing every file you changed, a `pull_request` whose body follows the pr-body
skill, and a reply.
