---
title: The sandbox fails closed
status: accepted
source: agentgraph sessions
check: rules
human: user feedback no accidental secure holes, feedback rule 2
---
A bot always runs in the sandbox. There is no setting that turns it off or to none, and a sandbox
that cannot start stops the run instead of running it bare. The unsandboxed launcher exists for
the simulator and the tests only. Checks have no skip switch: a check that is not needed is
removed from the workflow.
