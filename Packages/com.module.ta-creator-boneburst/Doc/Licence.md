# BoneBurst licence position

**Owner decision, 2026-10-05: BoneBurst is an original work, not a derivative work of the Spine Runtimes** (case B in the legal note). This page supersedes the case-A position previously recorded here on 2026-10-01. Source: `/Users/pnp/Project Unity/_Discuss/Spine-Custom-Runtime-Legal.md` (not legal advice).

## 1. The position

- **No Spine Runtimes code is integrated or copied.** No dependency, no assembly reference, no `using Spine` anywhere in Runtime or Editor code; the data model, jobs and components are new.
- **Readers touch only the documented export formats** (JSON, `.skel`, `.atlas`), version-gated to Spine 4.3 (`SkeletonJsonReader`, `SkeletonBinaryReader`, `AtlasReader` in `com.module.ta-creator-boneburst-import`). The undocumented `.spine` project file is never read.
- **Behaviour parity with stock spine-csharp is a test goal, not copying.** Functionality and behaviour are not copyrightable expression; the parity suites compare outputs, they do not carry code.
- `LICENSE` holds the owner's notice only. No third-party licence text is bundled because none applies to this package's own code. The notice grants nothing beyond the owner's own terms (all rights reserved by default); a distribution licence can be chosen later if the package is ever published.

## 2. What the previous case-A declaration rested on (recorded, not hidden)

The earlier position called BoneBurst a derivative work because: (a) the `Doc/Format` specs were written while reading the vendored spine-csharp 4.3.40 / spine-unity 4.3.109 sources; (b) parity is bit-exact, which means following the stock operation order; (c) development was AI-assisted. The owner has weighed these and decided they do not make BoneBurst a derivative work: reading source is not copying, the operation order follows from matching the documented output, and no protected expression was copied. This is a defensible but untested position — see the checklist in §4.

## 3. What still applies regardless of this position

- **Anyone who uses the Spine Editor needs their own Spine Editor licence**, at the right tier. Hired artists animate in the Spine Editor; that requirement comes from the Spine Editor Licence, not from the runtimes licence, and does not change with this repositioning. Who owns the delivered art is a matter for the artists' contracts.
- **The vendored `com.esotericsoftware.spine.*` packages in this repository are still Esoteric's software under their own licence.** Per [D1](Review/D1-SpineRuntime-Decision.md) they stay until M2 phase P9: any product that still *integrates* them (M2's current `Module.TC.CCP.Spine2D` content, and the parity test assemblies that run them as oracle) needs a valid Spine Editor licence for its developers at integration time. This repositioning covers BoneBurst's own code only.
- **Naming.** A runtime *for* Spine, not an official Spine Runtime; respect Esoteric's trademark (the `LICENSE` notice says so).
- The readers stay export-only and 4.3-gated; runtime version must match the editor's export version.

## 4. Owner checklist

- [x] Case decided and documented: original work / case B (this page, 2026-10-05)
- [x] `LICENSE` carries the owner's notice only; no third-party licence text to bundle
- [x] Readers read documented export formats only; version-gated 4.3
- [x] Named as a runtime for Spine; trademark respected
- [ ] Artists who use the Spine Editor hold their own licences (put it in the contract)
- [ ] Recommended before any commercial ship: written confirmation from Esoteric that an independent runtime reading documented exports carries no Spine Runtimes licence obligations (keep on file)

## 5. Related

- Legal note: `_Discuss/Spine-Custom-Runtime-Legal.md` (case B definition and its risks; sections on reading the official source and AI generators).
- [BoneBurst-Plan.md](Review/BoneBurst-Plan.md) §10 (risks), [BoneBurst-ImprovePlan.md](Review/BoneBurst-ImprovePlan.md) I7, [D1](Review/D1-SpineRuntime-Decision.md).
- Sibling packages follow this position: `com.module.ta-creator-boneburst-import`, `com.module.ta-creator-boneburst-timeline` (own `Doc/Licence.md` where present).
