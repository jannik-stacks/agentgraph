---
title: Keep only what is needed now
status: accepted
source: bothub sessions
check: unused-exports
---
A feature, an option or an export that nothing uses yet is removed rather than kept for later. A
layer earns its place by doing something its callers would otherwise repeat. Prefer delegating to
an installed library over writing a second version of it.
