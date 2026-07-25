#!/bin/bash
# Bumps the version in every package.json plus the README badge, keeping them
# all on one number.
#
#   ./scripts/bump-version.sh            # patch: 2.1.0 -> 2.1.1
#   ./scripts/bump-version.sh minor      # minor: 2.1.0 -> 2.2.0
#   ./scripts/bump-version.sh major      # major: 2.1.0 -> 3.0.0
#   ./scripts/bump-version.sh 2.5.0      # explicit version
#
# Historically this script pointed at a `functions/` directory left over from
# the Firebase era. With `set -e` the missing `cd` aborted the run *after* the
# frontend had already been bumped, so backend/package.json silently drifted
# behind. Packages are now listed in one place and each is verified to exist
# before anything is written.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Every package that must carry the same version.
PACKAGES=(frontend backend)

BUMP="${1:-patch}"

# Fail loudly rather than half-bumping if the layout changed again.
for pkg in "${PACKAGES[@]}"; do
  if [ ! -f "$PROJECT_DIR/$pkg/package.json" ]; then
    echo "❌ $pkg/package.json non trovato — aggiorna PACKAGES in $0" >&2
    exit 1
  fi
done

# The highest current version wins as the baseline, so a package that has
# drifted ahead is never silently rolled back.
CURRENT_VERSION=$(
  for pkg in "${PACKAGES[@]}"; do
    node -p "require('$PROJECT_DIR/$pkg/package.json').version"
  done | sort -V | tail -1
)

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

case "$BUMP" in
  major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
  minor) NEW_VERSION="$MAJOR.$((MINOR + 1)).0" ;;
  patch) NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))" ;;
  [0-9]*.[0-9]*.[0-9]*) NEW_VERSION="$BUMP" ;;
  *) echo "❌ argomento non valido: $BUMP (usa major|minor|patch|X.Y.Z)" >&2; exit 1 ;;
esac

echo "📌 Versione: $CURRENT_VERSION → $NEW_VERSION"

for pkg in "${PACKAGES[@]}"; do
  OLD=$(node -p "require('$PROJECT_DIR/$pkg/package.json').version")
  (cd "$PROJECT_DIR/$pkg" && npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version > /dev/null)
  echo "   $pkg: $OLD → $NEW_VERSION"
done

if [ -f "$PROJECT_DIR/README.md" ]; then
  sed -i "s/version-[0-9]*\.[0-9]*\.[0-9]*/version-$NEW_VERSION/" "$PROJECT_DIR/README.md"
  echo "   README badge → $NEW_VERSION"
fi

echo "$NEW_VERSION"
