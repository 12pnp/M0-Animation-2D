# Amino Spine2D

A Flash-style animation editor for **Spine 4.3**, built from
[Animo](https://github.com/justmorenoise/animo) by Morenoise.

Animo has a timeline, layers, keyframes, symbols, bones and IK, masks and PSD
import, and it exports DragonBones. Amino Spine2D keeps the editor and changes
what it writes to Spine: a skeleton `.json`, a `.atlas` and its pages, played in
the editor by the official Spine runtime. It also opens existing Spine files for
editing. Later an AI will be able to drive the editor.

```mermaid
flowchart LR
    DOC["core/doc<br/>document + frame algebra"] --> STAGE["Canvas2D stage"]
    DOC --> EXP["core/export<br/>Spine 4.3 exporter"]
    EXP --> FILES["name.json · name.atlas · pages"]
    EXP -->|"same bytes"| PREV["Preview<br/>spine-pixi-v8"]
    FILES --> GAME["Unity / Pixi / any Spine 4.3 runtime"]
    FILES --> IMP["Spine import"] --> DOC
```

## Status

**Phases 0–7 of [docs/PLAN.md](docs/PLAN.md) are done.** The editor works as
Animo's does; **File ▸ Export Spine** writes `<name>.json`, `<name>.atlas` and
the atlas pages for Spine 4.3; and the **Preview panel and Play mode run the
official Spine runtime** (spine-pixi-v8) on those exact files, matching the stage
frame by frame: eases, IK, nested symbols, masks (as Spine clipping) and colour
offsets (as two-colour tint) included. **File ▸ Open Spine** opens a Spine 4.3
JSON export (with its atlas and pages, or a zip of them) for editing. Meshes,
constraints, physics and other skins are shown through the Spine runtime and
written back unchanged. Next: checking the exports in Unity (phase 8).

## Quick start

```bash
npm install
npm run dev       # http://localhost:5181
```

Chrome or Edge. The port is not Animo's 5180 on purpose. Browser storage is
per origin, so on one port the two editors would share preferences and
overwrite each other's autosave.

```bash
npm test          # vitest
npm run build     # tsc --noEmit && vite build
```

## Documentation

- [docs/PLAN.md](docs/PLAN.md): the phases, how DragonBones concepts map onto
  Spine, and the export tests to rebuild.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): Animo's architecture
  document. The editor sections still apply; its note at the top lists the
  DragonBones sections that no longer do.

## Licence

**AGPL-3.0-or-later**, inherited from Animo. See [LICENSE](LICENSE),
[LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md) and
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). What you export is yours.

Spine is a trademark of Esoteric Software. Using the Spine runtimes requires a
Spine Editor licence. This project is not affiliated with Esoteric Software or
with Morenoise.
