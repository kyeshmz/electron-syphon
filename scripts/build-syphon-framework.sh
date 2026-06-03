#!/usr/bin/env bash
#
# (Re)build the vendored Syphon.framework from source into ./third_party.
# The framework is committed so a normal `npm install` needs no extra steps;
# run this only to update it or to produce a universal (arm64 + x86_64) binary.
#
# Requires: Xcode command-line tools.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
DEST="$ROOT/third_party/Syphon.framework"

echo "→ cloning Syphon-Framework"
git clone --depth 1 https://github.com/Syphon/Syphon-Framework.git "$WORK/syphon"

echo "→ building (Release, arm64+x86_64)"
xcodebuild -project "$WORK/syphon/Syphon.xcodeproj" \
  -target Syphon -configuration Release \
  ONLY_ACTIVE_ARCH=NO ARCHS="arm64 x86_64" \
  CONFIGURATION_BUILD_DIR="$WORK/out" build

echo "→ vendoring into third_party/"
rm -rf "$DEST"
ditto "$WORK/out/Syphon.framework" "$DEST"

# Ensure the install name is @rpath-relative so the bundled copy is preferred.
install_name_tool -id @rpath/Syphon.framework/Versions/A/Syphon \
  "$DEST/Versions/A/Syphon" 2>/dev/null || true

echo "→ done:"
lipo -info "$DEST/Versions/A/Syphon"
rm -rf "$WORK"
