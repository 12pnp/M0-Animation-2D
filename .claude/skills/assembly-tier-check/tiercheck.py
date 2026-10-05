#!/usr/bin/env python3
"""
Assembly tier gate for M0-Animation-2D (CLAUDE.md section 4).

Assemblies are named  Module.<Tier><Band>.<Name>
    Tier  P = data + primary functions, T = logic + tools + packages, U = managers + toppings
    Band  A..Z inside a tier, lower letter = lower layer
An assembly may reference only same-or-lower codes: P < T < U, and inside a tier A < B < ...

Three checks over every .asmdef in Assets/ and Packages/:
  A. CYCLES            - must always be 0. No baseline, no exceptions.
  B. UPWARD EDGES      - a code referencing a higher code.
                         Pre-existing ones are baselined; NEW ones fail.
  C. EDITOR-ONLY REFS  - an all-platforms assembly referencing an
                         includePlatforms:["Editor"] assembly. Hygiene, not a
                         build break - see NOTE below. Pre-existing ones are
                         baselined; NEW ones fail.

  D. LEGACY NAMES      - a project assembly named in the pre-2026-09-24 style
                         (ModuleP1.*, ModuleT1*, UnityP1.*, Unity1.*, TArchitect.*, ...).
                         The rename is complete, so any such name fails: it would sit
                         outside checks A-C with no tier. tier-map.json keeps the full
                         legacy -> Module.XY.* map for the projects that pull Packages-Core.

Four checks over where assemblies live (com.module.* packages carry a code in their
displayName, "<code> <group> <name>"). Each is baselined like B and C: NEW ones fail.
  E. PACKAGE PLACEMENT - an assembly whose tier letter is above its package's (a T
                         assembly in a P package). A higher band in the same tier (PC in
                         a PB package, UB in a UA package) is legal and listed by --all.
  F. PACKAGE EDGES     - an asmdef edge from one com.module package into another whose
                         tier letter is higher; reported per package pair.
  G. FISHNET BELOW U   - a Module.P* or Module.T* assembly referencing FishNet.*.
  H. UI HOMES          - UI lives in Module.PC.UI (+ .Editor/.Tests), a <Feature>.VScript
                         or Module.UB.CoOp.UI. Any other Module.XY.* assembly with a UI or
                         HUD name segment (UI, *UI, *Hud*) is a stray.

NOTE on check C. This is NOT a player-build break, despite how it reads.
Unity resolves asmdef references per platform and silently drops Editor-only
ones from the player compile, so usage sitting behind #if UNITY_EDITOR still
builds clean. Verified 2026-09-10 against Unity's own player invocation,
Library/Bee/artifacts/200b0aP.dag/ModuleT1.Timeline.rsp (hash varies per
project/platform): the Editor-only refs were absent, UNITY_EDITOR was not
defined, and the DLL was produced. So a hit here means the reference is either
vestigial or the code belongs in a sibling *.Editor assembly - worth cleaning
up, not worth an emergency. Same shape as the "using UnityEditor; breaks player
builds" claim, which was also measured and found false.

Blind spot in check C: only Assets/ and Packages/ are scanned, so an
Editor-only assembly resolved into Library/PackageCache is invisible.

Usage:
    python3 tiercheck.py                      # gate: exit 1 on any new violation
    python3 tiercheck.py --all                # also list baselined (known) debt
    python3 tiercheck.py --update-baseline    # accept current state as the new floor
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

SKIP_DIRS = {".git", "node_modules"}  # walks start inside Assets/ + Packages/: never skip by a name like Library
TIER_RE = re.compile(r"^Module\.([PTU])([A-Z])\.")
LEGACY_RE = re.compile(r"^(Module[PTU]\d|Unity\.ModuleP1|UnityP1\.|Unity1\.|TArchitect\.|CoOpValueTest)")
GUID_RE = re.compile(r"^guid:\s*([0-9a-f]{32})", re.M)
PKG_CODE_RE = re.compile(r"^[PTU][A-Z]$")
FISHNET_RE = re.compile(r"^FishNet\.")
BELOW_U_RE = re.compile(r"^Module\.[PT][A-Z]\.")
# The homes of UI code (CLAUDE.md section 4 + Packages/com.module.pc-creator-ui/Doc/Review/UI-Input-Cleanup-Plan.md).
# Module.PD.UI.Stage is the strong stage above Navigation (UI-Stage-Plan.md, owner decision D1).
# A <Feature>.VScript has no UI segment in its name, so it never needs listing here.
UI_HOMES = {"Module.PC.UI", "Module.PC.UI.Editor", "Module.PC.UI.Tests",
            "Module.PD.UI.Stage", "Module.PD.UI.Stage.Editor", "Module.PD.UI.Stage.Tests",
            "Module.PD.UI.Stage.Editor.Tests",
            "Module.UB.CoOp.UI", "Module.UB.CoOp.UI.Editor", "Module.UB.CoOp.UI.Tests"}
DEFAULT_BASELINE = Path(__file__).with_name("baseline.json")


def find_asmdefs(roots):
    """Every .asmdef under roots. Skips build output and any git worktree
    (a worktree is a second full checkout and would double-count everything)."""
    found = []
    for root in roots:
        if not Path(root).is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [
                d for d in dirnames
                if d not in SKIP_DIRS and "worktrees" not in os.path.join(dirpath, d)
            ]
            found.extend(Path(dirpath) / f for f in filenames if f.endswith(".asmdef"))
    return sorted(found)


def classify(name, path, data):
    """editor | test | runtime. Only 'runtime' actually ships in a player build."""
    if data.get("includePlatforms", []) == ["Editor"]:
        return "editor"
    parts = {p.lower() for p in path.parts}
    if "test" in parts or "tests" in parts or name.lower().endswith((".test", ".tests")):
        return "test"
    if any("testrunner" in str(r).lower() or "nunit" in str(r).lower()
           for r in data.get("references", []) or []):
        return "test"
    return "runtime"


def load(paths):
    by_name, by_guid, unparseable = {}, {}, []
    for p in paths:
        try:
            data = json.loads(p.read_text(encoding="utf-8-sig"))
        except Exception as exc:
            unparseable.append((p, str(exc)))
            continue
        name = data.get("name")
        if not name:
            unparseable.append((p, "no 'name' field"))
            continue
        by_name[name] = {
            "path": p,
            "refs": data.get("references", []) or [],
            "kind": classify(name, p, data),
        }
        meta = Path(f"{p}.meta")
        if meta.exists():
            m = GUID_RE.search(meta.read_text(errors="ignore"))
            if m:
                by_guid[m.group(1)] = name
    return by_name, by_guid, unparseable


def resolve(refs, by_guid):
    """A reference is either a plain assembly name or 'GUID:<32 hex>'.
    A GUID with no local .asmdef.meta is a package outside the scan roots - skip it."""
    out = []
    for r in refs:
        if not isinstance(r, str) or not r:
            continue
        if r.startswith("GUID:"):
            name = by_guid.get(r[5:])
            if name:
                out.append(name)
        else:
            out.append(r)
    return out


def find_cycles(graph):
    """Iterative Tarjan. An SCC of >1 node, or a self-loop, is a cycle."""
    index, low, on_stack, stack, cycles, counter = {}, {}, set(), [], [], [0]

    def strongconnect(root):
        work = [(root, 0)]
        while work:
            node, child_i = work[-1]
            if child_i == 0:
                index[node] = low[node] = counter[0]
                counter[0] += 1
                stack.append(node)
                on_stack.add(node)
            recursed = False
            succs = graph.get(node, [])
            for i in range(child_i, len(succs)):
                nxt = succs[i]
                if nxt not in graph:
                    continue
                if nxt not in index:
                    work[-1] = (node, i + 1)
                    work.append((nxt, 0))
                    recursed = True
                    break
                if nxt in on_stack:
                    low[node] = min(low[node], index[nxt])
            if recursed:
                continue
            if low[node] == index[node]:
                comp = []
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    comp.append(w)
                    if w == node:
                        break
                if len(comp) > 1 or node in graph.get(node, []):
                    cycles.append(sorted(comp))
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[node])

    for v in graph:
        if v not in index:
            strongconnect(v)
    return cycles


def tier_of(name):
    m = TIER_RE.match(name)
    return ("PTU".index(m.group(1)), m.group(2)) if m else None


def package_of(path, _cache={}):
    """(package name, code) of the com.module package holding an asmdef, e.g.
    ("com.module.pc-creator-ui", "PC"); None under Assets/, in a vendor package, or when the package
    names no code. The code is the displayName's first word ("PC Creator UI"), else the name's letters."""
    for parent in Path(path).parents:
        if parent in _cache:
            return _cache[parent]
        pj = parent / "package.json"
        if pj.exists():
            found = None
            try:
                data = json.loads(pj.read_text(encoding="utf-8-sig"))
            except Exception:
                data = {}
            name = data.get("name") or parent.name
            if name.startswith("com.module."):
                word = (data.get("displayName") or "").split(" ")[0]
                m = re.match(r"^com\.module\.([a-z]{2})-", name)
                code = word if PKG_CODE_RE.match(word) else (m.group(1).upper() if m else None)
                found = (name, code) if code and PKG_CODE_RE.match(code) else None
            _cache[parent] = found
            return found
        if parent.name in ("Packages", "Assets"):
            return None
    return None


def ui_named(name):
    """A Module.XY.* assembly whose name has a UI or HUD segment: UI, *UI (CoreUI, UnityUI), *Hud*."""
    if not TIER_RE.match(name):
        return False
    return any(s == "UI" or s.endswith("UI") or "Hud" in s or "HUD" in s for s in name.split(".")[2:])


def analyze(roots):
    """Every check over the .asmdef files under roots, as data. main() gates and prints it."""
    by_name, by_guid, unparseable = load(find_asmdefs(roots))
    graph = {n: resolve(v["refs"], by_guid) for n, v in by_name.items()}

    cycles = find_cycles(graph)

    upward, editor_refs = [], []
    for src, refs in graph.items():
        src_tier, src_kind = tier_of(src), by_name[src]["kind"]
        for dst in refs:
            if dst not in by_name:
                continue
            dst_tier = tier_of(dst)
            if src_tier is not None and dst_tier is not None and dst_tier > src_tier:
                upward.append({"src": src, "dst": dst, "kind": src_kind})
            if src_kind != "editor" and by_name[dst]["kind"] == "editor":
                editor_refs.append({"src": src, "dst": dst, "kind": src_kind})
    upward.sort(key=lambda e: (e["src"], e["dst"]))
    editor_refs.sort(key=lambda e: (e["src"], e["dst"]))

    # E. an assembly above its package's tier letter; a higher band inside the tier is only listed
    pkg = {n: package_of(v["path"]) for n, v in by_name.items()}
    placement, band_placement = [], []
    for n in sorted(by_name):
        m, p = TIER_RE.match(n), pkg[n]
        if not m or not p:
            continue
        entry = {"asm": n, "package": p[0], "asm_code": m.group(1) + m.group(2), "pkg_code": p[1],
                 "kind": by_name[n]["kind"]}
        if "PTU".index(m.group(1)) > "PTU".index(p[1][0]):
            placement.append(entry)
        elif m.group(1) == p[1][0] and m.group(2) > p[1][1]:
            band_placement.append(entry)

    # F. package pairs whose edge points at a higher tier letter
    package_edges = {}
    for src, refs in graph.items():
        sp = pkg.get(src)
        if not sp:
            continue
        for dst in refs:
            dp = pkg.get(dst)
            if dp and dp[0] != sp[0] and "PTU".index(dp[1][0]) > "PTU".index(sp[1][0]):
                package_edges.setdefault((sp[0], dp[0]), []).append((src, dst))
    package_edges = {k: sorted(v) for k, v in sorted(package_edges.items())}

    # G. network code stays in U
    fishnet = sorted(({"src": s, "dst": d, "kind": by_name[s]["kind"]}
                      for s, refs in graph.items() if BELOW_U_RE.match(s) for d in refs if FISHNET_RE.match(d)),
                     key=lambda e: (e["src"], e["dst"]))

    # H. UI outside its three homes
    ui_strays = sorted(n for n in by_name if ui_named(n) and n not in UI_HOMES)

    return {
        "by_name": by_name, "graph": graph, "unparseable": unparseable, "cycles": cycles,
        "upward": upward, "editor_refs": editor_refs,
        "tiered": sum(1 for n in by_name if TIER_RE.match(n)),
        "legacy": sorted(n for n in by_name if LEGACY_RE.match(n)),
        "placement": placement, "band_placement": band_placement, "package_edges": package_edges,
        "fishnet": fishnet, "ui_strays": ui_strays,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="Assembly tier gate (CLAUDE.md section 4)")
    ap.add_argument("--roots", nargs="*", default=["Assets", "Packages"])
    ap.add_argument("--baseline", default=str(DEFAULT_BASELINE))
    ap.add_argument("--all", action="store_true", help="also list baselined known debt")
    ap.add_argument("--update-baseline", action="store_true")
    args = ap.parse_args(argv)

    r = analyze(args.roots)
    by_name, cycles, upward, editor_refs = r["by_name"], r["cycles"], r["upward"], r["editor_refs"]
    legacy, unparseable = r["legacy"], r["unparseable"]
    placement, band_placement = r["placement"], r["band_placement"]
    package_edges, fishnet, ui_strays = r["package_edges"], r["fishnet"], r["ui_strays"]

    if args.update_baseline:
        Path(args.baseline).write_text(json.dumps({
            "note": "Pre-existing violations accepted as the floor. "
                    "New ones fail the gate. Regenerate only when you have deliberately paid one down.",
            "asmdef_count": len(by_name),
            "upward": [[e["src"], e["dst"]] for e in upward],
            "editor_refs": [[e["src"], e["dst"]] for e in editor_refs],
            "tier_placement": [[e["asm"], e["package"]] for e in placement],
            "package_edges": [list(k) for k in package_edges],
            "fishnet_below_u": [[e["src"], e["dst"]] for e in fishnet],
            "ui_homes": ui_strays,
        }, indent=2) + "\n")
        print(f"baseline written: {len(upward)} upward, {len(editor_refs)} editor-ref, "
              f"{len(placement)} package placement, {len(package_edges)} package edge, "
              f"{len(fishnet)} FishNet below U, {len(ui_strays)} outside the UI homes, {len(by_name)} asmdefs")
        return 0

    base = {"upward": [], "editor_refs": [], "tier_placement": [], "package_edges": [], "fishnet_below_u": [],
            "ui_homes": [], "asmdef_count": None}
    if Path(args.baseline).exists():
        base.update(json.loads(Path(args.baseline).read_text()))
    known_up = {tuple(e) for e in base["upward"]}
    known_ed = {tuple(e) for e in base["editor_refs"]}
    known_pl = {tuple(e) for e in base["tier_placement"]}
    known_pe = {tuple(e) for e in base["package_edges"]}
    known_fn = {tuple(e) for e in base["fishnet_below_u"]}
    known_ui = set(base["ui_homes"])

    new_up = [e for e in upward if (e["src"], e["dst"]) not in known_up]
    new_ed = [e for e in editor_refs if (e["src"], e["dst"]) not in known_ed]
    new_pl = [e for e in placement if (e["asm"], e["package"]) not in known_pl]
    new_pe = [k for k in package_edges if k not in known_pe]
    new_fn = [e for e in fishnet if (e["src"], e["dst"]) not in known_fn]
    new_ui = [n for n in ui_strays if n not in known_ui]

    print(f"asmdefs scanned   : {len(by_name)}"
          + (f"  (baseline {base['asmdef_count']})" if base["asmdef_count"] else ""))
    print(f"tier names        : {r['tiered']} Module.XY.*, {len(legacy)} legacy-style")
    print(f"cycles            : {len(cycles)}")
    print(f"upward edges      : {len(upward)}  ({len(new_up)} new)")
    print(f"editor-only refs  : {len(editor_refs)}  ({len(new_ed)} new)")
    print(f"package placement : {len(placement)} above their package's tier  ({len(new_pl)} new); "
          f"{len(band_placement)} in a lower band of their tier (--all lists them)")
    print(f"package edges     : {len(package_edges)} upward package pairs  ({len(new_pe)} new)")
    print(f"FishNet below U   : {len(fishnet)}  ({len(new_fn)} new)")
    print(f"UI homes          : {len(ui_strays)} UI assemblies outside Module.PC.UI / <Feature>.VScript / "
          f"Module.UB.CoOp.UI  ({len(new_ui)} new)")
    for n in legacy:
        print(f"    ! legacy name {n}  ({by_name[n]['path']}) - name it Module.<Tier><Band>.<Name>")
    if unparseable:
        print(f"unparseable       : {len(unparseable)}")
        for p, err in unparseable:
            print(f"    ! {p}: {err}")

    def dump(title, entries, mark_new=None):
        if not entries:
            return
        print(f"\n{title}")
        for e in entries:
            star = "*" if mark_new and (e["src"], e["dst"]) in mark_new else " "
            print(f"  {star} [{e['kind']:7}] {e['src']} -> {e['dst']}")

    def dump_placement(title, entries, mark_new=None):
        if not entries:
            return
        print(f"\n{title}")
        for e in entries:
            star = "*" if mark_new and (e["asm"], e["package"]) in mark_new else " "
            print(f"  {star} [{e['kind']:7}] {e['asm']} ({e['asm_code']}) in {e['package']} ({e['pkg_code']})")

    def dump_pairs(title, pairs, mark_new=None):
        if not pairs:
            return
        print(f"\n{title}")
        for k in pairs:
            star = "*" if mark_new and k in mark_new else " "
            edges = package_edges[k]
            print(f"  {star} {k[0]} -> {k[1]}  ({len(edges)} edge(s))")
            for s, d in edges:
                print(f"        {s} -> {d}")

    def dump_names(title, names, mark_new=None):
        if not names:
            return
        print(f"\n{title}")
        for n in names:
            star = "*" if mark_new and n in mark_new else " "
            print(f"  {star} [{by_name[n]['kind']:7}] {n}  ({by_name[n]['path']})")

    if cycles:
        print("\nCYCLES - must be 0, no exceptions:")
        print("  (each group is mutually reachable; the members, not a single path)")
        for c in cycles:
            print(f"    [{len(c)} assemblies] " + ", ".join(c))

    if args.all:
        dump("ALL UPWARD EDGES  [* = new]", upward, {(e["src"], e["dst"]) for e in new_up})
        dump("ALL EDITOR-ONLY REFS FROM ALL-PLATFORMS  [* = new]", editor_refs, {(e["src"], e["dst"]) for e in new_ed})
        dump_placement("ALL PACKAGE PLACEMENTS ABOVE THE PACKAGE'S TIER  [* = new]", placement,
                       {(e["asm"], e["package"]) for e in new_pl})
        dump_placement("IN-TIER BAND PLACEMENTS (legal, listed only)", band_placement)
        dump_pairs("ALL UPWARD PACKAGE EDGES  [* = new]", list(package_edges), set(new_pe))
        dump("ALL FISHNET REFERENCES BELOW U  [* = new]", fishnet, {(e["src"], e["dst"]) for e in new_fn})
        dump_names("ALL UI ASSEMBLIES OUTSIDE THE UI HOMES  [* = new]", ui_strays, set(new_ui))
    else:
        dump("NEW UPWARD EDGES", new_up)
        dump("NEW EDITOR-ONLY REFS FROM AN ALL-PLATFORMS ASSEMBLY", new_ed)
        dump_placement("NEW PACKAGE PLACEMENT ABOVE THE PACKAGE'S TIER", new_pl)
        dump_pairs("NEW UPWARD PACKAGE EDGE", new_pe)
        dump("NEW FISHNET REFERENCE BELOW U", new_fn)
        dump_names("NEW UI ASSEMBLY OUTSIDE THE UI HOMES (put UI in Module.PC.UI, a <Feature>.VScript or "
                   "Module.UB.CoOp.UI)", new_ui)

    failures = []
    if cycles:
        failures.append(f"{len(cycles)} cycle(s)")
    if new_up:
        runtime_new = [e for e in new_up if e["kind"] == "runtime"]
        failures.append(f"{len(new_up)} new upward edge(s)"
                        + (f", {len(runtime_new)} from a RUNTIME assembly" if runtime_new else ""))
    if new_ed:
        failures.append(f"{len(new_ed)} new editor-only ref(s)")
    if legacy:
        failures.append(f"{len(legacy)} legacy-style assembly name(s)")
    if new_pl:
        failures.append(f"{len(new_pl)} new package placement(s)")
    if new_pe:
        failures.append(f"{len(new_pe)} new upward package edge(s)")
    if new_fn:
        failures.append(f"{len(new_fn)} new FishNet reference(s) below U")
    if new_ui:
        failures.append(f"{len(new_ui)} new UI assembly(ies) outside the UI homes")

    print()
    if failures:
        print("FAIL: " + "; ".join(failures))
        print("Rename a legacy-named assembly (the baseline cannot excuse one). Fix an edge, or - only if it is "
              "deliberate and justified - re-run with --update-baseline and say why in the commit message.")
        return 1
    print("PASS: 0 cycles, no new upward edges, no new editor-only refs, no legacy names, no new package "
          "placement, package edge, FishNet reference below U or UI assembly outside the UI homes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
