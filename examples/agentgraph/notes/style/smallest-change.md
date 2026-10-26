---
title: Smallest change
status: accepted
skill: principles
human: pstack principle
---
Tempted to edit a shared function: change the one call site, or add a parameter whose default keeps the other callers.
Bad: deleted the findings cap for every caller, so issue bodies ran past 65k.
Good: a cap parameter for the one question, default unchanged.
