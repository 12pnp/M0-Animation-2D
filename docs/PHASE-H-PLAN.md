# Animation tools and the rest (Spine parity, phase H)

Done (2026-10-05): ARCHITECTURE ▸ Constraint order, Offset keys, Key buttons, Events (waveforms,
the Preview queue), Checked in Unity.

docs/SPINE-PARITY-PLAN.md lists what was still ☐ after phase G. Phase H takes those items
except the binary and video ones, which were left out by choice. They are built in this
order:

1. **Constraint order.** `SymbolItem.constraintOrder`, by name (Spine identifies a
   constraint by its name), holds the order the stage solves IK and transform constraints in
   and the order the export writes them. A name the list does not hold goes after the listed
   ones, in the default order. An opened file's order moves here from the carry (schema 24).
   Properties ▸ Constraints (nothing selected) moves a constraint up or down. AI tool:
   `set_constraint_order`.
2. **Offset keys.** The selected layers' keys are moved in time, each row by the step times
   its place when Stagger is on: overlapping action along a chain. A cycle wraps the keys
   round its join. Any other animation keeps its length: what is pushed past the end is cut
   there, and the first pose holds until the moved keys start. The rule is `offsetTrack`, and
   one command makes one undo step. AI tool: `offset_keys`.
3. **Key buttons.** The timeline toolbar's Key button keys what changed. "Changed" means the
   properties of the selected layers that differ from the setup pose at the playhead. Its
   menu keys everything, or one group: rotate, translate, scale or shear. The decisions are
   `changedProps` and `keyProps`. AI tool: `key_properties`.
4. **Waveforms.** The Events row draws each keyed sound's waveform from its frame on, scaled
   by the key's volume. `waveformPeaks` is pure. The decoding is the view's and is cached by
   the sound's blob.
5. **Preview queue.** The Preview's mix bar becomes a queue of any length. Each entry is an
   animation and the mix into it, and the last one loops when Loop is on.
   `AnimationState.addAnimation` plays the queue, with each entry's `setMixDuration`.
6. **Unity check.** Rerun `scripts/unity-check/` on the rigs that have every format change
   since IK keys.
