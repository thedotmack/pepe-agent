#!/usr/bin/env bash
set -euo pipefail

# Convenience runner for the pepe-agent-worker image. For real ops use
# docker-compose at the repo root; this is for one-off local boots.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="${TAG:-pepe-agent-worker:dev}"
HOST_PORT="${HOST_PORT:-7011}"

if [[ -z "${AGENT_SHARED_SECRET:-}" ]]; then
  echo "ERROR: AGENT_SHARED_SECRET not set" >&2
  exit 1
fi

ENV_ARGS=(
  -e AGENT_SHARED_SECRET
  -e ANTHROPIC_API_KEY
  -e ANTHROPIC_MODEL
  -e ANTHROPIC_BASE_URL
  -e AGENT_WALLET_PUBLIC_KEY
  -e AGENT_WALLET_PRIVATE_KEY_BASE58
  -e AGENT_MAX_BUDGET_USD
  -e SOLANA_NETWORK
  -e SOLANA_RPC_URL
  -e MEMEDECK_JUPITER_PROXY_URL
  -e CLAUDE_MEM_WORKER_URL
)

# claude-mem worker on the host: rewrite 127.0.0.1 references so the
# container can reach it via the docker bridge.
if [[ -z "${CLAUDE_MEM_WORKER_URL:-}" ]]; then
  HOST_PORT_CMW="${CLAUDE_MEM_WORKER_PORT:-37777}"
  export CLAUDE_MEM_WORKER_URL="http://host.docker.internal:${HOST_PORT_CMW}"
  echo "[run] CLAUDE_MEM_WORKER_URL → $CLAUDE_MEM_WORKER_URL"
fi

mkdir -p "$SCRIPT_DIR/.data" "$SCRIPT_DIR/.sessions"

TTY_ARGS=()
[[ -t 0 && -t 1 ]] && TTY_ARGS=(-it)

docker run --rm ${TTY_ARGS[@]+"${TTY_ARGS[@]}"} \
  --add-host=host.docker.internal:host-gateway \
  -p "127.0.0.1:${HOST_PORT}:7011" \
  "${ENV_ARGS[@]}" \
  -v "$SCRIPT_DIR/.data:/app/worker/.data" \
  -v "$SCRIPT_DIR/.sessions:/app/worker/.sessions" \
  "$TAG" \
  "$@"
