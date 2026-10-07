# syntax=docker/dockerfile:1.7
# Whiteboard web: a personal Whiteboard for browsers on a trusted network.
# Build from the repository root:  docker build -f docker/Dockerfile -t whiteboard-web .
# See docker/README.md before exposing it: it has no authentication.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm AS build

RUN corepack enable

WORKDIR /src

COPY . .

RUN pnpm install --frozen-lockfile

# The fork's TypeScript, esbuild and TextMate packages for the diff library;
# its install scripts fetch Electron and native modules the web never uses.
RUN npm --prefix apps/review-desktop/code-oss ci --ignore-scripts --no-audit --no-fund

RUN pnpm --filter @dev.fast/whiteboard run build:workspace-deps \
  && pnpm --filter @dev.fast/whiteboard run ensure:tutorial-assets \
  && pnpm --filter @dev.fast/review-canvas run build:web

# The npm package as users install it, and diffr for this image's architecture.
RUN mkdir -p /out \
  && pnpm --filter @dev.fast/whiteboard pack --pack-destination /out \
  && mv /out/*.tgz /out/whiteboard.tgz \
  && pnpm --filter @dev.fast/whiteboard exec diffr-fetch --into /out/diffr

FROM node:${NODE_VERSION}-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/whiteboard.tgz /tmp/whiteboard.tgz

# Whiteboard, and the agent CLIs Ask runs.
RUN npm install --global --no-audit --no-fund /tmp/whiteboard.tgz @anthropic-ai/claude-code @openai/codex opencode-ai @github/copilot \
  && rm /tmp/whiteboard.tgz \
  && npm cache clean --force

COPY --from=build /out/diffr/diffr /usr/local/bin/diffr

COPY --from=build /src/packages/review/app/dist/web /opt/whiteboard/web

# Reviews and agents run as node:*-slim's `node` user. On Linux, give it your
# own user and group IDs, so it can write the repositories you mount and git
# trusts them; Docker Desktop maps ownership itself.
ARG WHITEBOARD_UID=1000
ARG WHITEBOARD_GID=1000

RUN if [ "$(id -g node)" != "$WHITEBOARD_GID" ]; then \
      if getent group "$WHITEBOARD_GID" > /dev/null; then usermod -g "$WHITEBOARD_GID" node; \
      else groupmod -g "$WHITEBOARD_GID" node; fi; \
    fi \
  && if [ "$(id -u node)" != "$WHITEBOARD_UID" ]; then usermod -o -u "$WHITEBOARD_UID" node; fi \
  && mkdir -p /data /repos \
  && chown -R "$WHITEBOARD_UID:$WHITEBOARD_GID" /data /repos /home/node

USER node

# DEV_REVIEW_SERVER_DIR points every `whiteboard` command in the container, and
# the MCP server an agent starts, at the web host's state directory.
ENV REVIEW_DIFFR_BINARY=/usr/local/bin/diffr \
  WHITEBOARD_WEB_ASSETS=/opt/whiteboard/web \
  DEV_REVIEW_HOME=/data/home \
  DEV_REVIEW_SERVER_DIR=/data/server \
  DEV_FAST_REVIEW_TELEMETRY_DISABLED=1

WORKDIR /repos

EXPOSE 8080

VOLUME ["/data"]

CMD ["whiteboard", "web", "--host", "0.0.0.0", "--port", "8080", "--software-maps"]
