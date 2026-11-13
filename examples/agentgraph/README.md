# agentgraph example

This repository's graph starts from `/agent` comments. Its triager writes a brief; the implementor works on `agentgraph/<issue>` for up to four tries, running script checks before judges. A human reviews and merges.

These are this graph's conventions. Other graphs choose their own triggers, checks and proposal grants.

| Path | What |
|---|---|
| `agents/` | triager, implementor, reviewer and checker, a fast model for narrow yes-or-no questions |
| `skills/` | triage and implement, the steps of the same name; principles and pr-body, which implement uses |
| `checks/` | one file per check: `run` for a script, `agent` for a judged one, `each` for one item per line |
| `scripts/` | what the checks run; `fast.mjs` runs the quick script checks, which `npm run check` uses on this repo |
| `fixtures/` | labelled items that `scripts/calibrate.mjs` scores a model against before a judged check gates |
| `notes/` | style, decision and caveat notes `scripts/note-pairs.mjs` reads |

Run `node scripts/calibrate.mjs [--env <file>] [--models a,b] <checks-dir> <fixture.jsonl>...` on the host, not in a check. A fixture line is `{"item": <text or object>, "expect": "yes" | "no", "source": "..."}`; its check is the fixture's base name in `<checks-dir>`, whose body is the question. Candidates are `decide:<ollama model>`, asked for the probability of yes, and `chat:<LiteLLM alias>`, asked for PASS or FAIL. The key comes from `AGENTGRAPH_LLM_API_KEY`, or `LITELLM_MASTER_KEY` in the `--env` file, and is never printed.
