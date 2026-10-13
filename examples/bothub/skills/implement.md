---
description: Implement one scoped bothub change and keep its checks green.
---
Read the task and its acceptance criteria. Look at the code you are changing, its tests and,
if the behavior is documented, the page in `studio/content/docs/` before you edit anything.

Make the smallest diff that meets the criteria. Add or change tests where the behavior changes.
No history, rulings or names in comments; a short TSDoc line on a new export.

The hub links bothub's locked dependencies into `node_modules`. Run tools from the repository
root:
1. `node_modules/.bin/vitest run tests/<file>.test.ts` for the tests you touched
2. `node_modules/.bin/tsc --noEmit`
3. `oxlint <files you changed>` and `oxfmt <files you changed>` (both read the repository's own
   config)

Never run `npm install`, `npm ci` or `npx`.

After you finish, the hub runs its safety, harness-memory, docs-style, comments, lint, format,
types, studio-build and tests checks, then a reviewer reads each hunk, and whatever fails comes
back to you. A review finding is about behavior: fix the cause it names, not only the example.

End with a `push` of your branch listing every file you changed, a `merge-request` from that
branch whose body says which issue it closes, and a reply that lists each criterion and the
command that proved it.
