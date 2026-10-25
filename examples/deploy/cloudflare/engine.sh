set -eu
ca=/etc/cloudflare/certs/cloudflare-containers-ca.crt
if [ -f "$ca" ]; then
  cat /etc/ssl/certs/ca-certificates.crt "$ca" > /tmp/ca.crt
  export SSL_CERT_FILE=/tmp/ca.crt NODE_EXTRA_CA_CERTS=/tmp/ca.crt GIT_SSL_CAINFO=/tmp/ca.crt
fi
mkdir -p /data /tmp/keys
for name in AGENTGRAPH_APP_KEY AGENTGRAPH_PROXY_KEYS; do
  (umask 077 && curl -sSf -o "/tmp/keys/$name" "http://keys.internal/$name")
  export "${name}_FILE=/tmp/keys/$name"
done
code=$(curl -sS -o /tmp/data.tar.gz -w '%{http_code}' http://data.internal/data.tar.gz)
case $code in
200) tar -xzf /tmp/data.tar.gz -C /data ;;
404) ;;
*)
  echo "restoring /data failed with $code" >&2
  exit 1
  ;;
esac

backup() {
  tar -czf "/tmp/$1.tar.gz" -C /data --exclude=./work --exclude=./index --exclude=./news --exclude=./.locks . &&
    curl -sSf -X PUT --data-binary "@/tmp/$1.tar.gz" http://data.internal/data.tar.gz
}

(
  trap 'exit 0' TERM
  while :; do
    sleep 300 &
    wait $!
    backup every || echo "backing up /data failed" >&2
  done
) &
saver=$!
node bin/run.ts loop --data /data &
engine=$!
trap 'kill $saver $engine 2> /dev/null || :; wait $saver $engine || :; backup last || :; exit 0' TERM INT
wait $engine || exit $?
