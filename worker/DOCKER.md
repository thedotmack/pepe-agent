# Pepe-Agent Worker — Docker

## Build

```bash
# from repo root
docker compose build worker
# or, from worker/
./docker-build.sh
```

The image bundles:

- node 24-slim base
- bun 1.3.x runtime
- `@anthropic-ai/claude-code` (the agent SDK shells out to this binary)
- worker source + locked deps (`bun.lock`)
- claude-mem `mcp-server.cjs` at `/opt/claude-mem/scripts/` (vendored under `worker/docker/claude-mem-scripts/`)

## Run

### Compose (recommended)

```bash
# from repo root
export AGENT_SHARED_SECRET=$(openssl rand -hex 32)
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up -d worker
docker compose logs -f worker
```

The worker binds **`127.0.0.1:7011`** on the host (configured by the
compose `ports:` mapping). The container itself listens on `0.0.0.0:7011`
internally; the docker port binding is what enforces no-public-exposure.
Shared-secret auth is the second gate.

Health: `curl -H "x-agent-secret: $AGENT_SHARED_SECRET" http://127.0.0.1:7011/healthz`

### Standalone

```bash
# from worker/
export AGENT_SHARED_SECRET=...
export ANTHROPIC_API_KEY=...
./docker-build.sh
./docker-run.sh
```

## claude-mem coupling

By default the worker reaches claude-mem at
`http://host.docker.internal:37777` (assumes claude-mem worker is running
on the host). Override with `CLAUDE_MEM_WORKER_URL=...` if running
claude-mem in another container or remotely.

The worker bundles claude-mem's MCP stdio server at
`/opt/claude-mem/scripts/mcp-server.cjs` so the agent's `mcp-search`
attachment works without a host-mounted plugin install. Refresh the file
when bumping claude-mem versions:

```bash
cp ~/.claude/plugins/cache/thedotmack/claude-mem/<version>/scripts/mcp-server.cjs \
   worker/docker/claude-mem-scripts/
```

## Volumes

| Mount | Purpose | Phase |
|---|---|---|
| `/app/worker/.data` | SQLite trade ledger | Phase 4 |
| `/app/worker/.sessions` | SDK session store | Phase 8 (resume on restart) |

Both are declared as named volumes in `docker-compose.yml`.

## Authentication for the SDK

The agent SDK spawns `claude` as a subprocess and authenticates via
either `ANTHROPIC_API_KEY` (preferred for ops) or a mounted
`~/.claude/.credentials.json` (Claude Max OAuth). Set
`CLAUDE_CREDENTIALS_FILE=/path/to/.credentials.json` at run time and the
entrypoint will copy it into place. See `docker-entrypoint.sh`.

## Single instance only

The trade ledger is the source of truth and must not be duplicated. Keep
`replicas: 1`; do not auto-scale. Wallet operations require single-writer
semantics.
