# Egress for run containers: tinyproxy lets through only the hosts in `allowlist`, and the
# same image runs socat as a single-port relay to Ollama on the host (service ollama-relay).
FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
RUN apk add --no-cache tinyproxy=1.11.2-r0 socat=1.8.1.3-r0
COPY tinyproxy.conf allowlist /etc/tinyproxy/
USER tinyproxy
EXPOSE 8888
ENTRYPOINT ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
