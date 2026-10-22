---
title: Keep only what is needed now
status: accepted
source: agentgraph sessions
check: unused-exports
human: user feedback keep only what is needed, feedback rule 3
---
A feature, an option or an export that nothing uses yet is removed rather than kept for later. A
layer earns its place by doing something its callers would otherwise repeat. Prefer delegating to
an installed library over writing a second version of it.
