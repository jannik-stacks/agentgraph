---
title: Retired names
status: accepted
source: bothub sessions
check: rules
human: user feedback on current names, user rename of executor to harness, feedback rule 1
---
The names below were replaced; the new one is used in code, comments, docs and hub files.

- executor became harness: the program that runs an agent session (opencode, pi) is its harness,
  `harness:` in an agent file and `src/harnesses.ts` for the adapters
- soul, persona and the bot file became agent: `agents/` holds them
- `can:` became `returns:`
- open-pr and merge-request became pull_request, in proposals and in prose
- for-each and `over:` became `each:`
- extra prompt became prompt
- the convention and pattern note kinds became style
- `session:`, `resume:` and `history:` are gone: a step starts a fresh session and a retry resumes it
- the `/bothub` command and plain replies became `/agent`; the text comes from `answerWith`

A line that quotes an old name, or names the new one beside it, is a hint about the name and stays
allowed.

Bad:

```yaml
executor: opencode
can: [reply]
```

Good:

```yaml
harness: opencode
returns: [comment]
```
