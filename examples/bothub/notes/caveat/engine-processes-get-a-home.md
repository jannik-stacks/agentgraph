---
title: Every process the engine starts gets a home
status: accepted
check: tests
human: dogfood run 2026-10-13T11-18-22-601Z-6c1a2e, tests check failed on uv_os_homedir
---
Every agent, check and script the engine starts gets `HOME` and `TMPDIR` set to directories that
exist and are writable, never the operator's own home, and a hub's `env` cannot point them
elsewhere. In the sandbox that is the run home or the container's `/tmp`; without it, the system
temp directory.
