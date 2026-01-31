#!/bin/bash
set -e

echo "🚀 SoundReel Deploy Hosting"
echo "============================"

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

# Build frontend
echo ""
echo "📦 Build frontend..."
cd frontend
npm run build
cd ..

# Deploy solo hosting
echo ""
echo "☁️ Deploy hosting su Firebase..."
firebase deploy --only hosting

echo ""
echo "✅ Hosting deploy completato!"
