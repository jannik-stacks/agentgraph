# Mining agent transcripts

Run this only after the user said yes to the question in SKILL.md step 5. A yes covers this repo and this
setup only.

## Where they are

| Agent | Folder | What the script keeps |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<folder>/<session>.jsonl` | `user` records with typed text whose `cwd` is the repo or inside it; no tool results, injected context, subagents or `claude -p` runs |
| Codex | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, `~/.codex` by default | sessions whose `session_meta` `cwd` is the repo or inside it, started by a person (not `codex exec`, not a subagent); the `user_message` events |

Other agents (Cursor, opencode) keep history in formats this script does not read. Say so if the user mentions
them; do not go looking.

## Run it

```sh
node "$SKILL/scripts/slice-transcripts.mjs" --days 90 > "$NOTES/transcripts.jsonl"
```

It prints one JSON line per typed message: `source`, a hashed `session`, the date and the text, clipped to 800
characters, with emails, home paths and key-like strings replaced. A summary line on stderr counts the sessions.
Never write its output inside the repo. Messages are filtered by their own date, so an old message in a
resumed session stays out. Delete the file when the setup is done unless the user wants it
kept.

## Read it

Read about 50 lines at a time. Look for corrections: the user telling an agent to stop doing something, to undo
it, or to do it the way they said before. Phrases like "don't", "never", "always", "again", "I said", "why
did you", "remove", "instead" are good signs; questions and plain task requests are not.

Write each correction as a general rule in your own words, with a count:

```
rule: keep commit subjects to one conventional line | corrections: 7 | sessions: 4
```

Merge rules that say the same thing. A rule corrected in two or more sessions is a candidate. Then rank it with
the others in [mining.md](mining.md): which tool decides it, which tier.

Many corrections are about how the agent works with the person (ask before pushing, keep replies short), not
about the change. Those belong in the user's own agent instructions, not in a check. List them separately in
your summary as notes for the user.

## Privacy

- Nothing from a transcript goes into `.agentgraph/` verbatim. A check body states the rule; it never quotes
  the user, names them, dates the correction or says it came from a transcript.
- Leave out anything that names a person, a customer, a private repo, a host or a path, even as a rule.
- In your summary, give counts and your paraphrase, not quotes, unless the user asks to see a source line.
- `node "$SKILL/scripts/scan-private.mjs" .agentgraph` runs before hand-over and must pass. Pass `--deny <file>` with
  names or hosts the user wants kept out, one per line.
