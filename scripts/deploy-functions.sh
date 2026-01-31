#!/bin/bash
set -e

echo "🚀 SoundReel Deploy Functions"
echo "=============================="

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

# Build functions
echo ""
echo "📦 Build functions..."
cd functions
npm run build
cd ..

# Deploy solo functions
echo ""
echo "☁️ Deploy functions su Firebase..."
firebase deploy --only functions

echo ""
echo "✅ Functions deploy completato!"
