#!/usr/bin/env bash
# Package the extension as a clean .zip for distribution.
# Output: dist/slack-auto-sort-vX.Y.Z.zip

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

cd "${OUT_DIR}"
zip -r "${NAME}.zip" "${NAME}" -x "*.DS_Store" >/dev/null
rm -rf "${NAME}"

echo "Built: ${OUT_DIR}/${NAME}.zip"
ls -lh "${NAME}.zip"
