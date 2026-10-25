set -eu
op=$1
shift
root=${AGENTGRAPH_BOX_ROOT:-}
env=$root/tmp/agentgraph-box.env

sync() {
  dir=$root$1
  git=$dir.git
  [ "$1" != /work ] || git=$dir/.git
  if [ ! -d "$git" ]; then
    git init -q --bare "$git"
    git --git-dir="$git" config core.bare false
    [ "$1" = /work ] || printf '/.cache/\n' > "$git/info/exclude"
  fi
  export GIT_DIR="$git" GIT_WORK_TREE="$dir" GIT_INDEX_FILE="$git/agentgraph-index"
  mkdir -p "$dir"
}

case $op in
start)
  ca=/etc/cloudflare/certs/cloudflare-containers-ca.crt
  if [ -f "$ca" ]; then
    cat /etc/ssl/certs/ca-certificates.crt "$ca" > /tmp/agentgraph-ca.crt
    export SSL_CERT_FILE=/tmp/agentgraph-ca.crt NODE_EXTRA_CA_CERTS=/tmp/agentgraph-ca.crt GIT_SSL_CAINFO=/tmp/agentgraph-ca.crt
  fi
  export -p | grep -v -e ' HOME=' -e ' PWD=' -e ' OLDPWD=' -e ' SHLVL=' -e ' HOSTNAME=' > "$env"
  exec sleep infinity
  ;;
init)
  mkdir -p "$root/work" "$root/homes"
  [ "$(id -u)" != 0 ] || chown 1000:1000 "$root/work" "$root/homes"
  ;;
push)
  sync "$1"
  tree=$2
  shift 2
  [ $# -eq 0 ] || printf '%s\n' "$@" > "$GIT_DIR/shallow"
  git index-pack --stdin --strict > /dev/null
  if [ $# -gt 0 ]; then
    git update-ref --no-deref HEAD "$1"
    GIT_INDEX_FILE="$GIT_DIR/index" git read-tree "$1"
  fi
  git read-tree -u --reset "$tree"
  ;;
pull)
  sync "$1"
  [ ! -f "$GIT_DIR/index" ] || GIT_INDEX_FILE="$GIT_DIR/index" git ls-files -z | git update-index --add --remove -z --stdin
  git add -A
  tree=$(git write-tree)
  echo "$tree"
  [ "$tree" != "$2" ] || exit 0
  git rev-list --objects "$tree" --not "$2" > "$GIT_DIR/agentgraph-objects"
  git pack-objects -q --stdout < "$GIT_DIR/agentgraph-objects"
  ;;
put)
  dir=$root$1
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/agentgraph-put.XXXXXX")
  tar -x -f - -C "$tmp"
  mkdir -p "$dir"
  for path in "$tmp"/* "$tmp"/.[!.]* "$tmp"/..?*; do
    [ -e "$path" ] || [ -L "$path" ] || continue
    [ ! -d "$dir/${path##*/}" ] || rm -rf "${dir:?}/${path##*/}"
    mv -f "$path" "$dir/"
  done
  rm -rf "$tmp"
  ;;
keep)
  tar -czf /tmp/agentgraph-kept.tgz -C "$root/" --anchored --no-wildcards-match-slash --exclude='homes/*/.cache' work homes
  wc -c < /tmp/agentgraph-kept.tgz
  ;;
reap)
  for round in 1 2 3; do
    for environ in /proc/[0-9]*/environ; do
      pid=${environ#/proc/}
      pid=${pid%/environ}
      [ "$pid" != $$ ] || continue
      if tr '\0' '\n' < "$environ" 2> /dev/null | grep -qxF "AGENTGRAPH_RUN=$1"; then kill -KILL "$pid" 2> /dev/null || :; fi
    done
  done
  ;;
run)
  minutes=$1
  shift
  [ ! -f "$env" ] || . "$env"
  cd "$root/work"
  if command -v timeout > /dev/null; then exec timeout -k 10s -s KILL "${minutes}m" env "$@"; fi
  exec env "$@"
  ;;
*)
  echo "unknown op $op" >&2
  exit 2
  ;;
esac
