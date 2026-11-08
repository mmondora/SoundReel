#!/bin/bash
# Run this in Terminal.app on vulcano (GUI session → keychain works).
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."
xcodegen generate
DEST="${1:-id=00008150-001E3C361482401C}"
echo "Building Mondrop for $DEST …"
xcodebuild \
  -project Mondrop.xcodeproj \
  -scheme Mondrop \
  -destination "$DEST" \
  -configuration Debug \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=5NZADC9YQ2 \
  build

APP=$(find ~/Library/Developer/Xcode/DerivedData/Mondrop-*/Build/Products/Debug-iphoneos/Mondrop.app -maxdepth 0 2>/dev/null | head -1)
test -n "$APP" && test -d "$APP"
echo "Installing $APP …"
xcrun devicectl device install app --device 00008150-001E3C361482401C "$APP"
echo "Launching…"
xcrun devicectl device process launch --device 00008150-001E3C361482401C it.mikesoft.mondrop || true
xcrun devicectl device info apps --device 00008150-001E3C361482401C 2>/dev/null | grep -i mondrop || true
echo "Done."
