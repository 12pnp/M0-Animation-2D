# E5 — the AI layer re-bound — plan

**Status:** in progress, 2026-10-06. Step 1 (provenance and the contract) done: v2's `tools.json`
with its version note, the gate in `npm run check`. Step 2 (the bridge) done: an MCP client's call
reaches the open rig (`undo`, `redo` built; every argument checked). Step 3 (the read tools) next.

E5 puts the AI tools onto v2's model: an MCP client (Claude Code, Claude Desktop, any agent) and
the in-app Ask AI drive the open rig through the tool contract, each edit one undo step. It is
**done when** `auto_rig` → `apply_motion` → `check_preview` runs end to end via MCP on a fixture
rig, against the tools contract as versioned by D5 — the flow's own tools (`auto_rig`,
`apply_motion`, `check_preview`, `set_keys`, `show`, `get_pose`) keeping their v1 names and
argument shapes (`../../Animation-BoneBurst-Src/docs/EDITOR-V2-PLAN.md` ▸ E5, worded by the owner
on 2026-10-06). Also: every tool v1's `tests/agentApi.test.ts` exercises passes on v2 or is in the
version note; an AI keys a walk on a fixture rig via MCP; the AnimatedDrawings plan's motion half
(AD-3) runs on v2.

```mermaid
flowchart LR
    CL["MCP client<br/>(Claude, any agent)"] -->|"stdio, MCP"| BR["mcp/bridge (lifted, step 2)"]
    BR -->|"local socket"| AB["ui/agent/bridge<br/>(in the editor tab)"]
    ASK["Ask AI panel (step 9)"] --> HOST
    AB --> HOST["agent host (step 3):<br/>tools.json v2 · argument checks ·<br/>one History step 'AI: …' per edit"]
    HOST --> READ["read: get_rig · get_pose ·<br/>show · render_frame"]
    HOST --> KEYS["keys: set_keys … (edit/keys,<br/>edit/boneKeys)"]
    HOST --> BUILD["build: add_bones · attach ·<br/>add_ik · draw_order · auto_rig"]
    HOST --> MOTION["motion: list_motions ·<br/>apply_motion · check_preview"]
    V1["v1 contract tools.json<br/>(frozen in tests)"] -.->|"gate: every drop or rename<br/>in the version note"| HOST
```

## Decisions

- **The contract (D5, refined by the owner 2026-10-06).** v2 serves a versioned `tools.json`.
  Tools keep their names and argument shapes where the meaning holds; `layer` arguments become
  slot names; `set_cycle`, `offset_keys` and the bone-path tools, which Spine has no home for, are
  dropped or renamed. The flow's six tools keep v1's names and argument shapes exactly.
- **The version note is a gate.** The note lives in one place: a `version` block in v2's
  `tools.json` (number, and per tool dropped, renamed or reshaped: what, why, what to use
  instead), so an MCP client reads the contract and its changes together. v1's `tools.json` is
  frozen in the tests; a test compares the two and fails `npm run check` when a v1 tool is gone,
  renamed or reshaped without its line in the note, when the note lists a change that did not
  happen, or when one of the flow's six tools differs from v1 at all. A drop or rename lands in
  the same commit as its line.
- **Clean room: what is lifted, and how.** The v1 files E5 draws on were created in our own
  commits (git: "Phase 9: an AI can animate the open rig", 2026-10-01, and the AI-RIG and AD-3
  work after it; every commit in the fork's history has one author). As in E2, each is checked
  before it is opened for a lift: authorship and dates from git, then its imports, any Animo-side
  name or line, and comments pointing at the old editor; recorded in SPEC §8. **Lifted** where the
  file stands on its own: the contract (`tools.json`), the MCP bridge script, and the rig and
  motion algorithms that work on numbers and names (the rig plan, motion retarget, BVH reader and
  clips, their data). **Rewritten** against v2's model where the file speaks the old model
  (documents, layers, library items, commands): the agent API and its modules, the Ask AI views.
  v1's tests say what each tool must do; they are read for that, and v2's tests are written anew.
- **Where it lives.** `src/agent/` (new, pure: the contract, argument checks, each tool as a
  function of the session's document and the tool's arguments, returning an edit and an answer);
  lifted algorithms beside it (`src/agent/rig/`), importing only the model and each other;
  `src/ui/agent/` for the socket and the Ask AI panel; `mcp/` at the editor's root for the bridge
  script. `scripts/check.sh` gets the layer rule for `src/agent`.
- **Every edit a tool makes is one History step** labelled "AI: …" (SPEC §8), so one undo takes
  a whole `auto_rig` or `apply_motion` back.
- **AnimatedDrawings.** The motion half (AD-3: BVH takes as clips) comes with the motion library.
  The detection half (AD-0..2) has not started in v1 either: it waits for the owner's install
  decision (TorchServe, mmpose; no Apple Silicon wheel for mmcv-full), and does not block E5.

## Steps

Each step gets its own decisions and results here when it starts, as in E4.

1. **Provenance and the contract.** The pass over `tools.json`, the bridge script and the
   agent tests; v2's `tools.json` with its `version` block; v1's frozen beside the tests; the
   gate test; an inventory of the 50 tools (kept, slot-mapped, dropped, renamed, and the step
   that builds each).
2. **The bridge.** The MCP script lifted (stdio ↔ local socket), the editor's end in
   `ui/agent/`; a tool call reaches the open document and answers.
3. **The host and the read tools.** Argument checks from the contract; `get_rig`, `get_pose`,
   `show`, `render_frame`.
4. **The key tools.** `set_keys` and the other keying tools on `edit/keys` and `edit/boneKeys`;
   an AI-keyed walk on the stickman via MCP.
5. **The building tools.** `add_bones`, `attach` (atlas regions in place of library pictures),
   `add_ik`, `draw_order`, and `auto_rig` with the rig plan lifted.
6. **Motion.** `list_motions`, `apply_motion`: the motion library, retarget, BVH reader and the
   AnimatedDrawings clips lifted (AD-3), credited in THIRD-PARTY-NOTICES.
7. **`check_preview`** on v2's engine: what it measures, the same answers as v1 on the same rig.
8. **The rest of the contract**: every remaining tool built, mapped or dropped with its note.
9. **Ask AI**: the `ai` panel, the providers v1 offers, the same tools.
10. **End to end**: an MCP client test (Node, through the bridge, the editor in Playwright's
    Chromium): `auto_rig` → `apply_motion` → `check_preview` on a fixture rig, kept in
    `npm run check`. Then E5 closes.

## Step 1 results

1. **Provenance.** Git, before opening: `tools.json`, the bridge script, `AgentApi.ts`,
   `AgentBridge.ts` and `tests/agentApi.test.ts` were each created in "Phase 9: an AI can animate
   the open rig" (2026-10-01) and changed only in our own commits after it (23, 10, 29, 6 and 26
   commits; one author throughout). Then `tools.json` was opened: data only (no code); no Animo
   name; "tween" only as the animation verb; one "the symbol's constraints"
   (`set_constraint_order`), rewritten as "the skeleton's". Recorded in SPEC §8.
2. **The contract.** v1's `tools.json` frozen byte for byte as `tests/fixtures/tools-v1.json`.
   v2's `src/agent/tools.json`: `{ version, tools }`, version 2 from 1, 46 tools.
   **Dropped** (with why and what to use instead): `set_cycle`, `offset_keys`, `get_bone_path`,
   `set_bone_path`. **Meaning** (same arguments, slot names for layers): `auto_rig`,
   `set_skin_image`, `make_sequence`, `key_sequence`, `link_mesh`, `set_tint`, `key_properties`.
   Prose changed in two descriptions (`apply_motion` no longer points at `set_cycle`;
   `set_constraint_order` as above); schemas otherwise as in v1.
3. **The gate.** `src/agent/contract.ts`: `contractProblems(v1, v2)` and `shape` (a schema
   without its prose, so wording may change and arguments may not). `tests/contract.test.ts`,
   3 tests: the real contract has no problem and the six flow tools' shapes equal v1's; every rule
   on small contracts (unlisted drop, rename, reshape; lines for changes that did not happen;
   flow tools refused even with a line). Three planted faults on the real file (a note line
   removed, a flow tool's `frames` minimum changed, `export_to_unity` removed unlisted) each fail
   it. `scripts/check.sh` gives `src/agent` the layer rule (model, io, edit, engine, itself; no
   DOM).
4. **Inventory.** v1's agent tests call all 50 tools, so all 46 kept tools are built on v2:

| Step | Tools |
|---|---|
| 3 · host and reading | `get_rig`, `get_animation`, `get_pose`, `get_reference`, `show`, `render_frame`, `undo`, `redo` |
| 4 · keys | `new_animation`, `set_keys`, `delete_keys`, `key_ik`, `key_transform`, `key_constraint`, `key_draw_order`, `key_properties`, `define_event`, `key_event`, `set_inherit` |
| 5 · building | `add_bones`, `attach`, `add_ik`, `draw_order`, `auto_rig`, `add_transform_constraint`, `map_transform`, `add_physics`, `add_slider`, `make_path`, `set_constraint_order`, `set_point`, `add_attachment` |
| 6 · motion | `list_motions`, `apply_motion` |
| 7 · checking | `check_preview` |
| 8 · the rest | `export_to_unity`, `make_mesh`, `bind_mesh`, `link_mesh`, `add_skin`, `set_skin_image`, `set_skin_color`, `set_skin_members`, `make_sequence`, `key_sequence`, `set_tint` |

## Step 2 — the bridge

An MCP client's tool call reaches the rig open in the editor and comes back with its answer.
The bridge is a local Node process with no dependencies: MCP over stdio for Claude Code and
Claude Desktop, and an HTTP side on 127.0.0.1 that the editor tab long-polls for calls (no key
or socket server in the page). The same process runs Ask AI's conversations (step 9 builds the
panel), so API keys live only there.

```mermaid
sequenceDiagram
    participant C as MCP client
    participant B as mcp/bridge.mjs
    participant P as ui/agent/bridge (editor tab)
    participant H as agent/host
    P->>B: GET /agent/next (long poll, 25 s)
    C->>B: tools/call {name, arguments}
    B-->>P: {id, name, args}
    P->>H: callTool(name, args, context)
    H-->>P: value, or a refusal for the model
    P->>B: POST /agent/result {id, ok, value | error}
    B-->>C: result content (text, pictures)
```

### Decisions

- **Lifted, after its pass** (SPEC §8): v1's `mcp/boneburst-bridge.mjs` becomes
  `mcp/bridge.mjs` in the editor's folder. Kept: the long-poll protocol (`/agent/next`,
  `/agent/result`, `/agent/status`), MCP over newline-delimited JSON-RPC, the chat providers
  (Claude, GLM) and the key file. Changed: the contract is read from `src/agent/tools.json`
  (`tools`), and `initialize` gives the client the contract's version and its changes from
  version 1 with the instructions, so a client reads what changed where it reads the tools;
  the instructions and Ask AI's system prompt describe v2 (no library, no layers, the PSD is
  dropped on the window); the `AMINO_*` aliases and the old key file name are gone; the
  editor's origins are 5185's; the call timeout can be set (tests).
- **Port 5191** by default (`BONEBURST_BRIDGE_PORT`), so v1's bridge (5190) can run beside it.
- **Every contract tool is listed** by `tools/list`; until a tool is built (steps 3–8) a call
  answers that it is not built in v2 yet, so a client sees the whole contract from the start.
- **The page's end is rewritten** (`ui/agent/bridge.ts`): v1's `AgentBridge` runs the old agent
  API. It long-polls, hands each call to `agent/host.ts` (pure: the contract, dispatch, each
  tool's refusals as messages for the model) and posts the answer.
- **Connecting** is a toolbar button, AI, with a dot: off, looking for the bridge (and the
  command that starts it), connected. Off by default; the choice is kept with the preferences.
- `undo` and `redo` are built here (they need only the history), so the round trip changes the
  document on the first day.

### Steps

1. `mcp/bridge.mjs` lifted; `tests/bridge.test.ts` runs it as a child process: MCP
   `initialize` (the version note in the instructions), `tools/list` (46 tools), a call through
   a fake page and back, a refusal, an unknown tool, a refused origin, no editor connected, and
   a chat turn through a fake provider calling a tool.
2. `agent/host.ts` with `undo`, `redo`; `ui/agent/bridge.ts`; the AI button.
3. On screen: the bridge started, the editor connected, an MCP client (a script over stdio)
   lists the tools and undoes an edit made in the editor.

### Step 2 results

1. `mcp/bridge.mjs` lifted (SPEC §8). `tests/bridge.test.ts`, 6 tests, the bridge as a child
   process: `initialize` carries the version note (a dropped tool, a slot meaning); `tools/list`
   has the 46 tools with their schemas; a call goes to a fake page and its value comes back, a
   refusal comes back as `isError`; an unknown tool (`set_cycle`) is refused; a call nobody answers
   says so; a foreign origin gets 403; Ask AI's `/chat` with a fake provider runs the model's tool
   call in the page and returns its last words, the provider given all 46 tools and v2's prompt.
   Two planted faults fail it (the origin check removed; a refusal resolved as a value).
2. `agent/host.ts` (`callTool`, `AgentRefused`, `undo`, `redo`) and **added**, moved forward from
   step 3: `agent/schema.ts`, the argument checks, since calls arrive here first (the keywords the
   contract uses: type, properties, required, additionalProperties, items, min/maxItems,
   minimum, maximum, exclusiveMinimum, enum, oneOf). `tests/agentHost.test.ts`, 3 tests; two
   planted faults fail them (extra arguments let through; `required` ignored).
   `ui/agent/bridge.ts`; the toolbar's AI button with its dot (Lucide `bot`, added to the
   manifest), kept as the `ai` preference.
3. On screen: a stand-in MCP client (a script that starts the bridge over stdio, as Claude Code
   does) listed 46 tools and read the version note; the AI button pressed by hand; the client saw
   the editor connect, `show` answered that it is not built yet, `undo` with 99 steps was refused
   (at most 50), and `undo` took back "Move bone hips" made in the editor (the hips back at x 400,
   Redo offering it). **Fixed on screen:** the dot stayed amber for up to 25 s after the bridge
   started, since the tab marked itself connected only when a long poll returned; it now asks the
   bridge's status first and turns green at once (1.5 s after a reload with the bridge up). The
   bridge stopped: amber, the start command in the status line; the button pressed again: grey,
   "Disconnected", the preference off.
