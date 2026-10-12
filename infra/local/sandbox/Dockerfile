# One throwaway container per agent run. No secrets are baked in: the run gets its bot's
# LiteLLM key at start, and the GitHub token never enters the container.
#
#   docker build -t bothub-sandbox:local infra/local/sandbox
#   docker build -t bothub-sandbox:local --build-arg CLAUDE_CODE_VERSION=2.1.296 --build-arg CODEX_VERSION=0.162.1 infra/local/sandbox
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

ARG OPENCODE_VERSION=1.19.0
ARG PI_VERSION=1.1.0
ARG CLAUDE_CODE_VERSION=
ARG CODEX_VERSION=

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-fund --no-audit \
      opencode-ai@${OPENCODE_VERSION} \
      @earendil-works/pi-coding-agent@${PI_VERSION} \
      ${CLAUDE_CODE_VERSION:+@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}} \
      ${CODEX_VERSION:+@openai/codex@${CODEX_VERSION}} \
 && npm cache clean --force

ENV NODE_ENV=production \
    DO_NOT_TRACK=1 \
    PI_TELEMETRY=0 \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    DISABLE_AUTOUPDATER=1 \
    GIT_TERMINAL_PROMPT=0

# The run's worktree is mounted here; HOME and /tmp are tmpfs at run time (read-only root).
WORKDIR /work
USER node
