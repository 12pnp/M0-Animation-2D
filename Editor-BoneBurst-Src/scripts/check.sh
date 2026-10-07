#!/usr/bin/env bash
# Before anything lands: typecheck and build, the tests (zero tests is a failure),
# and the licence guards a passing build does not catch.
set -euo pipefail
cd "$(dirname "$0")/.."

out=$(npm run build 2>&1) || { echo "$out"; exit 1; }
echo "$out" | grep -E 'dist/assets/.*\.js ' || true
# Every chunk under Vite's 500 kB warning (E7-PLAN step 3): the PSD reader and the AI layer load
# when first used, Dockview in a chunk of its own.
if echo "$out" | grep -q 'Some chunks are larger'; then echo "error: a chunk is over 500 kB" >&2; exit 1; fi
out=$(npx vitest run 2>&1) || { echo "$out"; exit 1; }
echo "$out" | tail -4
if echo "$out" | grep -qE 'Tests +0 passed|No test files found'; then
  echo "error: no tests ran" >&2; exit 1
fi

# The browser tests (E4 step 15): popout windows, which only a real browser shows. Playwright's
# Chromium is installed once per machine.
if ! node -e 'require("fs").accessSync(require("@playwright/test").chromium.executablePath())' 2>/dev/null; then
  echo "error: Playwright's Chromium is not installed: run npx playwright install chromium" >&2; exit 1
fi
out=$(npx playwright test 2>&1) || { echo "$out"; exit 1; }
echo "$out" | tail -2
if ! echo "$out" | grep -qE '[1-9][0-9]* passed'; then echo "error: no browser tests ran" >&2; exit 1; fi
# The build as npm start serves it (E7-PLAN step 3).
out=$(npx playwright test -c playwright.build.config.ts 2>&1) || { echo "$out"; exit 1; }
echo "$out" | tail -2
if ! echo "$out" | grep -qE '[1-9][0-9]* passed'; then echo "error: no build browser tests ran" >&2; exit 1; fi

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
# The layer rule (docs/SPEC.md §1): model imports nothing of ours; io, edit and engine import
# the model and their own folder only. None of them may touch the DOM.
layer() { # folder, allowed import prefixes (regex)
  local bad
  [ -d "src/$1" ] || return 0
  bad=$(grep -rnE '^import .* from "(@/|\.\./)' "src/$1" | grep -vE "from \"($2)" || true)
  if [ -n "$bad" ]; then echo "$bad"; echo "error: src/$1 imports above its layer" >&2; exit 1; fi
}
layer model '@/model/|\./'
layer io '@/model/|@/io/|@/motion|\./'
layer edit '@/model/|@/edit/|\./'
layer engine '@/model/|@/engine/|\./'
# The path motion (docs/TWO-SYSTEMS-PLAN.md): its own system, apart from the key animation: only the path's own data (the sidecar's types) and the error
# class; no rig, no document, no edit layer. edit and engine do not import it either (their layers above do not list it).
layer motion '@/model/sidecar|@/model/refused|@/motion/|\./'
# The AI tools (E5): pure like the document's layers, above them, below the interface.
layer agent '@/model/|@/io/|@/edit/|@/engine/|@/agent/|\./'
pure=""
for d in src/model src/io src/edit src/engine src/agent src/motion; do if [ -d "$d" ]; then pure="$pure $d"; fi; done
dom=$(grep -rnE '\b(document|window|navigator)\.[a-zA-Z]|\bHTML[A-Za-z]*Element\b|requestAnimationFrame' $pure \
  | grep -vE '^[^:]+:[0-9]+:\s*(\*|//|/\*)' || true)
if [ -n "$dom" ]; then echo "$dom"; echo "error: a pure layer touches the DOM" >&2; exit 1; fi

# The package itself, not the word (the engine's comments name spine-core as its oracle). Read
# from the source maps, which keep module paths: vite.config.ts builds them.
if [ -d dist ] && grep -rlE '@esotericsoftware/|node_modules/@esotericsoftware' dist/; then
  echo "error: dist/ carries a Spine runtime" >&2; exit 1
fi

# D6 + D7: the runtime dependencies are exactly ag-psd and dockview-core, each pinned; anything
# else that ships is a vendored asset listed in THIRD-PARTY-NOTICES.md.
deps=$(node -e 'const d=require("./package.json").dependencies||{}; console.log(Object.entries(d).sort().map(([k,v])=>k+"@"+v).join(" "))')
if ! echo "$deps" | grep -qE '^ag-psd@[0-9]+\.[0-9]+\.[0-9]+ dockview-core@[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "error: runtime dependencies must be exactly pinned ag-psd and dockview-core, found: $deps" >&2; exit 1
fi

echo "check: all passed"
