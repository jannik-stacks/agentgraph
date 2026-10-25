set -eu
op=$1
shift
root=${AGENTGRAPH_BOX_ROOT:-}
env=$root/tmp/agentgraph-box.env

sync() {
  dir=$root$1
  if [ ! -d "$root$2" ]; then
    git init -q --bare "$root$2"
    git --git-dir="$root$2" config core.bare false
    [ "$2" = "$1/.git" ] || printf '/.cache/\n' > "$root$2/info/exclude"
  fi
  export GIT_DIR="$root$2" GIT_WORK_TREE="$dir" GIT_INDEX_FILE="$root$2/agentgraph-index"
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
  sync "$1" "$2"
  tree=$3
  shift 3
  [ $# -eq 0 ] || printf '%s\n' "$@" > "$GIT_DIR/shallow"
  git index-pack --stdin --strict > /dev/null
  if [ $# -gt 0 ]; then
    git update-ref --no-deref HEAD "$1"
    GIT_INDEX_FILE="$GIT_DIR/index" git read-tree "$1"
  fi
  git read-tree -u --reset "$tree"
  ;;
pull)
  sync "$1" "$2"
  git add -A
  tree=$(git write-tree)
  echo "$tree"
  [ "$tree" != "$3" ] || exit 0
  git rev-list --objects "$tree" --not "$3" > "$GIT_DIR/agentgraph-objects"
  git pack-objects -q --stdout < "$GIT_DIR/agentgraph-objects"
  ;;
put)
  dir=$root$1
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/agentgraph-put.XXXXXX")
  tar -x -f - -C "$tmp"
  mkdir -p "$dir"
  for path in "$tmp"/* "$tmp"/.[!.]*; do
    [ -e "$path" ] || [ -L "$path" ] || continue
    [ ! -d "$dir/${path##*/}" ] || rm -rf "${dir:?}/${path##*/}"
    mv -f "$path" "$dir/"
  done
  rm -rf "$tmp"
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
