---
type: script
description: The change adds no way around the hub's guards, the sandbox or the type checker.
run: node "$BOTHUB_HUB/scripts/escape-hatches.mjs"
mode: block
---
No switch to skip checks, no sandbox set to none or off, no harness flag that approves its own
tool calls, no force push, and no silenced type error, `any` or lint rule. The launcher without a
sandbox stays in the runner, the simulator and the tests.
