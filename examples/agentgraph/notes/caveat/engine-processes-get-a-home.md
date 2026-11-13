---
title: Every process the engine starts gets a home
status: accepted
check: tests
human: a dogfood run whose tests check failed on uv_os_homedir
---
Every agent, check and script the engine starts gets `HOME` and `TMPDIR` set to directories that
exist and are writable, never the operator's own home, and a graph's `env` cannot point them
elsewhere. In the sandbox that is the run home or the container's `/tmp`; without it, the system
temp directory.
