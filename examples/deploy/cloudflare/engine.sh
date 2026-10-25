set -eu
ca=/etc/cloudflare/certs/cloudflare-containers-ca.crt
if [ -f "$ca" ]; then
  cat /etc/ssl/certs/ca-certificates.crt "$ca" > /tmp/ca.crt
  export SSL_CERT_FILE=/tmp/ca.crt NODE_EXTRA_CA_CERTS=/tmp/ca.crt GIT_SSL_CAINFO=/tmp/ca.crt
fi
mkdir -p /data
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
  tar -czf /tmp/backup.tar.gz -C /data --exclude=./work --exclude=./index --exclude=./news --exclude=./.locks . &&
    curl -sSf -X PUT --data-binary @/tmp/backup.tar.gz http://data.internal/data.tar.gz
}

(while sleep 300; do backup || echo "backing up /data failed" >&2; done) &
node bin/run.ts loop --data /data &
engine=$!
trap 'kill $engine 2> /dev/null || :; wait $engine || :; backup || :; exit 0' TERM INT
wait $engine || exit $?
