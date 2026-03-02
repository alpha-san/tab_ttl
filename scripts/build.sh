#!/usr/bin/env bash
set -euo pipefail

DIST_DIR="dist"
OUTPUT_ZIP="${DIST_DIR}/tab-ttl.zip"

mkdir -p "$DIST_DIR"

# Remove any previous build
rm -f "$OUTPUT_ZIP"

zip -r "$OUTPUT_ZIP" \
  manifest.json \
  background/ \
  popup/ \
  options/ \
  utils/ \
  icons/ \
  --exclude "*.sh" \
  --exclude "*/.DS_Store" \
  --exclude "*/Thumbs.db"

echo "Built: ${OUTPUT_ZIP}"
