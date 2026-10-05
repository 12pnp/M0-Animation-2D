#!/usr/bin/env bash
# Strict-float parity harness (Doc/Review/BoneBurst-ParityPlan.md, F1).
# Builds with the .NET SDK bundled in the project's Unity version and runs from the project root.
#   run.sh                         every parity test class
#   run.sh SetupPoseParityTests    only the named classes
#   run.sh --dump <in> <out>       pose the Spine exports in <in> for the BoneBurst editor's own comparison (Dump.cs)
# Needs: that Unity version installed under /Applications/Unity/Hub/Editor, and the project opened once
# (Library/ScriptAssemblies provides Unity.Collections and Unity.Burst).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
version="$(sed -n 's/^m_EditorVersion: //p' "$root/ProjectSettings/ProjectVersion.txt")"
scripting="/Applications/Unity/Hub/Editor/$version/Unity.app/Contents/Resources/Scripting"
dotnet="$scripting/DotNetSdk/dotnet"
[ -x "$dotnet" ] || { echo "no .NET SDK at $dotnet (Unity $version installed?)" >&2; exit 2; }
[ -f "$root/Library/ScriptAssemblies/Unity.Collections.dll" ] || { echo "open the project in Unity once first" >&2; exit 2; }

# A failed build must stop the run: an old ParityHarness.dll would report stale results.
if ! build_log="$("$dotnet" build "$here/ParityHarness.csproj" -nologo -v q -c Release \
    -p:UnityManaged="$scripting/Managed/" -o "$here/bin/out" 2>&1)"; then
  echo "$build_log" | grep -E "error" >&2
  echo "BUILD FAILED" >&2
  exit 3
fi
cd "$root"
exec "$dotnet" "$here/bin/out/ParityHarness.dll" "$@"
