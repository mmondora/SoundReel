#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export GIT_REVISION=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
export BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "Building with GIT_REVISION=$GIT_REVISION BUILD_DATE=$BUILD_DATE"
docker compose build "$@"
