#!/bin/bash
# Bumps patch version in all package.json files and README badge
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Read current version from frontend/package.json
CURRENT_VERSION=$(node -p "require('$PROJECT_DIR/frontend/package.json').version")

# Split into major.minor.patch and increment patch
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
NEW_PATCH=$((PATCH + 1))
NEW_VERSION="$MAJOR.$MINOR.$NEW_PATCH"

echo "📌 Versione: $CURRENT_VERSION → $NEW_VERSION"

# Update frontend/package.json
cd "$PROJECT_DIR/frontend"
npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version > /dev/null

# Update functions/package.json
cd "$PROJECT_DIR/functions"
npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version > /dev/null

# Update README badge if present
if [ -f "$PROJECT_DIR/README.md" ]; then
  sed -i '' "s/version-[0-9]*\.[0-9]*\.[0-9]*/version-$NEW_VERSION/" "$PROJECT_DIR/README.md"
fi

echo "$NEW_VERSION"
