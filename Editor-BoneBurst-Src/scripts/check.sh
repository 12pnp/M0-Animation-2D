#!/usr/bin/env bash
# Before anything lands: typecheck and build, the tests (zero tests is a failure),
# and the licence guards a passing build does not catch.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
out=$(npx vitest run 2>&1) || { echo "$out"; exit 1; }
echo "$out" | tail -4
if echo "$out" | grep -qE 'Tests +0 passed|No test files found'; then
  echo "error: no tests ran" >&2; exit 1
fi

# Spine's official runtimes are under the Spine Runtimes License: dev-only
# oracles at most, never imported by the app.
if grep -rnE 'from "@esotericsoftware/|require\("@esotericsoftware/' src/; then
  echo "error: src/ imports a Spine runtime package" >&2; exit 1
fi
# Clean-room tripwire (CLAUDE.md ▸ Clean room): the fork's project name must
# not appear in the app's code.
if grep -rniE '\banimo\b' src/; then
  echo "error: src/ names the Animo fork" >&2; exit 1
fi
if [ -d dist ] && grep -rlE 'esotericsoftware|spine-core|spine-pixi' dist/; then
  echo "error: dist/ carries a Spine runtime" >&2; exit 1
fi

echo "check: all passed"
