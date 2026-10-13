---
title: Runs never install dependencies
status: accepted
check: tests
human: dogfood round 1 deps kinks and round 2 kink K9
---
The hub installs bothub's and studio's locked dependencies in the sandbox, once per lockfile, and
links `node_modules` and `studio/node_modules` into every worktree. The packages are read-only;
tools can still write their caches at the top of `node_modules`, and a cache dir found in the
install itself (`.vite-temp`, `.cache`) is never linked, so each worktree writes its own. Never run
a tool against the install directly, and never run `npm install`, `npm ci` or `npx`. A change to a
lockfile gets a fresh install before the checks run. oxlint and oxfmt come from the sandbox image.
