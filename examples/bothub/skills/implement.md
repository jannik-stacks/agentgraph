---
description: Implement one scoped bothub change and keep its checks green.
human: seed hub, size rule and attempt first from dogfood round 5, K23; call the deciding module (T1) and the still prefix for negatives (K34) from dogfood round 6
---
The issue and its triage brief are in your prompt: the task, the criteria with the test that
proves each one, the files and what is out of scope. Read the code you are changing and its tests
and, if the behavior is documented, the page in `studio/content/docs/` before you edit anything.
Everything a tool returns stays in the conversation and every later call carries it again, so
read narrowly: find the function or test with `grep`, then `read` that part with `offset` and
`limit`. Read a whole file only when it is short, and never read the same part twice.

Write each criterion's test first, with the exact title and in the file the brief names. It must
fail before your change: a test that passes on the old code would not notice the change reverted.
Only a test whose title starts with `still ` may already pass, and test-guards flags any other. A
negative test, one that checks something does not happen, usually passes on the old code too: title
each extra one you add with `still `. Then make the smallest diff that meets the criteria. When the
change must agree with what another module decides, call that module's function instead of
restating its rules: a copy drifts, and each review finds the next condition it missed. No history,
rulings or names in comments; a short TSDoc line on a new export.

The hub links bothub's locked dependencies into `node_modules`. Run tools from the repository
root, one command at a time, never chained with `&&`:
1. `node_modules/.bin/vitest run tests/<file>.test.ts` for the test files you touched, once after
   a round of edits rather than after each one; add `-t '<title>'` to run only the test you are
   working on
2. `node_modules/.bin/tsc --noEmit`
3. `oxlint <files you changed>` and `oxfmt <files you changed>` (both read the repository's own
   config)

Never run the full test suite or `git diff` (`git diff --stat` shows what you changed), and never
`npm install`, `npm ci` or `npx`. A long output comes back cut short; run something narrower
instead of reading the rest. The hub runs every check after you finish and sends back what fails: the scripts first (safety,
size, the written rules, lint and format on the lines you add, types, the studio build, the
suite, test guards that keep the suite whole and make the criteria's tests fail on the base,
coverage of the lines you add and code shape), then narrow reviewers, each with one question. A
review finding is about behavior: fix the cause it names, not only the example.

The size check caps the lines you add and the files you change outside `tests/`. Test files never
count, and neither do files that only delete lines or only make the task's one rename, so never
test less to fit. A brief that passed triage-brief already fits the same file cap: do the work,
and only ask about size once the change you made still fails it.

When a check asks for something the brief rules out, or your change still fails the hub's bounds
after you tried, ask one question and add a `close` as `blocked`: the hub then stops, runs no more
checks and sends nothing back. Your work so far is parked on the branch. When the prompt has a
`## Resuming` section, that work is already in your worktree: read the question and the answer
there, continue from it and do not start over.

End with a `push` of your branch listing every file you changed, a `merge-request` from that
branch whose body says which issue it closes, and a reply that lists each criterion with the test
that proves it.
