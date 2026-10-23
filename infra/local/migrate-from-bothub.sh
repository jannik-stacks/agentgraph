#!/usr/bin/env bash
# Moves the local stack from compose project "bothub" to "agentgraph" by copying its volumes.
# The permanent backup is a read-only snapshot of each bothub volume in ~/.agentgraph/migrate/backup,
# taken once bothub is stopped. The bothub volumes themselves are not kept untouched:
# ./rollback-to-bothub.sh starts bothub on them again.
# Progress lives in ~/.agentgraph/migrate; a rerun resumes from there or refuses.
# --dry-run runs only the read-only checks. --force-agents skips the running-agents check.
set -euo pipefail
cd "$(dirname "$0")"
dry= force=
for a in "$@"; do
  case $a in
    --dry-run) dry=1 ;;
    --force-agents) force=1 ;;
    *) echo "usage: migrate-from-bothub.sh [--dry-run] [--force-agents]" >&2 && exit 2 ;;
  esac
done
dir=$HOME/.agentgraph/migrate
bdir=$dir/backup
rollback=$PWD/rollback-to-bothub.sh
volumes=(pgdata chatgpt-auth)
phases=(none preflight counted stopped backed-up copied starting started done)
new=(docker compose -p agentgraph --profile sandbox)
old=(docker compose -p bothub)
api=http://127.0.0.1:4000

step() { printf '\n== %s\n' "$*"; }
die() { echo "refusing: $*" >&2 && exit 1; }
run() { echo "+ $*" && if [ -z "$dry" ]; then "$@"; fi; }
sha() { printf %s "$1" | shasum -a 256 | cut -d' ' -f1; }
envval() { awk -v k="$2=" 'index($0, k) == 1 { print substr($0, length(k) + 1); f = 1 } END { if (!f) print "<absent>" }' <<<"$1"; }
order() {
  local i
  for i in "${!phases[@]}"; do if [ "${phases[$i]}" = "$1" ]; then echo "$i" && return; fi; done
  die "unknown phase '$1' in $dir/phase"
}
reached() { [ "$(order "$phase")" -ge "$(order "$1")" ]; }
set_phase() { phase=$1 && if [ -z "$dry" ]; then echo "$1" >"$dir/phase"; fi; }
running() { docker ps -q --filter "label=com.docker.compose.project=$1" || die "docker ps failed"; }
listening() { (exec 3<>/dev/tcp/127.0.0.1/4000) 2>/dev/null; }
agents() {
  local procs ctrs
  procs=$(ps -axo pid=,command= | AGENT_RE='overnight\.sh|bin/(run|bench|bench-run|tune|resume)\.ts|(^|[ /])agentgraph( |$)|/(bench|tune)/' \
    awk -v self=$$ '$1 != self && $0 ~ ENVIRON["AGENT_RE"] && !/migrate-from-bothub|rollback-to-bothub|shell-snapshots\//') || die "ps failed"
  ctrs=$(docker ps --format '{{.Names}} ({{.Image}})' --filter ancestor=agentgraph-sandbox:local \
    --filter ancestor=agentgraph-sandbox:services --filter ancestor=bothub-sandbox:local) || die "docker ps failed"
  [ -n "$procs$ctrs" ] || { echo "ok: no agent, bench or tune processes" && return; }
  printf '%s\n' "$procs" "$ctrs" | sed '/^$/d; s/^/  /' | cut -c1-160
  if [ -n "$force" ]; then echo "--force-agents: going ahead; these are left running"
  elif [ -n "$dry" ]; then echo "would refuse: agents are running (stop them first, or pass --force-agents)"
  else die "agents are running (listed above); stop them yourself, or pass --force-agents"; fi
}

finish() {
  local rc=$?
  if [ -n "${locked:-}" ]; then rmdir "$dir/lock"; fi
  if [ "$rc" -ne 0 ] && [ -z "$dry" ]; then
    echo "stopped in phase '$phase' (state in $dir, nothing was deleted)" >&2
    docker ps -a --filter label=com.docker.compose.project=bothub --filter label=com.docker.compose.project=agentgraph \
      --format '  {{.Names}}: {{.Status}}' >&2 || true
    if reached counted; then echo "rerun to resume, or roll back with: $rollback" >&2; fi
  fi
  exit "$rc"
}
phase=none
trap finish EXIT

if [ -z "$dry" ]; then
  mkdir -p "$dir" && chmod 700 "$dir"
  mkdir "$dir/lock" 2>/dev/null || die "a migration or rollback holds $dir/lock; if none is running, remove that directory yourself"
  locked=1
fi
phase=$(cat "$dir/phase" 2>/dev/null || echo none)
case $phase in
  done) die "already migrated ($dir/phase says done)" ;;
  rolling-back) die "a rollback was interrupted; run $rollback again" ;;
  rolled-back) die "rolled back earlier; agentgraph-pgdata and agentgraph-chatgpt-auth hold an older copy. Move them and $dir aside yourself before migrating again" ;;
esac
order "$phase" >/dev/null
echo "phase: $phase"
echo "The permanent backup is a read-only snapshot in $bdir, taken once bothub is stopped."
echo "The bothub volumes are not promised to stay untouched: a rollback starts bothub on them."
out=$(running bothub)
if reached started && [ -n "$out" ]; then
  die "bothub is running again after the switch; agentgraph's copy is behind it"
fi

step "check: both bothub volumes exist"
exists() {
  local out
  out=$(docker volume ls -q --filter "name=^$1\$") || die "docker volume ls failed"
  [ "$out" = "$1" ]
}
for v in "${volumes[@]}"; do
  exists "bothub_$v" || die "bothub_$v does not exist"
  if exists "agentgraph-$v"; then
    [ "$phase" != none ] || die "agentgraph-$v already exists; this script never writes into an existing volume"
    echo "agentgraph-$v exists from the earlier run"
  fi
done
echo "ok"

step "check: one bothub container each for litellm and postgres"
old_ctr() {
  local ids
  ids=$(docker ps -aq --filter label=com.docker.compose.project=bothub --filter "label=com.docker.compose.service=$1") || die "docker ps failed"
  [ "$(wc -w <<<"$ids")" -eq 1 ] || die "expected one bothub $1 container, found: ${ids:-none}"
  echo "$ids"
}
old_lit=$(old_ctr litellm)
old_pg=$(old_ctr postgres)
old_lit_env=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$old_lit")
old_pg_env=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$old_pg")
pg_img=$(docker inspect -f '{{.Image}}' "$old_pg")
pg_mount=$(docker inspect -f '{{range .Mounts}}{{if eq .Name "bothub_pgdata"}}{{.Destination}}{{end}}{{end}}' "$old_pg")
cfg=$("${new[@]}" config --format json)
echo "ok: $old_lit $old_pg"

step "check: agentgraph config keeps the effective keys and database credentials (compared by hash)"
same() {
  [ "$(sha "$2")" = "$(sha "$3")" ] || die "$1 differs between bothub and the agentgraph config (values not shown)"
  echo "ok: $1"
}
newval() { jq -r --arg s "$1" --arg k "$2" '.services[$s].environment[$k] // "<absent>"' <<<"$cfg"; }
for k in LITELLM_MASTER_KEY LITELLM_SALT_KEY DATABASE_URL; do
  same "$k" "$(envval "$old_lit_env" "$k")" "$(newval litellm "$k")"
done
for k in POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB; do
  same "$k" "$(envval "$old_pg_env" "$k")" "$(newval postgres "$k")"
done
master=$(newval litellm LITELLM_MASTER_KEY)
pg_user=$(newval postgres POSTGRES_USER)
pg_db=$(newval postgres POSTGRES_DB)

step "check: Postgres major version and data layout"
old_major=$(envval "$old_pg_env" PG_MAJOR)
new_major=$(jq -r '.services.postgres.image' <<<"$cfg" | sed -E 's/^postgres:([0-9]+).*/\1/')
[ "$old_major" = "$new_major" ] || die "bothub runs Postgres $old_major, agentgraph would run $new_major"
[ "$(envval "$old_pg_env" PGDATA)" = "$pg_mount" ] || die "bothub PGDATA is not the bothub_pgdata mount"
if [ -z "$dry" ]; then
  disk_major=$(docker run --rm -v bothub_pgdata:/v:ro --entrypoint cat "$pg_img" /v/PG_VERSION)
  [ "$disk_major" = "$new_major" ] || die "bothub_pgdata holds a Postgres $disk_major cluster"
fi
echo "ok: Postgres $old_major, data in $pg_mount"

if ! reached stopped; then
  step "check: no agent, bench or tune processes are running"
  agents
fi

if ! reached preflight; then
  services=$(docker ps --filter label=com.docker.compose.project=bothub --format '{{.Label "com.docker.compose.service"}}') ||
    die "docker ps failed"
  grep -qx postgres <<<"$services" || die "bothub postgres is not running; its final row counts are read from it"
  echo "bothub services running:" $services
  if [ -z "$dry" ]; then echo "$services" >"$dir/services"; fi
  set_phase preflight
fi
services=$(cat "$dir/services" 2>/dev/null || echo "${services:-}")

psql_in() { docker exec "$1" psql -U "$pg_user" -d "$pg_db" -v ON_ERROR_STOP=1 -Atc "$2"; }
counts_sql='select (select count(*) from "LiteLLM_VerificationToken"), (select count(*) from "LiteLLM_BudgetTable"), (select count(*) from "LiteLLM_SpendLogs")'
raw_keys() { cat .keys.env "${KEYS_FILE:-/dev/null}" "$HOME/.agentgraph/keys-bothub.env" 2>/dev/null | sed -n 's/^[A-Z_]*=\(sk-[A-Za-z0-9_-]*\)$/\1/p' || true; }

if ! reached counted; then
  step "stop bothub except Postgres (graceful, up to 600s), then read its final key, budget and spend log counts"
  run "${new[@]}" build
  if [ -z "$dry" ]; then
    hashes=$(raw_keys | while IFS= read -r k; do printf "'%s'," "$(sha "$k")"; done)
    psql_in "$old_pg" "select key_alias || '|' || token from \"LiteLLM_VerificationToken\" where key_alias is not null
      order by (token in (${hashes}'')) desc, key_alias limit 1" >"$dir/probe"
    [ -s "$dir/probe" ] || die "bothub has no virtual key with an alias to test after the move"
  fi
  others=$(grep -vx postgres <<<"$services" || true)
  if [ -n "$others" ]; then run "${old[@]}" stop -t 600 $others; fi
  if [ -z "$dry" ]; then
    out=$(docker ps -q --filter "id=$old_lit") || die "docker ps failed"
    [ -z "$out" ] || die "bothub litellm is still running"
    psql_in "$old_pg" "$counts_sql" >"$dir/counts"
    echo "keys|budgets|spend logs: $(cat "$dir/counts"), probe key: $(cut -d'|' -f1 "$dir/probe")"
  fi
  set_phase counted
fi

if ! reached stopped; then
  step "stop the rest of bothub (graceful, up to 600s; stop, not down)"
  run "${old[@]}" stop -t 600 $services
  set_phase stopped
fi
out=$(running bothub)
if [ -z "$dry" ]; then
  [ -z "$out" ] || die "a bothub container is still running"
  for v in "${volumes[@]}"; do
    out=$(docker ps -q --filter "volume=bothub_$v") || die "docker ps failed"
    [ -z "$out" ] || die "a running container still uses bothub_$v"
  done
else
  echo "bothub running now (would be stopped):" $out
fi

# A filename with a newline or a hard-linked file makes the manifest ambiguous, so both are refused.
manifest_sh='set -euo pipefail; cd "$1"; nl=$(printf "\nx"); nl=${nl%x}
bad=$(find . -name "*$nl*"); [ -z "$bad" ] || { echo "a filename contains a newline" >&2; exit 1; }
find . | sort | while IFS= read -r p; do
  m=$(stat -c "%F|%a|%u:%g|%h" "$p"); x=
  case $m in
    regular*) [ "${m##*|}" = 1 ] || { echo "hard-linked file: $p" >&2; exit 1; }
      s=$(stat -c %s "$p"); h=$(sha256sum <"$p"); x="$s|${h%% *}" ;;
    symbolic*) x=$(readlink "$p"); case $x in *"$nl"*) echo "symlink target with a newline: $p" >&2; exit 1 ;; esac ;;
  esac
  printf "%s|%s|%s\n" "$p" "$m" "$x"
done'
manifest() { docker run --rm -v "$1:/v:ro" --entrypoint sh "$pg_img" -c "$manifest_sh" sh /v; }

if reached backed-up && ! reached started && [ -z "$dry" ]; then
  step "resume: bothub volumes must still match their snapshot manifests"
  for v in "${volumes[@]}"; do
    manifest "bothub_$v" >"$dir/manifest-recheck-bothub_$v"
    cmp -s "$dir/manifest-bothub_$v" "$dir/manifest-recheck-bothub_$v" ||
      die "bothub_$v changed since its snapshot (diff $dir/manifest-bothub_$v and $dir/manifest-recheck-bothub_$v)"
    echo "ok: bothub_$v unchanged"
  done
fi

if ! reached backed-up; then
  step "snapshot each bothub volume to $bdir (source mounted read-only; the permanent backup)"
  if [ -n "$dry" ]; then
    echo "+ (would write <volume>-<utc>.tar.gz, .sha256 and .manifest per volume, check that each archive restores to the same manifest, then make them read-only)"
  else
    mkdir -p "$bdir"
    utc=$(date -u +%Y%m%dT%H%M%SZ)
    for v in "${volumes[@]}"; do
      name=bothub_$v-$utc
      manifest "bothub_$v" >"$bdir/$name.manifest"
      if [ "$v" = pgdata ] && grep -q '^[^|]*|symbolic link|' "$bdir/$name.manifest"; then
        die "bothub_pgdata has symlinks (tablespace or WAL outside the volume)"
      fi
      docker run --rm -v "bothub_$v:/v:ro" --entrypoint tar "$pg_img" -czf - -C /v . >"$bdir/$name.tar.gz.partial"
      docker run --rm -i --entrypoint sh "$pg_img" -c "set -e; mkdir /r; tar -xzf - -C /r; $manifest_sh" sh /r \
        <"$bdir/$name.tar.gz.partial" >"$dir/manifest-restored-bothub_$v"
      cmp -s "$bdir/$name.manifest" "$dir/manifest-restored-bothub_$v" ||
        die "the snapshot of bothub_$v does not restore to the same manifest (diff $bdir/$name.manifest and $dir/manifest-restored-bothub_$v)"
      mv "$bdir/$name.tar.gz.partial" "$bdir/$name.tar.gz"
      (cd "$bdir" && shasum -a 256 "$name.tar.gz" >"$name.tar.gz.sha256")
      chmod 444 "$bdir/$name.tar.gz" "$bdir/$name.tar.gz.sha256" "$bdir/$name.manifest"
      cp "$bdir/$name.manifest" "$dir/manifest-bothub_$v"
      echo "ok: $bdir/$name.tar.gz, $(wc -l <"$bdir/$name.manifest" | tr -d ' ') entries, restores to the same manifest"
    done
  fi
  set_phase backed-up
fi

if ! reached copied; then
  for v in "${volumes[@]}"; do
    step "copy bothub_$v to agentgraph-$v and compare manifests (path, type, mode, owner, links, size, sha256)"
    if [ -n "$dry" ]; then
      echo "+ (would copy with the source mounted read-only, then compare with the snapshot manifest)"
      continue
    fi
    if exists "agentgraph-$v"; then
      manifest "agentgraph-$v" >"$dir/manifest-agentgraph-$v"
      fresh=$([ "$(wc -l <"$dir/manifest-agentgraph-$v")" -eq 1 ] && echo 1 || true)
      cmp -s "$dir/manifest-bothub_$v" "$dir/manifest-agentgraph-$v" && echo "already copied" && continue
      [ -n "$fresh" ] || die "agentgraph-$v holds a partial or different copy; move it aside yourself, then rerun"
    else
      run docker volume create --label com.docker.compose.project=agentgraph --label "com.docker.compose.volume=$v" "agentgraph-$v"
    fi
    run docker run --rm -v "bothub_$v:/from:ro" -v "agentgraph-$v:/to" --entrypoint sh "$pg_img" \
      -euc 'cp -a /from/. /to/ && chown "$(stat -c %u:%g /from)" /to && chmod "$(stat -c %a /from)" /to'
    manifest "agentgraph-$v" >"$dir/manifest-agentgraph-$v"
    cmp -s "$dir/manifest-bothub_$v" "$dir/manifest-agentgraph-$v" || die "agentgraph-$v differs from bothub_$v (diff the manifests in $dir)"
    echo "match: $(wc -l <"$dir/manifest-bothub_$v" | tr -d ' ') entries"
  done
  set_phase copied
fi

if ! reached started; then
  step "start the stack as project agentgraph"
  out=$(docker ps -q --filter name=^agentgraph-litellm$ --filter status=running) || die "docker ps failed"
  if [ -z "$dry" ] && [ -z "$out" ] && listening; then die "port 4000 is in use"; fi
  holder=$(docker ps --filter publish=4000 --format '{{.Names}}') || die "docker ps failed"
  if [ -n "$dry" ]; then echo "port 4000 now held by:" $holder; fi
  set_phase starting
  run "${new[@]}" up -d --wait
  set_phase started
fi

step "verify: health, model list, row counts, an existing virtual key (no chat request)"
if [ -n "$dry" ]; then
  echo "+ (would check /health/liveliness, /v1/models, counts and /key/info against agentgraph)"
  echo "dry run: nothing changed"
  exit 0
fi
curl -fsS -m 10 -o /dev/null "$api/health/liveliness"
curl -fsS -m 30 -o /dev/null -H "Authorization: Bearer $master" "$api/v1/models"
counts=$(psql_in agentgraph-postgres "$counts_sql")
[ "$counts" = "$(cat "$dir/counts")" ] || die "keys|budgets|spend logs: bothub $(cat "$dir/counts"), agentgraph $counts"
echo "ok: keys|budgets|spend logs $counts"
IFS='|' read -r alias token <"$dir/probe"
curl -fsS -m 30 -H "Authorization: Bearer $master" "$api/key/info?key=$token" |
  jq -e --arg a "$alias" '.info.key_alias == $a' >/dev/null || die "key $alias not found through agentgraph"
raw=$(raw_keys | while IFS= read -r k; do if [ "$(sha "$k")" = "$token" ]; then echo "$k"; fi; done)
if [ -n "$raw" ]; then
  curl -fsS -m 30 -o /dev/null -H "Authorization: Bearer $raw" "$api/v1/models" || die "virtual key $alias was rejected"
  echo "ok: virtual key $alias accepted"
else
  echo "ok: key $alias found (no local key file holds its value, so it was not sent)"
fi
manifest agentgraph-chatgpt-auth >"$dir/manifest-after-start"
cmp -s "$dir/manifest-bothub_chatgpt-auth" "$dir/manifest-after-start" ||
  echo "note: LiteLLM refreshed the ChatGPT login on start; after a rollback, bothub needs a new login (README)"
set_phase done

cat <<EOF

== done. The permanent backup is the read-only snapshot in $bdir.
   bothub is stopped. Its volumes are not promised to stay untouched; never start it next to
   agentgraph, both would use the same single-use ChatGPT refresh token.
   Rollback is only for right after a failed or unhappy migration, before agents run: $rollback
EOF
