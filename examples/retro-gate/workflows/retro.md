---
on: dispatch
agent: retro
---
The run on this issue made too many failed tool calls. Read its trace and find out why.

1. List every failed tool call: the command or tool, its input and the error, cited by run and line.
2. Group them by cause: a missing tool or dependency, a wrong path or command the repo does not use,
   a permission the agent lacked, an instruction that sent it the wrong way, or a flaky environment.
3. For each group that will happen again, open the file that would have prevented it: a skill or
   agent in the graph folder (`$AGENTGRAPH_DIR`, or `.agentgraph/` in the checkout), `AGENTS.md`,
   or the graph's `settings.yaml` setup. Write the exact edit: the file, the lines to replace, and
   the new lines.

File one `graph` issue per group with the edit in its body. A group seen once, or caused by a flaky
environment, is not worth an issue; say so in a comment instead.
