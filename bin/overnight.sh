#!/bin/sh
# Runs the lines of a queue file in order, one command each, kept awake by caffeinate on macOS. A line that exits 0
# goes to <queue>.done and is skipped from then on; a failing line is tried 3 times with backoff, then left for the
# next rerun. Output appends to <queue>.log. The queue is read again before each line, so it can be edited while it
# runs. Stop with Ctrl-C or kill <pid in <queue>.pid>; rerun the same command to continue.
#
#   sh bin/overnight.sh <dir>/queue.txt
#   sh bin/overnight.sh status <dir>/queue.txt
set -u
[ "$1" = status ] && { show=1; shift; } || show=
queue=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
finished="$queue.done" log="$queue.log" lock="$queue.pid" failed="$queue.failed"
touch "$finished" "$log"

lines() { grep -v '^[[:space:]]*#' "$queue" | grep -v '^[[:space:]]*$'; }
if [ -n "$show" ]; then
  echo "$(grep -cxFf "$finished" "$queue" || true) of $(lines | wc -l | tr -d ' ') commands done"
  if [ -f "$lock" ] && kill -0 "$(cat "$lock")" 2>/dev/null; then echo "running as pid $(cat "$lock")"; else echo 'not running'; fi
  grep -E '^[0-9TZ:-]+ (start|exit|paused)' "$log" | tail -3
  exit 0
fi

if [ -f "$lock" ] && kill -0 "$(cat "$lock")" 2>/dev/null; then
  echo "already running as pid $(cat "$lock")"
  exit 1
fi
echo $$ >"$lock"
: >"$failed"
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
child=
# Each line runs in its own process group, so a stop reaches all it started.
if command -v setsid >/dev/null; then group=setsid; else group=; set -m; fi
trap 'echo "$(now) paused" >>"$log"; [ -n "$child" ] && { kill -s TERM -- "-$child"; wait "$child"; }; rm -f "$lock"; exit 130' INT TERM HUP
command -v caffeinate >/dev/null && caffeinate -i -w $$ &

next() { lines | while IFS= read -r l; do grep -qxF -- "$l" "$finished" "$failed" || { printf '%s\n' "$l"; break; }; done; }
while line=$(next) && [ -n "$line" ]; do
  for try in 1 2 3; do
    echo "$(now) start $try: $line" >>"$log"
    $group sh -c "$line" >>"$log" 2>&1 </dev/null &
    child=$!
    wait "$child"
    code=$?
    child=
    echo "$(now) exit $code: $line" >>"$log"
    [ "$code" -eq 0 ] && { printf '%s\n' "$line" >>"$finished"; break; }
    [ "$try" -eq 3 ] && { printf '%s\n' "$line" >>"$failed"; break; }
    sleep $((try * try * ${OVERNIGHT_BACKOFF:-60})) &
    wait $!
  done
done
rm -f "$lock"
echo "$(now) queue finished, $(wc -l <"$failed" | tr -d ' ') failed: rerun to retry them" >>"$log"
