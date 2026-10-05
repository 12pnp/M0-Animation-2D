# Events and animation mixing (Spine parity, phase A)

Done (ARCHITECTURE ▸ Events). docs/SPINE-PARITY-PLAN.md ▸ Phase A. An animation fires named events at frames (footsteps,
hits, sounds), as Spine's `events` timeline does; the Preview shows them firing, plays their
sounds, and crossfades two animations the way a game mixes them.

Before this, an opened file's events were carried (`SymbolItem.spine.events`,
`Animation.spine.events`) and nothing here created or edited them.

## Spine's format (spine-core 4.3.13, `SkeletonJson`)

- Skeleton `events`: `{ name: { int, float, string, audio, volume, balance } }`, defaults 0, 0,
  "", none, 1, 0. Volume and balance are read only when `audio` is set.
- Animation `events`: `[{ time, name, int, float, string, volume, balance }]`, each value
  defaulting to the event's own. An event fires when the playhead passes its time
  (`EventTimeline.apply`: after `lastTime`, up to and including `time`).
- **A runtime bug to write around:** a key's `balance` defaults to the event's VOLUME
  (`event.balance = getValue(eventMap, "balance", setup.volume)`). The export writes
  `balance` on every key of an event with audio.
- **Found while building it:** an event's missing `volume` reads as 0 (`Event.volume = 0`),
  not 1. The export writes `volume` and `balance` on every event with audio.

## The model (schema 19)

```ts
interface EventDef { name: string; int?: number; float?: number; string?: string;
                     audio?: string; volume?: number; balance?: number }
interface EventKey { frame: number; name: string; int?: number; float?: number;
                     string?: string; volume?: number; balance?: number }
SymbolItem.events?: EventDef[]      // unique names
Animation.events?: EventKey[]       // sorted by frame; several may share a frame
```

A key's absent value is the event's own. Pure functions in `core/doc/events.ts`, table-tested:
`eventValues(def, key)`, `withEventKey`, `moveEventKeys`, `deleteEventKeys`,
`renamedEvent` (keys follow a rename), `withoutEvent` (a deleted event's keys go too),
`eventsAt(anim, frame)`.

## Steps

1. **Model.** Types, schema (sanitize: unique names, keys of known events only), migration,
   `core/doc/events.ts`, commands (`SetEventDefs`, `SetEventKeys`), tests.
2. **Export and import.** The exporter writes the exported symbol's events and each
   animation's `events` timeline (an event key extends the animation's end like any key); a
   nested symbol's event keys get a warning. The importer turns the file's events into the
   model, and an animation's keys when each lands on a frame (else that animation's timeline
   is carried). Parity: spine-core fires each event on its frame with its values.
3. **Timeline.** An Events row under Draw order: a marker per frame that has events (a count
   when several), the name beside it when there is room. A press picks the frame's keys, a
   drag moves them, Delete removes them. Right-click: Add Event Here ▸ each event, New
   Event…, and Delete.
4. **Events panel.** The event list (add, rename, delete, int, float, string, sound, volume,
   balance) and, when event keys are picked on the timeline, their values at that frame
   (each blank field falls back to the event's).
5. **Sounds.** `SoundStore`, outside the document like images (`AssetStore`): sound files
   by the event's audio path, saved in the `.boneburst` under `sounds/` and written by the
   export into an `audio/` folder next to the skeleton.
6. **Preview.** The runtime's events (`AnimationState` listener) listed as they fire, and
   their sounds played at their volume and balance. Mixing: "from", "to" and a mix duration
   (`AnimationStateData.setMix`); Play Mix plays "from" once, then "to" crossfaded in.
7. **AI.** `define_event`, `key_event`; `get_rig` lists the events and `get_animation` the
   keys.
8. **Docs.** ARCHITECTURE ▸ Events.

## Out of scope

- Events inside nested symbols: the exporter flattens nested symbols into one skeleton, with
  one event list, so only the exported symbol's are written.
- Audio on the stage's own playback (the Preview plays the runtime, which is ground truth).
