---
description: Eight rules for keeping a change small and in the right place, each with a Bad and a Good line from a real round.
human: eight of pstack's principles, picked from the miss classes in the pstack principles
---
When a rule below changed a choice, name it with the file and line in your reply.

## Smallest change

Tempted to edit a shared function: change the one call site, or add a parameter whose default keeps the other callers.
Bad: deleted the findings cap for every caller, so issue bodies ran past 65k.
Good: a cap parameter for the one question, default unchanged.

## Bound every input

Text or a list enters a prompt, a file or a loop: clip or cap it where it enters.
Bad: 2 MB of function bodies sent to the reviewer.
Good: each body clipped and the count capped where they are collected.

## Policy at the edge

A rule about one hub's workflow goes in a skill or a check, never in `src/` or a prompt every job sees.
Bad: triage close policy written into the engine prompt.
Good: the same rule in `skills/triage.md`.

## Extend the owner

Behaviour that already has an owner (`apply`, `validate`, a skill, a proposal kind): extend it, never add a path beside it.
Bad: a close path next to `apply`.
Good: one more case inside `apply`.

## Reach only what the row needs

The brief names one case: touch one case. Grep every match only when the brief says every.
Bad: a marker every check script must print, so every hub blocked unmarked failures.
Good: the marker for the one check the row names.

## Attack the premise

The same check failed twice on the same hunk: write the premise both fixes share, then change the input or call the existing helper instead of extending the fix.
Bad: four attempts, each parsing a deeper text edge.
Good: the repo's AST helper, 29 lines.

## Wire both sides

A new export, field or event: name its reader and its writer outside tests before pushing.
Bad: a proposal kind with no studio renderer.
Good: the kind and its renderer in one change.

## Assert what the row says

Writing a test: assert the value the row names. A test that pins wording the issue removes is wrong.
Bad: a test locked in "Blocking" on a passing check.
Good: assert the check's mode, not its label.

Adapted from pstack by Lauren Tan, MIT.
