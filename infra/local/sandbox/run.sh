#!/usr/bin/env bash
# Runs one agent command in a throwaway container: the exact flags the runner uses.
#
#   run.sh <bot> <worktree> <home> -- <command> [args...]
#   run.sh implementor ~/.bothub/work/r-123 ~/.bothub/runs/r-123/home -- opencode run "fix the typo"
#
# <home> is the run's persistent home ($BOTHUB_DATA/runs/<id>/home), mounted read-write as $HOME
# with the same XDG and CODEX_HOME layout as the runner's homeEnv, so harness transcripts survive.
#
# Needs: the compose `sandbox` profile up (network bothub-sandbox, litellm, egress, ollama-relay), the image
# bothub-sandbox:local, and BOTHUB_LLM_API_KEY_<BOT> in the environment.
#
# Knobs: TIMEOUT_MIN (30), MEMORY (2g), CPUS (1.5), PIDS (512), IMAGE, LLM_URL,
# HARNESS=claude-code (also maps the key to ANTHROPIC_*), CACHE_RW=1 (trusted build-cache warm-up only).
# The npm cache is shared read-write: npm must write to it, entries are content-addressed and
# checked against the lockfile integrity on read, so a tampered entry fails verification.
set -euo pipefail

bot="${1:?usage: run.sh <bot> <worktree> <home> -- <command...>}"
worktree="$(cd "${2:?worktree path}" && pwd -P)"
mkdir -p "${3:?run home path}"
home="$(cd "$3" && pwd -P)"
(cd "$home" && mkdir -p .config .local/share .local/state .cache .codex)
shift 3
[[ "${1:-}" == "--" ]] && shift
(($#)) || { echo "no command given" >&2; exit 2; }

var="BOTHUB_LLM_API_KEY_$(tr 'a-z-' 'A-Z_' <<<"$bot")"
key="${!var:-}"
[[ -n "$key" ]] || { echo "$var is not set" >&2; exit 2; }

IMAGE="${IMAGE:-bothub-sandbox:local}"
LLM_URL="${LLM_URL:-http://litellm:4000}"
name="bothub-run-$bot-$(openssl rand -hex 4)"
uid="$(id -u)" gid="$(id -g)"
cache_ro=",readonly"; [[ "${CACHE_RW:-}" == 1 ]] && cache_ro=""

# A git worktree's .git file points at its admin dir inside the bare mirror on the host.
# Mount the mirror read-only at the same path (objects and refs stay untouchable) and the
# worktree's own admin dir read-write (index, HEAD), so git works inside /work.
git_mounts=()
if [[ -f "$worktree/.git" ]]; then
  admin="$(sed -n 's/^gitdir: //p' "$worktree/.git")"
  [[ "$admin" == /* ]] || admin="$worktree/$admin"
  admin="$(cd "$admin" && pwd -P)"
  common="$(cd "$admin" && cd "$(cat commondir 2>/dev/null || echo ../..)" && pwd -P)"
  git_mounts=(
    --mount "type=bind,src=$common,dst=$common,readonly"
    --mount "type=bind,src=$admin,dst=$admin"
  )
fi

harness_env=()
[[ "${HARNESS:-}" == claude-code ]] && harness_env=(-e "ANTHROPIC_BASE_URL=$LLM_URL" -e "ANTHROPIC_AUTH_TOKEN=$key")

for vol in bothub-npm-cache bothub-build-cache; do
  docker volume inspect "$vol" >/dev/null 2>&1 && continue
  docker volume create "$vol" >/dev/null
  docker run --rm --user 0 --network none -v "$vol:/v" "$IMAGE" chown "$uid:$gid" /v
done

# Watchdog: killing the docker CLI would leave the container running, so kill the container.
( sleep "$(( ${TIMEOUT_MIN:-30} * 60 ))" && docker kill "$name" >/dev/null 2>&1 ) &
watchdog=$!
trap 'kill "$watchdog" 2>/dev/null || true' EXIT

docker run --rm --init --name "$name" \
  --network bothub-sandbox \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=1g \
  --mount "type=bind,src=$home,dst=/home/agent" \
  --user "$uid:$gid" \
  --cap-drop=ALL \
  --security-opt no-new-privileges=true \
  --memory "${MEMORY:-2g}" --memory-swap "${MEMORY:-2g}" \
  --cpus "${CPUS:-1.5}" \
  --pids-limit "${PIDS:-512}" \
  --mount "type=bind,src=$worktree,dst=/work" \
  ${git_mounts[@]+"${git_mounts[@]}"} \
  --mount "type=volume,src=bothub-npm-cache,dst=/cache/npm" \
  --mount "type=volume,src=bothub-build-cache,dst=/cache/build$cache_ro" \
  --workdir /work \
  -e HOME=/home/agent -e TMPDIR=/tmp \
  -e XDG_CONFIG_HOME=/home/agent/.config -e XDG_DATA_HOME=/home/agent/.local/share \
  -e XDG_STATE_HOME=/home/agent/.local/state -e XDG_CACHE_HOME=/home/agent/.cache \
  -e CODEX_HOME=/home/agent/.codex \
  -e BOTHUB_LLM_BASE_URL="$LLM_URL" \
  -e BOTHUB_LLM_API_KEY="$key" \
  -e BOTHUB_DECIDE_URL=http://ollama-relay:11434 \
  -e BOTHUB_DECIDE_MODEL="${BOTHUB_DECIDE_MODEL:-tev1:0.8b}" \
  ${harness_env[@]+"${harness_env[@]}"} \
  -e HTTPS_PROXY=http://egress:8888 -e HTTP_PROXY=http://egress:8888 \
  -e https_proxy=http://egress:8888 -e http_proxy=http://egress:8888 \
  -e NO_PROXY=litellm,ollama-relay,localhost,127.0.0.1 -e no_proxy=litellm,ollama-relay,localhost,127.0.0.1 \
  -e npm_config_cache=/cache/npm -e npm_config_prefer_offline=true \
  -e npm_config_logs_dir=/tmp/npm-logs -e npm_config_update_notifier=false \
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
  "$IMAGE" "$@"
