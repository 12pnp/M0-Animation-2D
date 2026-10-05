# M0-Animation2D — Codex Instructions

This is a Unity 6 / C# project: the Spine 2D animation test bed (the Spine 4.3 runtime forks and BoneBurst, our Burst runtime for Spine data). Before planning or editing, read and follow the canonical project guide: [CLAUDE.md](CLAUDE.md).

## Quick orientation

- Open the project with Unity **6000.6.3f1**. Use the Unity Editor for builds, play-mode validation, and the Unity Test Runner; there is no root-level build or test command.
- The live Editor is the compilation authority after code changes (`unity command recompile` / `recompile_status`, CLAUDE.md *Driving the live Editor*); `Logs/Editor.log` is the fallback when no Editor answers — read only its last compile block.
- `Packages/` is part of this repository. M2-Creator-All and M2-Sample-25DL-Shader take `com.module.ta-creator-boneburst` from this folder by `file:` path, so an edit there is live in both (CLAUDE.md §1).
- `Library/`, `Temp/`, `Logs/`, generated `.csproj` files, and the solution file are Unity-generated. Do not edit or commit them.
- Preserve Unity `.meta` files when moving or creating assets. Never overwrite authored assets in a create path.

## Mandatory project rules

- Read `CLAUDE.md` completely before modifying files.
- Record every change to a Spine fork in that package's changelog, keep the diff against upstream small, and do not change stock behavior: spine-csharp is BoneBurst's parity reference.
- Our own assemblies use `Module.<Tier><Band>.<Name>`; run `python3 .claude/skills/assembly-tier-check/tiercheck.py` after any `.asmdef` change.
- For any new Markdown document, include a Mermaid diagram near the top that represents the actual project mechanism.
