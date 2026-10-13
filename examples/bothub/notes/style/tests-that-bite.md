---
title: Tests that would catch the change being reverted
status: accepted
source: bothub sessions
check: tests-bite
human: user feedback no tautological tests, feedback rule 12
---
Coverage stays high, and every test asserts behavior the change introduces. A test that restates
its own fixture, or passes on the base code, proves nothing and is rewritten until it fails
without the change.
