# celld's release image has no esbuild, which `celld dev` needs to bundle a Worker.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS esbuild
ARG ESBUILD_VERSION=0.28.2
RUN npm install --prefix /opt/esbuild --no-fund --no-audit esbuild@${ESBUILD_VERSION} \
 && cp /opt/esbuild/node_modules/@esbuild/linux-*/bin/esbuild /usr/local/bin/esbuild

FROM ghcr.io/denoland/celld:v0.6.2@sha256:b85983dcf410bcf710bbc30f400d8654123cb2b541ca4d84d7e299009a6ee97a
COPY --from=esbuild /usr/local/bin/esbuild /usr/local/bin/esbuild
