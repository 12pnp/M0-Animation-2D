A "key poses → AI in-betweens" workflow. Today the user keys good poses in the timeline and the Ask AI panel can animate, but the two are not connected: picking *which* frames are the poses, showing them, and handing them to the AI (or to disk, for an external AI) is all manual. Plan: a new **Poses** tab beside Timeline/Reference, where the human curates the animation's key-pose frames (1, 10, 20 …), sees a rendered thumbnail of each, and with one button either asks the in-app AI to generate the remaining frames or exports the poses as a proper artifact (a zip of PNGs + the frame list).

## The tab — `src/view/panels/PosesPanel.ts` (new)

Docked in the bottom group with Timeline and Reference: defaults become `[["timeline", "reference", "poses"]]` in `App.ts`; the Dock prune group-mate rule (from the Reference change) places it beside them for existing stored layouts — no migration needed there. `PANEL_COMMANDS` gains `poses` (Window ▸ Poses). Icon: the existing `multiFrames` (stacked frames). Title: "Poses".

Layout, mirroring the Reference panel's structure:
- A strip of pose cards: thumbnail (the posed skeleton at that frame) + editable frame-number badge (the same NumberField pattern as Reference's) + a × to remove. Click a card → playhead jumps.
- "Add frame" adds the playhead's frame; "From keyed frames" adds every frame that already has keys (the "good poses in the timeline" starting point). Duplicates and out-of-order adds are fine — the list shows them sorted, unique.
- Hint line: what the AI will be asked, and the 6-picture cap of the handoff.

## The model — `Animation.poses` (`src/core/doc/types.ts`)

- `poses?: number[]` — the curated frames, kept sorted and unique by the panel/service; no timing semantics (unlike reference's `at`), just "these frames are the poses". Saved in the project file, never exported to Spine.
- Document version 11 → 12, additive migration (absent `poses` reads as none) — same pattern as reference's v10 entry; schema sanitizes to whole numbers ≥ 0, unique, sorted.
- A `PosesService` (or plain store commands, whichever matches how ReferenceService earns its keep — likely a small service: add/remove/move + the render/handoff glue) writes via one undo step per action, `SetAnimationPoses` beside `SetAnimationReference` in `core/history/timelineCommands.ts`.

## The pictures — shared framing in `src/view/agent/AgentVision.ts`

`PageVision` gains `renderPoses(symbol, animation, frames, { bones })`: one `imageFrame` computed over **all** the poses' boxes so every picture frames identically (per-frame framing would make poses hard to compare), then the existing `SceneRenderer` draw per frame, encoded as PNG base64 (`AgentImage`). Thumbnails use `bones: false` (clean pose); the AI handoff uses `bones: true` (the annotated, bone-named pictures `render_frame` already produces — the model reads those best).

## The handoff — "Ask AI to fill in"

- `AiPanel` (src/view/agent/AiPanel.ts) gets a public `ask(text: string, pictures: Picture[])`: sets the message and attachments and runs the existing send path (extract `go()`'s body to take them as arguments; the button keeps calling it with the input's own contents). `Picture` becomes an exported type.
- The Poses panel builds the prompt (pure function, unit-tested): the animation's name, "picture 1 = frame 1, picture 2 = frame 10 …", the poses' keys are already set and must be kept exactly (`get_animation`), and the ask: key the in-between frames between each pair of poses with "inout" eases (body motion), few keys per bone, one `set_keys` call per segment, finish with `check_preview` and show it.
- The button: renders the pose pictures (≤ 6, capped with a note — the bridge's picture budget), calls `aiPanel.ask(prompt, pictures)`, and opens the AI panel (`Shell`'s AI panel toggle). If the bridge is keyless/not connected, the AI panel already says so.
- `get_animation`'s reply gains `poses: [1, 10, 20]` when the animation has them, so the model can re-find them after reloads.

## The export — "Export…" (for keeping, or an external AI)

One button: a zip via `io/zip.ts`'s `zipFiles` + `ExportBundle.ts`'s `downloadBlob`, named `<anim>-poses.zip`:
- `<anim>-pose-f<frame>.png` per pose — the clean (`bones: false`) renders, full size;
- `poses.json` — `{ animation, fps, frames: [...] }`, the frame list an external pipeline needs.

## Tests

- Schema/migration (v11 file → v12, `poses` sanitized: sorted, unique, whole ≥ 0) — in the reference/schema test's home.
- The prompt builder: name, picture↔frame mapping, "keep the pose keys" instruction; cap at 6 with the note.
- `PosesService` add/remove/move = one undo step each, sorted-unique invariant (history test pattern from reference's).

## Verification

- `npm test`, `npx tsc --noEmit`.
- Live, in a fresh IAB tab (stale-module lesson learned): the Poses tab appears beside Reference; "From keyed frames" lists the keyed frames of an animation; badges editable; "Ask AI to fill in" opens the AI panel with the poses attached (visible in the pending strip before send) — full send needs the real GLM key, still pending; "Export…" downloads a zip that unzips to the PNGs + poses.json.
