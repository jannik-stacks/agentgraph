---
title: A new member of a union reaches every match over it
status: accepted
human: dogfood x iteration 1, the new proposal kind needed the studio renderer, a docs page and a config test (X3)
---
Adding a member to a union or kind, such as a proposal kind or a check mode, reaches every place
that matches on all of its members: a `Record<Kind, …>` that must name each key, a `switch` with no
default, a test that lists them, a docs page that names them. Before writing the brief, grep
`src/`, `studio/src/`, `tests/` and `studio/content/docs/` for the union's name and for the literal
of an existing member, and list each file that names every member under `## Files`. A brief that
leaves one out sends the first attempt into a failing type check, studio build or docs-sync, and
then into a question about scope.
