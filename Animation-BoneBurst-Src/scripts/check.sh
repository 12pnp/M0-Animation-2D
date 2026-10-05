#!/usr/bin/env bash
# What a change must pass before it lands: the build, the tests, and the two rules
# a passing build does not catch. Run from this folder.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
npm test

# The Preview's oracle belongs to `npm run dev:oracle` only (docs/PREVIEW-RUNTIME-PLAN.md P4).
if [ -e dist/vendor/spine-pixi-v8.js ] || grep -l 'vendor/spine-pixi-v8\|SpineTexture' dist/assets/*.js; then
  echo "error: spine-pixi-v8 is in dist/; it belongs to npm run dev:oracle only" >&2
  exit 1
fi

# core/ imports nothing from a layer above it (CLAUDE.md, rule 1).
if grep -rn 'from "@/\(view\|app\|io\)' src/core/; then
  echo "error: core/ imports from a layer above it" >&2
  exit 1
fi

echo "check: all passed"
