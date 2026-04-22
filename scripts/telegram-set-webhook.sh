#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/telegram-set-webhook.sh
# Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from .env
# and registers https://soundreel.casamon.dev/telegram/webhook with Telegram.

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo ".env not found"
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN not set}"
WEBHOOK_URL="${TELEGRAM_WEBHOOK_URL:-https://soundreel.casamon.dev/telegram/webhook}"

ARGS="url=${WEBHOOK_URL}"
if [[ -n "${TELEGRAM_WEBHOOK_SECRET:-}" ]]; then
  ARGS="${ARGS}&secret_token=${TELEGRAM_WEBHOOK_SECRET}"
fi

echo "Registering webhook: ${WEBHOOK_URL}"
curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "${ARGS}" | jq .
