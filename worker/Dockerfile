# pepe-agent worker — long-lived bun process running the claude agent sdk loop.
# Pattern borrowed from claude-mem/docker/claude-mem/Dockerfile.

FROM node:24-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl ca-certificates unzip \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

ARG BUN_VERSION=1.3.12
ENV BUN_INSTALL="/usr/local/bun"
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
 && chmod -R a+rX /usr/local/bun
ENV PATH="/usr/local/bun/bin:${PATH}"

# claude code CLI — the agent SDK spawns this as a subprocess (sdk.d.ts:
# pathToClaudeCodeExecutable / spawnClaudeCodeProcess). No claude binary
# means no agent loop.
RUN mkdir -p /usr/local/share/npm-global \
 && chown -R node:node /usr/local/share/npm-global
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH="/usr/local/share/npm-global/bin:${PATH}"

ARG CLAUDE_CODE_VERSION=latest
USER node
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# claude-mem MCP server (stdio) — pre-bundled single file. Pulled in by
# the agent's Options.mcpServers as `bun /opt/claude-mem/scripts/mcp-server.cjs`.
USER root
COPY --chown=node:node docker/claude-mem-scripts/ /opt/claude-mem/scripts/

# Worker source. Install deps inside the image so the bun.lock stays the
# source of truth.
RUN mkdir -p /app/worker /app/worker/.data /app/worker/.sessions \
 && chown -R node:node /app
WORKDIR /app/worker

USER node
COPY --chown=node:node package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src/ ./src/

VOLUME ["/app/worker/.data", "/app/worker/.sessions"]

# Inside the container we bind 0.0.0.0 — host-side `docker run -p 127.0.0.1:7011:7011`
# is what enforces no-public-exposure. Shared-secret auth is the second gate.
ENV WORKER_BIND=0.0.0.0
ENV WORKER_PORT=7011
ENV CLAUDE_PLUGIN_ROOT=/opt/claude-mem
ENV WORKING_DIR=/workspace/Pepe-Agent
ENV CLAUDE_CODE_PATH=/usr/local/share/npm-global/bin/claude

EXPOSE 7011

USER root
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/pepe-worker-entrypoint
RUN chmod +x /usr/local/bin/pepe-worker-entrypoint
USER node

ENTRYPOINT ["/usr/local/bin/pepe-worker-entrypoint"]
CMD ["bun", "run", "src/index.ts"]
