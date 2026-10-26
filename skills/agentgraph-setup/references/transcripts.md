# Mining agent transcripts

Run this only after the user said yes to the question in SKILL.md step 5. The yes covers this repo and this
setup only.

## Where they are

| Agent       | Folder                                                   | What the script keeps                                                                                     |
| ----------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Claude Code | `~/.claude/projects/<folder>/<session>.jsonl`            | Typed `user` text whose `cwd` is in the repo; no tool results, injected context, subagents or `claude -p` |
| Codex       | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`        | `user_message` events of sessions a person started in the repo; no `codex exec` or subagents              |

The script reads no other agents. Say so if the user mentions one; do not go looking.

## Run it

```sh
node "$SKILL/scripts/slice-transcripts.mjs" --days 90 > "$NOTES/transcripts.jsonl"
```

One JSON line per typed message: `source`, a hashed `session`, the date and the text, clipped to 800
characters, with emails, home paths and key-like strings replaced. Messages are filtered by their own date.
Never write the output inside the repo, and delete it at the end unless the user wants it kept.

## Read it

Read about 50 lines at a time and look for corrections: the user telling an agent to stop, undo, or do it the
way they said before. Write each as a general rule in your own words, with counts:

```
rule: keep commit subjects to one conventional line | corrections: 7 | sessions: 4
```

Merge rules that say the same thing. Two or more sessions makes a candidate; rank it with the others in
[mining.md](mining.md).

Corrections about how the agent works with the person, such as asking before pushing, belong in the user's own
agent instructions, not in a check. List them apart as notes.

## Privacy

- Nothing from a transcript goes into `.agentgraph/` verbatim. A check states the rule; it never quotes or names
  the user, dates the correction or says where it came from.
- Leave out anything that names a person, a customer, a private repo, a host or a path, even as a rule.
- In your summary give counts and paraphrases, not quotes, unless the user asks for a source line.
- `node "$SKILL/scripts/scan-private.mjs" .agentgraph` must pass before hand-over. `--deny <file>` adds names
  or hosts to keep out, one per line.
