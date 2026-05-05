#!/usr/bin/env bash
set -euo pipefail

# Mirror claude-mem's pattern: if a credentials file is mounted, copy it
# into the conventional ~/.claude location so the SDK's spawned `claude`
# subprocess finds it. Otherwise the worker falls back to ANTHROPIC_API_KEY.
if [[ -n "${CLAUDE_CREDENTIALS_FILE:-}" ]]; then
  if [[ ! -f "$CLAUDE_CREDENTIALS_FILE" ]]; then
    echo "ERROR: CLAUDE_CREDENTIALS_FILE set but file missing: $CLAUDE_CREDENTIALS_FILE" >&2
    exit 1
  fi
  mkdir -p "$HOME/.claude"
  cp "$CLAUDE_CREDENTIALS_FILE" "$HOME/.claude/.credentials.json"
  chmod 600 "$HOME/.claude/.credentials.json"
fi

exec "$@"
