#!/usr/bin/env bash
#
# "Make the library" — build everything needed to publish electron-syphon:
#   1. (optional) build the vendored Syphon.framework if missing
#   2. compile the TypeScript API  → dist/
#   3. build prebuilt native binaries (N-API, ABI-stable across Electron) → prebuilds/
#   4. verify the addon loads and the framework resolves
#   5. (optional) `npm pack` to produce the publishable tarball
#
# Usage:
#   ./scripts/build-library.sh            # build + verify
#   ./scripts/build-library.sh --pack     # also produce electron-syphon-<v>.tgz
#   ARCHS="arm64 x86_64" ./scripts/build-library.sh   # universal prebuild
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PACK=0
[ "${1:-}" = "--pack" ] && PACK=1

echo "▸ electron-syphon — building library in $ROOT"

# 1. Framework -------------------------------------------------------------
if [ ! -d "Frameworks/Syphon.framework" ]; then
  echo "▸ Syphon.framework missing — building from source"
  ./scripts/build-syphon-framework.sh
else
  echo "▸ Syphon.framework present ($(lipo -archs Frameworks/Syphon.framework/Versions/A/Syphon 2>/dev/null || echo '?'))"
fi

# 2. TypeScript ------------------------------------------------------------
echo "▸ compiling TypeScript → dist/"
./node_modules/.bin/tsc -p tsconfig.json

# 3. Prebuilt native binary (N-API → loads on any Electron/Node) -----------
echo "▸ prebuildify (N-API)${ARCHS:+ for ARCHS=$ARCHS}"
if [ -n "${ARCHS:-}" ]; then
  # Build each arch and let node-gyp-build pick at runtime.
  for arch in $ARCHS; do
    ./node_modules/.bin/prebuildify --napi --strip --arch "$arch"
  done
else
  ./node_modules/.bin/prebuildify --napi --strip
fi
echo "  prebuilds:"; find prebuilds -name '*.node' -maxdepth 2 | sed 's/^/    /'

# 4. Verify ----------------------------------------------------------------
echo "▸ verifying load + framework linkage"
find prebuilds -name '*.node' -exec sh -c 'otool -L "$1" | grep -q Syphon || { echo "  ✗ $1 not linked to Syphon"; exit 1; }' _ {} \;
node -e "const s=require('./dist/index.js'); if(typeof s.SyphonServer!=='function'||typeof s.listServers!=='function'||typeof s.SyphonOutput!=='function') throw new Error('missing exports'); const srv=new s.SyphonServer('build verify'); srv.dispose(); console.log('  ✓ loads, exports OK, framework resolved');"

# 5. Pack ------------------------------------------------------------------
if [ "$PACK" = 1 ]; then
  echo "▸ npm pack"
  npm pack
  echo "  → tarball written. Contents:"
  npm pack --dry-run 2>&1 | sed 's/^/    /'
fi

echo "✓ library built. Publish with:  npm publish"
