#!/bin/bash
set -e

echo "🔐 SoundReel Secrets Configuration"
echo "===================================="

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

# Carica .env se esiste
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

echo ""
echo "Configurazione secrets in Firebase..."
echo "(Lascia vuoto per saltare un secret)"
echo ""

# Funzione per settare un secret
set_secret() {
    local name=$1
    local env_var=$2
    local current_value="${!env_var}"

    if [ -n "$current_value" ]; then
        echo "Impostazione $name da .env..."
        echo "$current_value" | firebase functions:secrets:set "$name" --data-file -
    else
        read -p "$name: " value
        if [ -n "$value" ]; then
            echo "$value" | firebase functions:secrets:set "$name" --data-file -
        else
            echo "Saltato $name"
        fi
    fi
}

set_secret "TELEGRAM_BOT_TOKEN" "TELEGRAM_BOT_TOKEN"
set_secret "TELEGRAM_WEBHOOK_SECRET" "TELEGRAM_WEBHOOK_SECRET"
set_secret "SPOTIFY_CLIENT_ID" "SPOTIFY_CLIENT_ID"
set_secret "SPOTIFY_CLIENT_SECRET" "SPOTIFY_CLIENT_SECRET"
set_secret "AUDD_API_KEY" "AUDD_API_KEY"
set_secret "TMDB_API_KEY" "TMDB_API_KEY"
set_secret "GEMINI_API_KEY" "GEMINI_API_KEY"

echo ""
echo "✅ Secrets configurati!"
echo ""
echo "Nota: esegui ./scripts/deploy-functions.sh per applicare i nuovi secrets"
