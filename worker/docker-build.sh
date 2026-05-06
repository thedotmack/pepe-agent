#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="${TAG:-pepe-agent-worker:dev}"

echo "[build] tag=$TAG context=$SCRIPT_DIR"
docker build -t "$TAG" "$SCRIPT_DIR"
echo "[build] done — $TAG"
