#!/usr/bin/env bash
# Package the extension as a clean .zip for distribution.
# Output: dist/slack-auto-sort-vX.Y.Z.zip
#
# IMPORTANT: the zip's contents are FLAT (no top-level folder). Windows's
# "Extract All" creates a destination folder named after the zip and drops
# the contents into it; if the zip itself contained a top-level folder of
# the same name, you'd get the dreaded nested duplicate-folder layout that
# breaks Chrome's "Load unpacked". Mac's Archive Utility likewise creates a
# folder named after the zip when the contents are flat. Both platforms
# end up at:  <Downloads>/slack-auto-sort-vX.Y.Z/manifest.json

set -euo pipefail

cd "$(dirname "$0")"

VERSION=$(grep -E '"version"' manifest.json | head -1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
NAME="slack-auto-sort-v${VERSION}"
OUT_DIR="dist"
STAGE_DIR="${OUT_DIR}/${NAME}"

rm -rf "${STAGE_DIR}" "${OUT_DIR}/${NAME}.zip"
mkdir -p "${STAGE_DIR}"

# Files to include in the distributed extension.
cp manifest.json "${STAGE_DIR}/"
cp content.js    "${STAGE_DIR}/"
cp inject.js     "${STAGE_DIR}/"
cp popup.html    "${STAGE_DIR}/"
cp popup.js      "${STAGE_DIR}/"
cp README.md     "${STAGE_DIR}/"

# Zip the contents (`.`) of the staging dir, not the staging dir itself, so
# the archive has no top-level folder.
( cd "${STAGE_DIR}" && zip -r "../${NAME}.zip" . -x "*.DS_Store" >/dev/null )
rm -rf "${STAGE_DIR}"

echo "Built: ${OUT_DIR}/${NAME}.zip"
unzip -l "${OUT_DIR}/${NAME}.zip" | head -20
