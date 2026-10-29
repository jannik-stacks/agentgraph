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
queue_dir=$(cd "$(dirname "$1")" && pwd) || exit 1
queue="$queue_dir/$(basename "$1")"
finished="$queue.done" log="$queue.log" lock="$queue.pid" failed="$queue.failed"
[ -f "$queue" ] && [ -r "$queue" ] || { echo "queue is missing or unreadable: $queue" >&2; exit 1; }
touch "$finished" "$log" || exit 1

holder=
if [ -f "$lock" ]; then
  holder=$(cat "$lock") || exit 1
  expr "$holder" : '[1-9][0-9]*$' >/dev/null && [ "$holder" -le 2147483647 ] 2>/dev/null || {
    echo "invalid queue owner: $lock" >&2
    exit 1
  }
fi

lines() { sed '/^[[:space:]]*#/d; /^[[:space:]]*$/d' "$queue"; }
if [ -n "$show" ]; then
  commands=$(lines) || exit 1
  done_count=$(printf '%s\n' "$commands" | grep -cxFf "$finished" || [ "$?" -eq 1 ]) || exit 1
  total=$(printf '%s\n' "$commands" | grep -c .)
  echo "$done_count of $total commands done"
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then echo "running as pid $holder"; else echo 'not running'; fi
  recent=$(grep -E '^[0-9TZ:-]+ (start|exit|paused)' "$log" || [ "$?" -eq 1 ]) || exit 1
  printf '%s\n' "$recent" | tail -3
  exit 0
fi

if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
  echo "already running as pid $holder"
  exit 1
fi
echo $$ >"$lock" || exit 1
: >"$failed" || exit 1
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
child=
# Each line runs in its own process group, so a stop reaches all it started.
if command -v setsid >/dev/null; then group=setsid; else group=; set -m; fi
trap 'echo "$(now) paused" >>"$log"; [ -n "$child" ] && { kill -s TERM -- "-$child"; wait "$child"; }; rm -f "$lock"; exit 130' INT TERM HUP
command -v caffeinate >/dev/null && caffeinate -i -w $$ &

next() {
  [ -r "$finished" ] && [ -r "$failed" ] || return 1
  commands=$(lines) || return 1
  printf '%s\n' "$commands" | while IFS= read -r l; do
    [ -n "$l" ] || continue
    grep -qxF -- "$l" "$finished" "$failed" && continue
    [ "$?" -eq 1 ] || return 1
    printf '%s\n' "$l"
    break
  done
}
while :; do
  if ! line=$(next); then
    why="$(now) queue or status files unreadable: $queue"
    echo "$why" >&2
    echo "$why" >>"$log"
    rm -f "$lock"
    exit 1
  fi
  [ -n "$line" ] || break
  for try in 1 2 3; do
    echo "$(now) start $try: $line" >>"$log"
    $group sh -c "$line" >>"$log" 2>&1 </dev/null &
    child=$!
    wait "$child"
    code=$?
    child=
    echo "$(now) exit $code: $line" >>"$log"
    [ "$code" -eq 0 ] && { printf '%s\n' "$line" >>"$finished" || exit 1; break; }
    [ "$try" -eq 3 ] && { printf '%s\n' "$line" >>"$failed" || exit 1; break; }
    sleep $((try * try * ${OVERNIGHT_BACKOFF:-60})) &
    wait $!
  done
done
rm -f "$lock"
echo "$(now) queue finished, $(wc -l <"$failed" | tr -d ' ') failed: rerun to retry them" >>"$log"

[ ! -s "$failed" ]
