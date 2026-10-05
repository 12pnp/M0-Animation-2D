# Dragging the path of a bone the IK solves

Done (ARCHITECTURE ▸ Bone paths). Changed from the plan: path handles stay hidden on a
chain bone (no bake through the target), and `set_bone_path` still refuses a chain bone,
naming the target, since its x, y are the bone's own.

## The problem

Dragging the path of any bone in an IK chain is refused today. `pathDragMode` in
`core/doc/pathEdit.ts` returns "… is moved by IK. Drag the path of … instead." for the
chain root (thigh) and the effector (shin). Their dots draw, since the path is the
runtime's (`bonePaths` over `posedSymbol`). But a press on one only shows a notice.

The refusal exists because a chain bone must never be keyed (ARCHITECTURE ▸ Bones and
IK): the solve runs at display time and overrides the bone's rotation. A key there
does nothing in the game and only confuses the timeline. So the drag cannot write the
bone. It has to write the **target**, the one thing that moves the chain.

There are two cases, with different answers:

| Dragged dot | What the user means | What we key |
|---|---|---|
| effector's tip (the shin's end, the foot) | "put the foot here" | the target, so the solved tip lands under the pointer |
| chain root's tip (the knee) | "put the knee here" | the target, so the knee moves there and the shin keeps its world angle |
| effector's origin (the knee, seen from the shin's path) | same as the knee | same as the knee |
| a one-bone (look-at) chain's tip | "point it here" | the target, on the ray from the bone's origin through the pointer, at the target's current distance |

Bones below the effector (a foot hanging on the shin) are not in the chain. They
already drag normally, and nothing changes for them.

## The rule, pure

A new mode in `pathDragMode`:

```ts
type PathDragMode = "translate" | "rotate" | "rotateWithParent" | "throughTarget";
type PathDragRule =
  | { mode: Exclude<PathDragMode, "throughTarget"> }
  | { mode: "throughTarget"; ik: IkId; role: "effector" | "root" }
  | { refused: string };
```

`pathDragMode` returns `throughTarget` for a chain bone instead of refusing it. It still
refuses when:

- the target is locked or on a hidden layer;
- the target is parented inside its own chain (the solve is skipped there, see Bones
  and IK);
- the constraint's weight is 0 (the bone follows its own keys, so the plain rules apply).

In a new module, `core/doc/ikPathEdit.ts`:

- `targetForTip(sym, pose, ik, pointer) → Point` (world). This is for the effector's tip.
  1. Start from `T₀ = target + (pointer − tip)`, using the frame's posed tip.
  2. Re-solve the chain with `ikApply2`/`ikApply1` on that frame's parent worlds (no
     whole re-pose; only the chain moves).
  3. Repeat `T ← T + (pointer − tip(T))`, at most 8 steps, until the tip is within 1e-3 px.
  - When the pointer is out of reach, the chain straightens toward it. The target is
    then put at the pointer itself, so the chain points there "as far as it reaches",
    as `rotateWithParentTo` already does.
  - A partial weight (`mix < 1`) converges more slowly. The iteration still works since
    it uses the real solve; it stops after 8 steps either way.
- `targetForJoint(sym, pose, ik, pointer) → Point` (world). This is for the knee.
  1. Project the pointer onto the circle about the root's origin with the thigh's length.
     That is where the knee can go.
  2. Keep the shin's world angle at that frame, so the tip = knee + shin length along it.
  3. Feed that tip to `targetForTip`, which gives the target exactly. The chain then
     bends the same way, since the knee sits on the bend side it already had.
  - If the projected knee crosses the line root→target, the solver would bend the other
    way. That can't be keyed (`bendPositive` is not animated), so the knee stays on its
    side and is clamped to the straight-chain point.
- `targetLocal(sym, pose, targetId, world) → Transform`: the target's local x, y in its
  parent's space at that frame, through `translateTo`. The target can hang from the moving
  hips, which `add_ik` does.

Everything here works on one frame's `posedSymbol` and `core/math/ik.ts`. It needs no
store and no DOM.

## Steps

1. **Rule and maths.** `throughTarget` in `pathDragMode`, `ikPathEdit.ts`, and table
   tests (`tests/ikPathEdit.test.ts`) on the stickman run:
   - Every frame, drag the shin tip to a reachable point. Re-pose with `posedSymbol` and
     check the tip is within 1e-3 px of the point.
   - Drag to an unreachable point: the chain points straight at it.
   - Drag the knee: the knee sits on the circle, the shin keeps its world angle, and the
     bend side is unchanged.
   - A look-at chain.
   - Weight 0.5.
   - A target hung under the hips.
   - The current "refused" test turns into these. It must fail on the old code (old
     `pathDragMode` refuses).
2. **The drag.** `PathDrag` (`view/tools/pathDrag.ts`):
   - Change which node is keyed. `moving` gets the target, not the pressed bone.
   - Each move computes the target from the pointer and keys it at the frame by
     `keyAt`'s rule. `withoutRedundantKeys` runs on release, and a cycle's frame 0 moves
     the join key, as for any target drag.
   - ⇧ (every key) shifts every target key by the same world delta (`shiftKeys` on the
     target, `translate` mode).
   - ⌥ (with parent) has no meaning here and is ignored.
   - The label is "Drag Path (IK)", one undo step.
   - Relative paths: `back` already maps the drawn point into the frame's space. The
     pointer goes to world from there, and the target's parent is applied after.
3. **Handles.** A chain bone's path handles (`handleAt`) bend the path of the tip.
   - A bone that turns uses `bakePlan`. For a chain bone the bake keys the **target** at
     each frame instead: `targetForTip` per baked frame, then `bakePlan`'s 0.5 px
     thinning on the target's x, y.
   - Until this step lands, the handles of a chain bone are hidden rather than refused.
4. **Stage and panels.**
   - The Local/World Path panels use the same `PathDrag`, so they follow with no change.
     Check the Local panel's "anywhere else drags the bone" press too.
   - Real mouse drags on `stickman.boneburst`: stage dot, Local panel, World panel, at a
     cycle's frame 0, with ⇧.
   - Check that `spinePose`/`spineParity` stay green. Nothing changes in the export,
     since only the target's keys change.
5. **AI.** `set_bone_path` on a chain bone keys the target the same way instead of
   refusing (`addedKeys` lists the target's keys). Update its description in `tools.json`.
6. **Docs.** ARCHITECTURE ▸ Bone paths:
   - the `pathDragMode` table loses the "refused" row and gains "a bone the IK solves →
     its target, keyed so the dot lands under the pointer";
   - Bones and IK states that a path drag on a chain bone keys the target.

## Out of scope: keyed IK (a later plan)

Spine can animate a constraint's `mix` and `bendPositive` (the `ik` timeline). That
would allow:

- moving the knee to the *other* side (a key flips the bend for a span);
- dragging a chain bone as plain FK where the mix is keyed to 0 (the rotation keys then
  play).

That needs:

- `Animation.ik?` keys (schema 17);
- an IK row on the timeline;
- exporter and importer `ik` timelines;
- `applyIk` reading the mix and bend at the frame;
- a parity case.

It is a feature of its own, on the model of Draw order keys (DRAW-ORDER-PLAN.md).
Done since: IK keys (ARCHITECTURE ▸ IK keys), and a knee pulled across the line keys the
bend flipped at that frame.
