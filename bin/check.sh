#!/bin/sh
# Runs the whole check: the tests with coverage alongside the static checks and the studio build. Fails when either side fails.
cd "$(dirname "$0")/.."
vitest run --coverage &
tests=$!
npm run -s check:static && npm --prefix studio run -s build
rest=$?
wait $tests
tested=$?
[ $rest -eq 0 ] && [ $tested -eq 0 ]
