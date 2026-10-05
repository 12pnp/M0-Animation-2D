#!/usr/bin/env python3
"""
Managed-reference gate for M0-Animation-2D.

A [SerializeReference] field can die in two ways that Unity never reports:

  A. MISSING DATA   - a RefIds entry names a type but has no `data:` line. Unity
                      discards the entry on load; the field becomes null and the
                      C# initializer is overwritten. Exact, offline, no Unity.
  B. UNRESOLVED TYPE - the {class, ns, asm} triple names no loaded type (deleted,
                      renamed, or moved to another assembly). Needs the live type
                      list, fetched from the running Editor at check time (--types).

Both are baselined: pre-existing ones are accepted as the floor, NEW ones fail.
Only git-tracked assets are scanned, in both repositories (root + Packages/),
so gitignored samples never count.

`data: ` with nothing under it is what Unity itself writes for a type with no
serialized fields - that is healthy. A MISSING `data:` line is the defect.

Usage:
    python3 refcheck.py                     # check A; exit 1 on a new violation
    python3 refcheck.py --types             # checks A + B (Editor must be running)
    python3 refcheck.py --all               # also list baselined (known) debt
    python3 refcheck.py --types --update-baseline   # accept current state as the floor

Exit codes: 0 pass, 1 new violations, 2 --types requested but the Editor was unreachable.
"""
import argparse
import json
import re
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SKILL = Path(__file__).resolve().parent
DEFAULT_BASELINE = SKILL / "baseline.json"
DUMP_CS = SKILL / "dump_types.cs"
DUMP_OUT = ROOT / "Temp" / "refcheck_types.txt"
EXTS = (".prefab", ".asset", ".unity")

RID_RE = re.compile(r"^\s*- rid: (-?\d+)\s*$")
TYPE_RE = re.compile(r"^\s*type: \{class: ([^,]*), ns: ([^,]*), asm: ([^}]*)\}\s*$")


def tracked_assets():
    """Git-tracked asset files in the root repo and the Packages/ repo, as project-relative paths."""
    files = []
    for repo, prefix in ((ROOT, ""), (ROOT / "Packages", "Packages/")):
        if not (repo / ".git").exists():
            continue
        out = subprocess.run(["git", "-C", str(repo), "ls-files", "-z"], capture_output=True).stdout
        for rel in out.decode("utf-8", "replace").split("\0"):
            if rel.endswith(EXTS):
                files.append(prefix + rel)
    if not files:
        sys.exit("refcheck: no tracked assets found - is this the M0-Animation-2D project root?")
    return sorted(set(files))


def scan(paths):
    """Returns (missing_data list of [path, rid, class], triple -> use count)."""
    missing = []
    triples = Counter()
    for rel in paths:
        try:
            lines = (ROOT / rel).read_text(encoding="utf-8", errors="replace").split("\n")
        except OSError:
            continue
        for i, line in enumerate(lines):
            m = RID_RE.match(line)
            if not m or i + 1 >= len(lines):
                continue
            t = TYPE_RE.match(lines[i + 1])
            if not t:
                continue
            cls, ns, asm = (g.strip() for g in t.groups())
            if not cls:
                continue  # `- rid: -2` with an empty class is Unity's null sentinel
            triples[(cls, ns, asm)] += 1
            nxt = lines[i + 2].strip() if i + 2 < len(lines) else ""
            if not nxt.startswith("data:"):
                missing.append([rel, m.group(1), cls])
    return missing, triples


def live_types():
    """Ask the running Editor for every loaded type. Returns (exact set, simple-name index) or None."""
    DUMP_OUT.unlink(missing_ok=True)
    try:
        r = subprocess.run(["unity", "command", "eval_file", "--no-banner", "--project-path", str(ROOT),
                            "--", str(DUMP_CS), "120000"], capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"refcheck: could not run the unity CLI: {e}")
        return None
    if not DUMP_OUT.exists():
        tail = (r.stdout + r.stderr).strip().splitlines()[-1:] or ["(no output)"]
        print(f"refcheck: the Editor did not write the type list - is it open on this project? {tail[0][:300]}")
        return None
    exact, simple = set(), defaultdict(list)
    for line in DUMP_OUT.read_text(encoding="utf-8").splitlines():
        asm, _, full = line.partition("|")
        if not full:
            continue
        exact.add(f"{asm}|{full}")
        name = full.rsplit(".", 1)[-1].rsplit("+", 1)[-1]
        simple[name].append(f"{asm}|{full}")
    return exact, simple


def resolve(triples, exact, simple):
    """Every triple that does not resolve exactly: [class, ns, asm, verdict, uses, candidates]."""
    bad = []
    for (cls, ns, asm), uses in sorted(triples.items()):
        refl = cls.replace("/", "+")
        full = f"{ns}.{refl}" if ns else refl
        if f"{asm}|{full}" in exact:
            continue
        name = refl.rsplit("+", 1)[-1]
        cands = simple.get(name, [])
        bad.append([cls, ns, asm, "moved" if cands else "missing", uses, cands[:3]])
    return bad


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--types", action="store_true", help="also resolve every type against the running Editor")
    ap.add_argument("--all", action="store_true", help="also list baselined violations")
    ap.add_argument("--update-baseline", action="store_true", help="accept the current state as the floor")
    ap.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    args = ap.parse_args()

    paths = tracked_assets()
    missing, triples = scan(paths)

    unresolved = None
    if args.types:
        live = live_types()
        if live is None:
            print("refcheck: --types FAILED - no verdict on types. This is not a pass.")
            return 2
        unresolved = resolve(triples, *live)

    baseline = json.loads(args.baseline.read_text()) if args.baseline.exists() else {}
    known_missing = {tuple(x) for x in baseline.get("missing_data", [])}
    known_types = {tuple(x) for x in baseline.get("unresolved_types", [])}

    print(f"assets scanned        : {len(paths)} tracked")
    print(f"typed references      : {sum(triples.values())} ({len(triples)} distinct types)")
    new_missing = [m for m in missing if tuple(m) not in known_missing]
    print(f"A. missing data:      : {len(missing)}  ({len(new_missing)} new)")
    new_types = []
    if unresolved is not None:
        new_types = [u for u in unresolved if tuple(u[:3]) not in known_types]
        print(f"B. unresolved types   : {len(unresolved)}  ({len(new_types)} new)")
    else:
        print("B. unresolved types   : not checked (run with --types while the Editor is open)")

    if args.update_baseline:
        if unresolved is None:
            print("refcheck: --update-baseline needs --types, or the type floor would be silently erased.")
            return 2
        data = {
            "note": "Pre-existing violations accepted as the floor. New ones fail the gate. Regenerate only after "
                    "deliberately repairing or accepting one.",
            "missing_data": sorted(missing),
            "unresolved_types": sorted(u[:3] for u in unresolved),
        }
        args.baseline.write_text(json.dumps(data, indent=2) + "\n")
        print(f"baseline written: {args.baseline.relative_to(ROOT)}")
        return 0

    def show(title, rows, fmt):
        if rows:
            print(f"\n{title}")
            for r in rows:
                print("   " + fmt(r))

    show("NEW - missing data: (Unity drops these on load; the field reads null)", new_missing,
         lambda m: f"{m[0]}  rid {m[1]}  {m[2]}")
    show("NEW - unresolved types (check a 'moved' candidate by hand before re-pointing)", new_types,
         lambda u: f"{u[3]:7} x{u[4]:<3} {u[0]}  ({u[1]} / {u[2]})" + (f"  -> {u[5][0]}" if u[5] else ""))
    if args.all:
        show("baselined - missing data:", [m for m in missing if tuple(m) in known_missing],
             lambda m: f"{m[0]}  rid {m[1]}  {m[2]}")
        if unresolved is not None:
            show("baselined - unresolved types:", [u for u in unresolved if tuple(u[:3]) in known_types],
                 lambda u: f"{u[3]:7} x{u[4]:<3} {u[0]}  ({u[1]} / {u[2]})")

    if new_missing or new_types:
        print("\nFAIL: new managed-reference damage. See SKILL.md 'When it fails'.")
        return 1
    print("\nPASS: no new managed-reference damage.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
