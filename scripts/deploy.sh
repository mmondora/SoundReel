#!/bin/bash
set -e

echo "🚀 SoundReel Deploy"
echo "==================="

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

# Bump version
echo ""
NEW_VERSION=$("$PROJECT_DIR/scripts/bump-version.sh")

# Build frontend
echo ""
echo "📦 Build frontend..."
cd frontend
npm run build
cd ..

# Build functions
echo ""
echo "📦 Build functions..."
cd functions
npm run build
cd ..

# Deploy tutto
echo ""
echo "☁️ Deploy su Firebase..."
firebase deploy

echo ""
echo "✅ Deploy v$NEW_VERSION completato!"
