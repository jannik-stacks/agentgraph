# One throwaway container per agent run. No secrets are baked in: the run gets its bot's
# LiteLLM key at start, and the GitHub token never enters the container.
#
#   docker build -t bothub-sandbox:local infra/local/sandbox
#   infra/local/sandbox/smoke.sh      starts it the way a run does; fails on a missing tool or a write to the root
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

ARG OPENCODE_VERSION=1.19.0
ARG PI_VERSION=1.1.0
ARG OXLINT_VERSION=1.87.0
ARG OXFMT_VERSION=0.72.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git procps ripgrep \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-fund --no-audit \
      opencode-ai@${OPENCODE_VERSION} \
      @earendil-works/pi-coding-agent@${PI_VERSION} \
      oxlint@${OXLINT_VERSION} \
      oxfmt@${OXFMT_VERSION} \
 && npm cache clean --force

# opencode installs @opencode-ai/plugin into its config dir before loading bothub's plugins. Installing it here,
# and making this the config dir, saves that install on every run.
RUN mkdir -p /opt/opencode \
 && cd /opt/opencode \
 && npm install --no-fund --no-audit --save-exact @opencode-ai/plugin@${OPENCODE_VERSION} \
 && printf 'node_modules\npackage.json\nbun.lock\n.gitignore\n' > .gitignore \
 && npm cache clean --force

ENV OPENCODE_CONFIG_DIR=/opt/opencode \
    DO_NOT_TRACK=1 \
    PI_TELEMETRY=0 \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    DISABLE_AUTOUPDATER=1 \
    GIT_TERMINAL_PROMPT=0

# The run's worktree is mounted here, HOME is the run's own home and /tmp is tmpfs (read-only root).
WORKDIR /work
USER node
