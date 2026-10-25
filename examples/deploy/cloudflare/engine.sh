set -eu
ca=/etc/cloudflare/certs/cloudflare-containers-ca.crt
if [ -f "$ca" ]; then
  cat /etc/ssl/certs/ca-certificates.crt "$ca" > /tmp/agentgraph-ca.crt
  export SSL_CERT_FILE=/tmp/agentgraph-ca.crt NODE_EXTRA_CA_CERTS=/tmp/agentgraph-ca.crt GIT_SSL_CAINFO=/tmp/agentgraph-ca.crt
fi
export AGENTGRAPH_SANDBOX_URL=http://box.internal AGENTGRAPH_PROXY_URL=${AGENTGRAPH_PROXY_URL:-http://gateway.internal/v1} \
  AGENTGRAPH_CACHE_VOLUME= AGENTGRAPH_MIN_FREE_GB=1
data=$AGENTGRAPH_DATA
mkdir -p "$data" /tmp/keys
for name in AGENTGRAPH_APP_KEY AGENTGRAPH_PROXY_KEYS $(printf '%s' "${AGENTGRAPH_SESSION_ENV:-}" | tr ',' ' '); do
  code=$(umask 077 && curl -sS -o "/tmp/keys/$name" -w '%{http_code}' "http://keys.internal/$name")
  case $code in
  200) export "${name}_FILE=/tmp/keys/$name" ;;
  404) rm -f "/tmp/keys/$name" ;;
  *)
    echo "reading $name failed with $code" >&2
    exit 1
    ;;
  esac
done
code=$(curl -sS -o /tmp/data.tar.gz -w '%{http_code}' http://data.internal/data.tar.gz)
case $code in
200) tar -xzf /tmp/data.tar.gz -C "$data" ;;
404) ;;
*)
  echo "restoring $data failed with $code" >&2
  exit 1
  ;;
esac

backup() {
  tar -czf "/tmp/$1.tar.gz" -C "$data" --exclude=./work --exclude=./index --exclude=./news --exclude=./.locks . &&
    curl -sSf -X PUT --data-binary "@/tmp/$1.tar.gz" http://data.internal/data.tar.gz
}

(
  trap 'exit 0' TERM
  while :; do
    sleep 300 &
    wait $!
    backup every || echo "backing up $data failed" >&2
  done
) &
saver=$!
node bin/run.ts loop --data "$data" &
engine=$!
trap 'kill $saver $engine 2> /dev/null || :; wait $saver $engine || :; backup last || :; exit 0' TERM INT
wait $engine || exit $?
