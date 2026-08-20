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
# Overridable so a test can build somewhere disposable and inspect the real
# zip rather than pattern-matching this script's text. OUT_DIR only ever
# RECEIVES the zip — it is never the target of a recursive delete, because a
# caller-supplied path must not widen what `rm -rf` can reach.
OUT_DIR="${OUT_DIR:-dist}"
mkdir -p "${OUT_DIR}"

# Stage inside a directory this script created itself, and remove only that.
STAGE_ROOT="$(mktemp -d)"
trap 'rm -rf "${STAGE_ROOT}"' EXIT
STAGE_DIR="${STAGE_ROOT}/${NAME}"
mkdir -p "${STAGE_DIR}"
rm -f "${OUT_DIR}/${NAME}.zip"

# Files to include in the distributed extension.
cp manifest.json "${STAGE_DIR}/"
cp content.js    "${STAGE_DIR}/"
cp thread-select.js "${STAGE_DIR}/"
cp inject.js     "${STAGE_DIR}/"
cp popup.html    "${STAGE_DIR}/"
cp popup.js      "${STAGE_DIR}/"
cp README.md     "${STAGE_DIR}/"

# Zip the contents (`.`) of the staging dir, not the staging dir itself, so
# the archive has no top-level folder.
ZIP_ABS="$(cd "${OUT_DIR}" && pwd)/${NAME}.zip"
( cd "${STAGE_DIR}" && zip -r "${ZIP_ABS}" . -x "*.DS_Store" >/dev/null )

echo "Built: ${OUT_DIR}/${NAME}.zip"
unzip -l "${OUT_DIR}/${NAME}.zip" | head -20
