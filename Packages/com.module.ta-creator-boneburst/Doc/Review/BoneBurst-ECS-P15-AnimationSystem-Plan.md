# BoneBurst ECS P15: the animation system's cost — plan

**Status: plan only, nothing built (2026-10-07); a TwinSpline-readiness section added 2026-10-08 (§7), after the owner moved the work to the ECS package (`D2-FrontPackageSample-Decision.md`).** Part of [BoneBurst-ECS-Plan.md](BoneBurst-ECS-Plan.md) (after §24, P14); the summary of all phases is [BoneBurst-ECS-Summary.md](BoneBurst-ECS-Summary.md).

After P14 the animation system is the largest piece of the ECS frame at 2000 skeletons: 0.75 ms when they idle and 2.0 ms when they keep switching animation, of a 2.9 to 4.5 ms frame. It is a single-threaded, managed loop over the entities. The plan is to keep the request handling on the main thread (it is rare) and move everything that happens every frame, for every skeleton, into Burst jobs, the way P14 did for the pose.

```mermaid
flowchart TB
    subgraph NOW["Today: BoneBurstAnimationSystem.OnUpdate, main thread, one entity at a time"]
        direction LR
        N1["BufferLookup[entity]<br/>events.Clear · requests"] --> N2["settingsLookup.TryGetComponent"]
        N2 --> N3["store.Track(index)<br/>(a struct inside a managed class)"]
        N3 --> N4["TryAdvanceSteady / Update / Apply<br/>BoneTrackState, not Burst"]
        N4 --> N5["store.AdvanceTime · Stage · Move events"]
    end
    subgraph NEXT["P15: the same work, in jobs"]
        direction LR
        G["Gather job (IJobChunk)<br/>index · scaled dt · has requests"] --> R["main thread, flagged only:<br/>requests · skin requests · physics input"]
        R --> A["Animate job (IJobParallelFor, Burst)<br/>TryAdvanceSteady · Update · Apply · time<br/>on BoneTrackState in native memory"]
        A --> F["main thread, flagged only:<br/>slot flags · events to buffers"]
        F --> P["Pose: headers read the track's lists directly"]
    end
    NOW -.->|"replaced by"| NEXT
```

## 1. What the numbers say

Measured at 2000 skeletons with the shell timer (`-shell 1`), build 38 (P13), milliseconds per frame:

| | animation total | requests | update | apply | stage | everything else in the loop |
|---|---|---|---|---|---|---|
| idle | 0.75 | 0.04 | 0.13 | 0.03 | 0.04 | about 0.50 |
| switching | 2.03 | 0.06 | 0.28 | 1.09 | 0.05 | about 0.55 |

Two readings:

1.  **Idle: two thirds of the system is neither the animation maths nor the staging.** It is the per-entity plumbing: two `BufferLookup` reads per entity (the event buffer is cleared, the request buffer checked), a `ComponentLookup` for the optional time settings, the list lookup of the instance slot, and the `ToEntityArray` and `ToComponentDataArray` copies. The caveat: each timer scope costs two `Stopwatch` reads, and there are four per entity in the animation system (requests, update, apply, stage), so about 0.15 ms of the "everything else" is the timers themselves; the real remainder is measured with the timers off (step 1 below).
2.  **Switching: `Apply` is the cost** (1.09 ms). About a fifth of the skeletons are crossfading at any moment, and a crossfade applies two animations and mixes them, so those skeletons write many more commands than a skeleton that loops one animation (which takes the steady shortcut and skips `Apply` entirely). `Apply` is plain C# on the main thread today, although `BoneTrackState` is an unmanaged struct (native lists and pointers, no managed references, no `Debug` calls), which is exactly what Burst compiles.

## 2. How I will solve it

The pose work in P14 showed the pattern: the maths is already pointer code, the cost is that it runs on one thread and waits. So:

**A. Put `BoneTrackState` in native memory.** Today it is a field of the managed `InstanceSlot` class, whose address the garbage collector may change, so a job cannot hold a pointer to it. Each instance gets a native allocation for its state (`UnsafeUtility.Malloc`), freed with the instance. `store.Track(index)` keeps returning `ref` (to the native struct), so callers and tests do not change.

**B. An animate job over the active instances.** One work item per instance that has an animation entry **and no physics**: `TryAdvanceSteady(dt)`, else `Update(dt)` then `Apply()`, then the skeleton clock (`Skeleton.Time += dt`). **Physics instances are excluded from the job entirely in the first cut:** `InheritMovement` runs between `Update` and `Apply` in `OnUpdate`, so a job that does Update and Apply as one step cannot include them; they keep the existing main-thread path. It runs in Burst with the same `FloatMode.Strict` setting as the pose job, so it matches the managed reference as closely as the pose does. Instances write only their own memory, so the job is safely parallel. That also rests on the state's lists being `Allocator.Persistent` (`BoneBurstInstanceStore` creates each `BoneTrackState` with it): growing an `UnsafeList` from several threads is safe only because each instance owns its allocations; a later switch to `TempJob` or a shared allocator would break the job silently, so a test asserts the allocator. It returns, per instance, flags: stepped steadily, staged, has events.

**C. The staging goes away as a copy.** `Stage` copies four list headers from the state into the slot so that `TakeHeader` can find the commands. With the state in native memory, `TakeHeader` reads the lists from the state directly (the path that stages a hand-made `CommandBuffer`, used by the tests and by anything driving the store manually, stays).

**D. A gather job instead of the per-entity lookups.** An `IJobChunk` over the query reads, per entity, the instance index, the scaled time step (the optional `BoneBurstAnimationSettings`) and whether the request buffer is empty, into plain arrays. The main thread then touches only the entities that have requests (a few dozen a frame when everything switches, none when idle) and the ones that have physics. **Where the physics bit comes from:** `store.HasPhysics(index)` is a call into the managed `InstanceSlot` list, which is part of the plumbing this step removes. The store keeps a native array of per-instance flags (physics, and later others), set in `CreateInstance` from the asset and cleared on destroy and reuse of the slot, and the gather job reads that. A stale bit would send a physics instance into the job (wrong, no inherited movement) or keep a plain one out of it (slow, silently), so it has its own deliberate-bug test. The event buffers are cleared and filled only for entities that had events last frame or have them now (a per-instance flag), not once per entity per frame.

**E. A small main-thread tail** after the job, flagged instances only (and the **after-animation system** gets the same treatment, E2): set the slot flags that say "applied, stepped, dirty" (`Pending |= Dirty` and the rest), and move delivered events into the entity buffers.

**E2. The after-animation system pays the same plumbing.** `BoneBurstAnimationAfterSystem` does `ToEntityArray` and `ToComponentDataArray` copies and a managed loop over every entity just to skip the unstepped ones (`WasStepped`). It reads the same native flags: a gather over the query once (shared with D where the query allows), then `AfterApply` only for stepped instances and the event move only for those with events. If the gate measured only the `Animation` timer, the frame would gain less than the number says, so the `After` timer is measured with it and the gate counts both.

**F. Then, only if the numbers ask for it: pipeline it with the pose.** The animate job per chunk, then the headers of that chunk, then the pose job of that chunk, the same overlap P14 built between the headers and the pose. Not part of the first cut; decided from the measurement.

What does not change: the animation maths (`BoneTrackState.Update`, `Apply`, `AfterApply` are moved, not rewritten), the request semantics and their order within a frame, the events a skeleton delivers, the public components (`BoneBurstAnimationRequest`, `BoneBurstTrackEvent`, `BoneBurstAnimationSettings`).

## 3. Steps

1.  **Baseline with the timers off.** The same ABBA benchmark as P12 to P14 (the frame time is the metric; the shell timer is a diagnostic), so the plumbing cost is not mixed with the timers' own cost. Idle and switching at 2000, both routes.
2.  **Native track state** (A) with the existing tests unchanged: all 384 must pass before anything else moves.
3.  **The animate job** (B, C), after replacing `AnimationsChanged`'s `Temp` hash map with a state-owned persistent scratch (§6), behind the existing system: first the job replaces only the update and apply lines, the lookups stay; measure.
4.  **The gather job and the flagged tails** (D, E, and the after-animation system, E2); measure both timers and the frame.
5.  **Pipelining** (F) only if the animation or pose total is still the largest single piece and the overlap is worth its complexity.
6.  **Record** the results in this file and in the plan, update the summary, the changelog entry when committing.

## 4. How it is checked

*   **Existing guards, unchanged:** `TrackStateParityTests` (the ECS track state against the managed `BoneAnimationState`, every frame, fuzzed), `AnimationSystemTests` (requests, mixing, events, end-to-end through the systems) and the 24-fixture pose and mesh tests. The job must pass them without a tolerance change.
*   **A deliberate bug for each new piece, and each must fail a test:** the animate job skipping `Apply`; a stale physics bit (a physics instance sent into the job, a plain one kept out); the persistent scratch map not cleared between uses (a hold computed from the last frame's ids); the track state allocated with a non-persistent allocator (a test asserts the allocator); the gather job reading the wrong time scale; the flagged tail not delivering events; the native track state freed one frame early. The P14 lesson applies: a guard that no test reaches is no guard, and a bug in chunked work did not fail any test until a test had more instances than one chunk. So the tests that matter run with more instances than one job batch (a new test with a batch of one and many instances, mixed animations, requests on some and not on others, physics on one).
*   **On screen:** the benchmark scene in a player and an Editor capture at 100 skeletons, switching, compared with the previous build by eye (the animation does not look different) and by the instance poses (the existing tests).
*   **Performance:** ABBA, release players, CoreCLR (both runtimes on the same backend, P12), load average noted, differences under about 5% not claimed.

## 5. Gate

Done when, at 2000 skeletons, the animation system's total (timers on) falls from 0.75 to 0.40 ms or less idle and from 2.0 to 1.0 ms or less switching, the after-animation system's total (measured first, step 1, and recorded here) falls too, the frame time falls by the same amount in the timer-free ABBA run, all 384 tests plus the new ones pass, and each deliberate bug fails a test. If the floor turns out to be elsewhere (the gather job, the flagged tail), the phase reports where and why instead of claiming the target.

## 6. Risks and what I do not know yet

*   **Burst will refuse one thing in `Apply`, and it is known.** `BoneTrackState.AnimationsChanged` (`BoneTrackState.cs:812`) allocates `new NativeHashMap<ulong, long>(64, Allocator.Temp)` and is reached from `Apply` whenever a start or end event set `m_AnimationsChanged` (line 961, run at line 535): on exactly the switching path. A `Temp` allocation inside a parallel job is not allowed. Step 3 replaces it with a scratch map the state owns (`Allocator.Persistent`, cleared on use, disposed with the state), same contents and order, before the job exists, with the existing hold tests as the guard. Other Burst limits (the `Step` struct, generic container use) are found with the compiler in the same step.
*   **The 2.0 ms may not be all `Apply`.** The timer says 1.09 ms; the rest of the switching cost may be request handling (set animation allocates track entries) which stays on the main thread. The first measurement after step 3 says how much of the 2.0 ms the job really takes.
*   **Events and listener semantics.** Events are queued during `Update` and `AfterApply`, delivered through the buffer. Moving `Update` into a job must keep the order of start, interrupt, end and dispose events per skeleton; the fuzz in `TrackStateParityTests` and `AnimationSystemTests` is the guard, and a skeleton firing its first event only in a later frame would be a failure.
*   **Physics instances are out of the job in the first cut.** They need the entity's transform and a physics input between `Update` and `Apply`, which a one-step job cannot give; they keep the main-thread path (a few per scene). Splitting the job in two with the movement between them is a later change if physics skeletons become common.
*   **Editor crashes.** A wrong pointer in a Burst job takes the Editor down (P14's deliberate bug did). The deliberate-bug runs happen one at a time, with the source restored from a copy straight afterwards.

## 7. Ready for pure TwinSpline (added 2026-10-08, the owner: "start P15, for soon support pure TwinSpline")

The BoneBurst Editor v2 can now export a skeleton whose bones' translate motion is a **TwinSpline path** in a file beside the Spine JSON: `name.twinspline.json`, version 1, seconds, `{ animation: { bone: { parent?, duration, loop, closed, nodes[x, y, tx, ty, bx, by, speed, ss, sb] } } }` (editor `docs/SPEC.md` §3 and §5, `docs/UNITY-EXPORT-PLAN.md`; the writer and reader are `edit/exportTwin.ts`). Nothing in Unity reads it yet. This section says what P15 must leave open for that, and what the TwinSpline phase (call it P16) is, so the two are designed together as this plan's header asks.

```mermaid
flowchart LR
    subgraph FILE["Export"]
        J["name.json<br/>no translate timelines<br/>for those bones"]
        T["name.twinspline.json<br/>paths in seconds"]
    end
    subgraph BAKE["Bake (P16)"]
        D["BoneBurstData:<br/>TimelineKind.BoneTranslateSpline<br/>nodes · speeds · duration · loop"]
        B["SkeletonBlobData<br/>AnimationBlob timeline"]
    end
    subgraph RUN["Runtime"]
        TA["TimelineApply<br/>(pose job, Burst)<br/>TwinSplineMath.Pose(t)"]
        AN["P15 animate job<br/>entry time · mixing · alpha<br/>(unchanged by P16)"]
    end
    J --> D
    T --> D
    D --> B --> TA
    AN -->|"entry animation time"| TA
```

**The design choice: a path is a translate timeline that samples a spline instead of keys.** The editor's path has its own clock; Unity does not need one. For an exported animation the path's time is the animation entry's time from 0 (a looping path starts over each run, any other holds its last place), exactly the rule the editor's *Spine keys* export bakes by (`ui/pathKeysOver.ts`). So the path rides the machinery that already exists: track entries, looping, crossfades, alpha and hold in `BoneTrackState` and `TimelineApply` apply it like any translate timeline. **P16 therefore adds no clock, no system and no component**; it adds a timeline kind.

What that asks of P15 (nothing new to build, but things not to break):

1.  **P15 does not touch timeline evaluation.** The animate job (§2 B) advances entry times and mixes; the pose job evaluates timelines. A path timeline is evaluated in the pose job from the entry's animation time, which P15 already hands over. The native track state (A) must keep `ApplyCommand` carrying the entry's animation time and alpha, as it does.
2.  **No per-bone special case in the animate job.** If P15's job learned to treat translate specially, a path timeline would need it too; it does not.
3.  **A blob that can hold variable-length timelines.** The timeline entries are `TimelineDef.EntriesOf(kind)` floats; a spline timeline is nodes (x, y, tx, ty, bx, by, speed, ss, sb) plus a header. **Closed (2026-10-08, from the code):** `TimelineBlob` already carries variable-length timelines through `ExtraStart` and `ExtraLength` (the deform timeline's `FrameCount × ExtraLength` floats in `BlobView.DeformFrames` is the precedent); a spline timeline treats its nodes as 9-float frames (x, y, tx, ty, bx, by, speed, ss, sb). The real P16 work is on the `-core` side: `TimelineDef` and the bake.

P16 (its own plan when started, nothing built):

1.  **Format in `-core` Data:** `TimelineKind.BoneTranslateSpline`, its `TimelineDef` fields and the `.sbdata` reader and writer version; the bake merges `name.json` and `name.twinspline.json` into one `BoneBurstData` (the sample `-import` Editor bake is frozen; the ECS baker or a reader in `Module.PA.BoneBurst.Import` does it).
2.  **`TwinSplineMath` in `-core` Core, Burst-compatible, no `UnityEngine`:** a port of the editor's `src/motion/` (`curve` the ring and open spline through the nodes with legs and an arc-length table; `speed` the Hermite speed spline, `timeMap`, `progressAtTime`; `pathPose(t)`). Not from the fork; from our own TypeScript.
3.  **The mapping to the bone:** the path's point is in the space of its reference bone; the editor puts it into the bone's parent's space through both bones' matrices. The first cut supports **`parent` equal to the bone's own parent** (the exporter writes that by default), where the point is the bone's local x and y directly and no world matrix is needed; a path relative to another bone is refused at bake with a message, to be added later if wanted. The timeline writes the offset from the setup pose, as a translate timeline does.
4.  **Guards:** the TypeScript is the oracle. A script in the editor writes fixtures (`pathPose` at a few hundred times for several paths: ring, open, with legs, with uneven speeds) and a Unity test compares `TwinSplineMath` to them within 1e-4; an end-to-end test poses the exported pair (Spine JSON plus `.twinspline.json`) and compares with the same skeleton exported by the editor's *Spine keys* mode (keys baked from the same path), which must agree within the baked keys' fit (1.5 units on the stickman). A deliberate bug for each: the speed spline ignored, the loop not wrapped, the setup offset not subtracted.
5.  **Where the `Path` name is taken:** `Core/Constraints/PathSolver.cs` is Spine's path constraint; the new types say `TwinSpline`, never `Path`.

What P16 does not need from P15 is a gate: P15 can be built, measured and committed first. The reverse also holds: P15 should not wait for P16.

## 8. Step 1 result: the baseline (2026-10-08)

**Done.** Player `M0-25DPlatformer-ECS/Build/macOS_BoneBurstEcsBenchmark_57` built from the unmodified ECS package (HEAD `f99cf49`, P14; 10 s, 0 errors) and kept as the "A" build for every later A/B. Runner: ABBA over two repeats (the second in reverse order), Apple M5 Pro, Metal, 1920×1080, vsync off, CoreCLR release, 60 warm-up and 600 measured frames; first pass with the shell timers off, second pass with `-shell 1`. The raw per-run CSVs are in the session's scratchpad (`p15_baseline.py`, `base57/`), not committed. **Load caveat:** the machine carried another session's player loop; load before the runs was 5 to 8 for the timers-on pass and 6 to 14 for the timers-off pass (its second repeat ran at 10 to 14), so the frame figures below are not claims under about 10%, the second repeat of the timers-off pass is the noisier one, and the timers-on pass (load 5 to 7) is the cleaner. Three orphaned `vitest` runs (44 hours at 100% CPU each) were found and stopped before the runs.

Frame time, timers off (median of the two runs, ms; the runs in brackets):

| | EcsGpu | EcsCpu |
|---|---|---|
| idle × 2000 | 2.89 [2.88, 2.90] | 4.99 [4.50, 5.49] |
| switch × 2000 | 4.60 [5.00, 4.19] | 6.55 [6.40, 6.70] |
| switch × 500 | 1.76 [2.00, 1.51] | 2.35 [2.41, 2.29] |
| switch × 100 | 0.50 [0.50, 0.50] | 0.65 [0.70, 0.60] |

Timers on, 2000 skeletons (median of two runs, ms per frame, per system):

| | animation | requests | update | apply | stage | after | pose | frame (timers on) |
|---|---|---|---|---|---|---|---|---|
| Gpu idle | **0.73** | 0.053 | 0.121 | 0.029 | 0.043 | **0.17** | 1.11 | 2.76 |
| Cpu idle | 0.74 | 0.044 | 0.127 | 0.027 | 0.037 | 0.20 | 1.66 | 4.45 |
| Gpu switch | **1.84** | 0.058 | 0.212 | 1.03 | 0.044 | **0.39** | 1.48 | 4.40 |
| Cpu switch | 1.79 | 0.049 | 0.244 | 0.96 | 0.038 | 0.40 | 1.96 | 5.90 |

What it says, against §1:

*   **The plumbing reading holds.** Idle, the four per-entity phase timers add up to 0.24 ms against 0.73 for the system: about 0.5 ms is the loop around them (lookups, copies, and the timers' own cost, which the timers-off frame times bound: the frame is the same with them off).
*   **Switching: `Apply` is the cost,** 1.0 of 1.8 ms, as the plan said. Update 0.2, the rest plumbing.
*   **The after-animation system is not small:** 0.17 to 0.20 ms idle and 0.39 to 0.40 ms switching, about a fifth of the animation system's cost, for work that is nearly all skipping unstepped instances. That is why §E2 folds it in and the gate counts it.
*   **Frame share at 2000 idle (GPU route):** animation 0.73 plus after 0.17 is 0.90 of 2.76 ms, a third of the frame; at 2000 switching, 2.23 of 4.40 ms, half.

**Targets (the gate, §5, with the after-animation figure added):** animation 0.73 to 0.40 ms or less idle and 1.84 to 1.0 or less switching; after-animation 0.17 to 0.09 or less idle and 0.39 to 0.20 or less switching; together at least 0.5 ms off the idle frame and 1.0 ms off the switching frame at 2000, in an ABBA run against build 57.
