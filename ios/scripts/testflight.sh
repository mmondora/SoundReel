#!/bin/bash
# Archives Mondrop (Release) and uploads it to App Store Connect, where it appears in TestFlight once Apple has
# processed it (5-30 minutes).
#
# Run it in Terminal.app on vulcano, like install-iphone.sh: a GUI session has the signing keychain and the Apple ID
# Xcode is signed in with (Xcode > Settings > Accounts, team 5NZADC9YQ2). Nothing here needs the password typed.
#
# Once, before the first upload, in the App Store Connect web UI: an app record for the bundle id it.mikesoft.mondrop
# (Apps > + > New App). The upload fails with "no suitable application records" until it exists.
#
# Headless alternative (an SSH session, no Xcode account): an App Store Connect API key, created in Users and Access >
# Integrations > App Store Connect API (role App Manager or Admin):
#   ASC_KEY_ID=ABC123DEFG ASC_ISSUER_ID=69a6de7e-… ASC_KEY_PATH=~/.config/soundreel/appstoreconnect/AuthKey_ABC123DEFG.p8 \
#     ./scripts/testflight.sh
#
# Option (environment):
#   BUILD=8   build number; it must grow with every upload of the same version (default: CURRENT_PROJECT_VERSION of project.yml)
#
# The archive is push-ready (Release configuration, Mondrop/MondropPush.entitlements): the server starts ringing the
# phones when it has the APNs key, with no new build.
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."

TEAM=5NZADC9YQ2
VERSION="$(awk '/^ *MARKETING_VERSION:/ { gsub(/"/, "", $2); print $2; exit }' project.yml)"
BUILD="${BUILD:-$(awk '/^ *CURRENT_PROJECT_VERSION:/ { gsub(/"/, "", $2); print $2; exit }' project.yml)}"
OUT="$HOME/works/mondrop-build/testflight"
ARCHIVE="$OUT/Mondrop-$VERSION-$BUILD.xcarchive"
LOG="$OUT/Mondrop-$VERSION-$BUILD.log"
mkdir -p "$OUT"

AUTH=()
if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -n "${ASC_KEY_PATH:-}" ]; then
  test -r "$ASC_KEY_PATH" || { echo "ASC_KEY_PATH is not readable: $ASC_KEY_PATH" >&2; exit 1; }
  AUTH=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
  echo "Signing and upload with the App Store Connect API key $ASC_KEY_ID (the key file is never printed)."
else
  echo "Signing and upload with the Apple ID Xcode is signed in with (run this in Terminal.app, not over SSH)."
fi

echo "Mondrop $VERSION ($BUILD) -> archive $ARCHIVE"
xcodegen generate

xcodebuild \
  -project Mondrop.xcodeproj \
  -scheme Mondrop \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  ${AUTH[@]+"${AUTH[@]}"} \
  DEVELOPMENT_TEAM="$TEAM" \
  CURRENT_PROJECT_VERSION="$BUILD" \
  archive 2>&1 | tee "$LOG" | grep -E "^(\*\* |error:|.*: error:|.*warning: .*(Mondrop|PrivacyInfo)|Archive Succeeded)" || true
test -d "$ARCHIVE" || { echo "The archive was not created: see $LOG" >&2; exit 1; }

echo "Exporting and uploading to App Store Connect …"
xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist scripts/ExportOptions-testflight.plist \
  -exportPath "$OUT/export-$VERSION-$BUILD" \
  -allowProvisioningUpdates \
  ${AUTH[@]+"${AUTH[@]}"} 2>&1 | tee -a "$LOG" | grep -E "(Upload|upload|error:|ERROR|Succeeded|succeeded|Failed|failed|ITMS-)" || true

if grep -qE "Upload succeeded|EXPORT SUCCEEDED|Uploaded package is processing" "$LOG"; then
  echo "Done: Mondrop $VERSION ($BUILD) is at Apple. It appears in App Store Connect > Mondrop > TestFlight after processing."
else
  echo "No success line found: read $LOG (look for ITMS- codes)." >&2
  exit 1
fi
