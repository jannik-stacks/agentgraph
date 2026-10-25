# One throwaway container per agent run. No secrets are baked in: the run gets its bot's
# LiteLLM key at start, and the GitHub token never enters the container.
#
#   docker build -t agentgraph-sandbox:local infra/local/sandbox
#   infra/local/sandbox/smoke.sh      starts it the way a run does; fails on a missing tool or plugin install
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

ARG OPENCODE_VERSION=1.19.0
ARG PI_VERSION=1.1.0
ARG OXLINT_VERSION=1.87.0
ARG OXFMT_VERSION=0.72.0
ARG RUSTUP_VERSION=1.29.1

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential ca-certificates curl git mold pkg-config procps ripgrep \
 && rm -rf /var/lib/apt/lists/*

# Toolchain managers, not toolchains: the toolchain step installs what a repo names into the /cache volume.
RUN arch=$(uname -m) \
 && case $arch in \
      x86_64) sum=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71 ;; \
      aarch64) sum=15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433 ;; \
    esac \
 && curl -sSfo /usr/local/bin/rustup-init \
      https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/$arch-unknown-linux-gnu/rustup-init \
 && echo "$sum  /usr/local/bin/rustup-init" | sha256sum -c - \
 && chmod 755 /usr/local/bin/rustup-init \
 && mkdir -m 1777 /cache

# Rust: link with mold and keep only line tables in dev and test builds, since relinking test binaries is most of an
# edit-to-test cycle.
RUN printf '#!/bin/sh\nexec "${CC:-cc}" -fuse-ld=mold "$@"\n' > /usr/local/bin/cc-mold && chmod 755 /usr/local/bin/cc-mold

# Install scripts never run; opencode's postinstall, which links its platform binary, is the one allowed.
RUN npm install -g --no-fund --no-audit --ignore-scripts \
      opencode-ai@${OPENCODE_VERSION} \
      @earendil-works/pi-coding-agent@${PI_VERSION} \
      oxlint@${OXLINT_VERSION} \
      oxfmt@${OXFMT_VERSION} \
 && (cd /usr/local/lib/node_modules/opencode-ai && node postinstall.mjs) \
 && npm cache clean --force

# opencode installs @opencode-ai/plugin into its global config dir before loading agentgraph's plugins. Each run home
# links that dir's node_modules and lockfile here, so opencode finds the install and skips it (about 10 seconds).
RUN mkdir -p /opt/opencode \
 && cd /opt/opencode \
 && npm install --no-fund --no-audit --ignore-scripts --save-exact @opencode-ai/plugin@${OPENCODE_VERSION} \
 && npm cache clean --force

ENV DO_NOT_TRACK=1 \
    PI_TELEMETRY=0 \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    DISABLE_AUTOUPDATER=1 \
    GIT_TERMINAL_PROMPT=0 \
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=/usr/local/bin/cc-mold \
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=/usr/local/bin/cc-mold \
    CARGO_PROFILE_DEV_DEBUG=line-tables-only \
    RUSTUP_HOME=/cache/rustup \
    CARGO_HOME=/cache/cargo \
    PATH=/cache/cargo/bin:$PATH

# The run's worktree is mounted here, HOME is the run's own home, /tmp is tmpfs (read-only root) and /cache is the
# shared toolchain volume. A new volume takes /cache's mode, so any uid can write it.
WORKDIR /work
USER node
