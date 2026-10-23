#!/usr/bin/env bash
# Moves the local stack from compose project "bothub" to "agentgraph", once. Deletes nothing: the old
# containers and volumes stay as a stopped backup. --dry-run prints the commands without running them.
set -eu
cd "$(dirname "$0")"
case "${1:-}" in
  "") dry= ;;
  --dry-run) dry=1 ;;
  *) echo "usage: migrate-from-bothub.sh [--dry-run]" >&2 && exit 2 ;;
esac
step() { printf '\n== %s\n' "$*"; }
run() {
  echo "+ $*"
  [ -n "$dry" ] || "$@"
}
die() {
  echo "refusing: $*" >&2
  exit 1
}
volumes="pgdata chatgpt-auth"
img=$(docker compose config --images | grep '^postgres')
measure='cd /v && n=$(find . | wc -l) && b=$(find . -type f -exec stat -c %s {} + | awk "{s+=\$1} END {print s+0}") &&
  d=$({ find . -type f -exec md5sum {} +; find . -exec stat -c "%n %u:%g %a" {} +; } | sort | md5sum | cut -c1-16) &&
  echo "$n entries, $b bytes, digest $d"'
in_volume() { docker run --rm -v "$1:/v:ro" --entrypoint sh "$img" -c "$2"; }

step "check: old volumes exist, new ones are missing or empty"
for v in $volumes; do
  docker volume inspect "bothub_$v" >/dev/null || die "bothub_$v does not exist"
  docker volume inspect "agentgraph-$v" >/dev/null 2>&1 || continue
  if [ -n "$dry" ]; then
    echo "+ (would check that agentgraph-$v is empty)"
  else
    in_volume "agentgraph-$v" 'test -z "$(ls -A /v)"' ||
      die "agentgraph-$v already has data; inspect it, then 'docker volume rm agentgraph-$v' yourself"
  fi
done

step "build the egress image before stopping anything"
run docker compose --profile sandbox build

step "stop the old project: stop, not down, so it stays as a backup; Postgres must be down for a consistent copy"
run docker compose -p bothub --profile sandbox --profile ollama stop
for v in $volumes; do
  [ -n "$dry" ] || [ -z "$(docker ps -q --filter "volume=bothub_$v")" ] || die "a running container still uses bothub_$v"
done

for v in $volumes; do
  step "copy bothub_$v to agentgraph-$v (source mounted read-only)"
  run docker volume create --label com.docker.compose.project=agentgraph --label "com.docker.compose.volume=$v" "agentgraph-$v"
  run docker run --rm -v "bothub_$v:/from:ro" -v "agentgraph-$v:/to" --entrypoint sh "$img" \
    -c 'cp -a /from/. /to/ && chown "$(stat -c %u:%g /from)" /to && chmod "$(stat -c %a /from)" /to'
  step "verify agentgraph-$v"
  if [ -n "$dry" ]; then
    echo "+ (would compare entry count, bytes and a content digest of both volumes)"
  else
    old=$(in_volume "bothub_$v" "$measure")
    new=$(in_volume "agentgraph-$v" "$measure")
    echo "old: $old"
    echo "new: $new"
    [ "$old" = "$new" ] || die "agentgraph-$v differs from bothub_$v; the old project is stopped, nothing was deleted"
  fi
done

step "start the stack as project agentgraph"
run docker compose --profile sandbox up -d --wait
run curl -fsS 127.0.0.1:4000/health/liveliness
echo
key=$(sed -n 's/^LITELLM_MASTER_KEY=//p' .env 2>/dev/null | tr -d "\"'")
echo "+ curl 127.0.0.1:4000/v1/chat/completions (model smart, master key from .env)"
[ -n "$dry" ] || curl -sS -m 120 127.0.0.1:4000/v1/chat/completions -H "Authorization: Bearer ${key:-unset}" \
  -H 'Content-Type: application/json' -d '{"model":"smart","messages":[{"role":"user","content":"ping"}],"max_tokens":5}' ||
  echo "chat check failed; the stack is up, check the ChatGPT login (README)"

old=$(docker ps -a --filter label=com.docker.compose.project=bothub --format '{{.Names}}' | tr '\n' ' ')
cat <<EOF

== done. The old project is stopped and kept. Never start it next to this one: both would use
   the same single-use ChatGPT refresh token. Once you trust the new stack, remove it with:
# docker rm ${old:-<bothub containers>}
# docker network rm bothub_db bothub_egress agentgraph_db agentgraph_egress
# docker volume rm bothub_pgdata bothub_chatgpt-auth
# docker image rm bothub-egress:local
EOF
