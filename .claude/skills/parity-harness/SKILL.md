---
name: parity-harness
description: Prove BoneBurst still matches stock spine-csharp bit for bit on strict float32, outside Unity, before landing any change to BoneBurst's runtime (Packages/com.module.ta-creator-boneburst/Runtime), its parity tests (Tests/Editor Parity, Pose, Anim, Constraints, Skins), or the spine-csharp fork. Runs Tools~/ParityHarness with Unity's bundled .NET SDK, about 20 s, no Editor needed. Use whenever that code changed, when a Unity parity test fails and you need to know whether it is a real difference or Mono rounding, or when asked whether BoneBurst matches stock.
---

# Parity harness gate

The Unity Editor cannot prove bit-for-bit parity: Mono's JIT rounds `float` arithmetic differently depending on how it
compiles a method (142 failures in Release, 99 in Debug, from the same code). The Editor suites therefore compare
within a tolerance, with lockstep. **Exact parity is proven here**, on .NET, where every float operation is rounded to
float32. See `Packages/com.module.ta-creator-boneburst/Doc/Review/BoneBurst-ParityPlan.md`.

```bash
python3 .claude/skills/parity-harness/paritygate.py
```

```mermaid
flowchart LR
    G["paritygate.py"] --> R1["run.sh<br/>every parity test class"]
    G --> R2["run.sh ParityDriftReport<br/>~134 M values"]
    R1 --> C1{"float check = 0 ·<br/>TOTAL n of n · n > 0"}
    R2 --> C2{"0 not bit-exact ·<br/>values > 0"}
    C1 --> P["PASS / FAIL"]
    C2 --> P
    R1 -->|"exit 2: no Unity / project never opened"| U["UNCHECKED"]
    R1 -->|"exit 3: harness does not build"| F["FAIL"]
```

## When to run it

- Any change under `Packages/com.module.ta-creator-boneburst/Runtime/`, before landing it.
- Any change to the parity tests (`Tests/Editor/Parity`, `Pose`, `Anim`, `Constraints`, `Skins`). The harness
  compiles those files, and their `#if !BONEBURST_PARITY_HARNESS` guards are easy to break.
- Any change to `Packages/com.esotericsoftware.spine.spine-csharp`: it is the parity reference.
- A Unity parity test fails and the cause is unclear: if the gate passes, the Unity failure is Mono rounding (see the
  parity plan's tolerance, lockstep and conditioning rules); if the gate fails, it is a real difference.

## What it proves, and what it does not

- **Proves:** setup pose, animation, mixing, constraints and physics, skins, and the readers agree bit for bit with
  stock, value for value (`ParityDriftReport` records every compared value).
- **Does not cover:** meshes against spine-unity's `MeshGenerator` and the GPU path. They need `UnityEngine.Mesh`,
  which the harness does not have. Run the Editor suite for those:
  `python3 .claude/skills/unity-playtest/playtest.py test --assembly Module.TA.BoneBurst.Tests.Editor --mode EditMode --timeout 2400`.

## Results

- **PASS**: every test passed, at least one ran, the drift report compared values and every one was bit-exact.
- **FAIL**: lists the failing tests (first 10) or the count of inexact values. A harness that does not build is a
  FAIL, never a stale pass: `run.sh` stops on a build error.
- **UNCHECKED**: the harness could not run. It needs Unity 6000.6.3f1 installed under `/Applications/Unity/Hub/Editor`
  (for its .NET SDK and managed engine modules), and the project opened once (`Library/ScriptAssemblies` provides
  `Unity.Collections` and `Unity.Burst`).

## Checked (2026-09-30)

- On the current code: PASS, 191 of 191 tests, 133,729,676 values, 0 not bit-exact.
- With a deliberate runtime bug (a sign flip in `PoseMath.Child`, OnlyTranslation): FAIL, naming the failing tests.
  Reverted.
