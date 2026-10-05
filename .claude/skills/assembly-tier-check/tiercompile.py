#!/usr/bin/env python3
"""Offline compile of every project assembly under its CURRENT on-disk name.

Unity is closed during the tier rename, so this stands in for the Editor's compile.
It reuses the Editor's last Bee response files (Library/Bee/artifacts/200b0aE.dag),
looked up by the assembly's OLD name, and rewrites them so that:
  * -out/-refout go to a scratch dir under the assembly's CURRENT name (so
    InternalsVisibleTo matches the new names);
  * project-assembly references come from the asmdef's current "references"
    list, never from Bee (a dropped reference is then really absent);
  * sources are re-discovered on disk (the nearest .asmdef/.asmref owns a
    .cs file), so moved and new files count; Bee's list is only compared;
  * everything Unity adds on its own (engine, PackageCache, TestRunner,
    analyzers, defines, precompiled DLLs) is kept as Bee wrote it;
  * the predefined Assembly-CSharp* assemblies get their project references
    remapped old -> new by name.
The compiler (dotnet + Roslyn csc.dll) is the one in the Editor install those
response files name, so it always matches the engine references they carry; a
missing install, or rsps naming more than one, stop the run (editor_compiler).

Three rules keep it honest while assemblies are renamed, merged and deleted:
  * renames: every old name of a current assembly counts (tier-map.json may hold
    several, and chains old -> mid -> new), so no old name's Library/Bee DLL is
    referenced and no stale old DLL is left in <out>/bin (rename_sets);
  * deleted assemblies: a Bee rsp for a project assembly that is neither current
    nor an old name of one is an assembly deleted since Unity's last compile;
    every reference to its stale Library/Bee DLL is stripped, so a consumer that
    still uses its types fails as it would in the Editor (deleted_assemblies);
  * Assembly-CSharp*: a root script that is gone is dropped from Bee's list and
    reported, and a new one is reported, not compiled (rewrite_predefined_rsp).

Usage: tiercompile.py <scratch-out-dir> [--only name,name] [--drop asm:ref] [--root project]
  --drop compiles as if asm did not reference ref (proves a reference dead without editing it)
  --root compiles another copy of the project, e.g. a code-only mirror with Library/ symlinked
Exit 0 only when every attempted assembly produced a DLL with no errors.
"""
import argparse, json, os, re, subprocess, sys, collections, concurrent.futures as cf
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DAG_REL = "Library/Bee/artifacts/200b0aE.dag"
DAG = ROOT / DAG_REL
PREDEFINED = ("Assembly-CSharp-firstpass", "Assembly-CSharp", "Assembly-CSharp-Editor")
# The Editor install an rsp compiles against, from any quoted path into it (engine -r:, -analyzer:),
# e.g. "/Applications/Unity/Hub/Editor/<version>/Unity.app/Contents/Managed/...".
EDITOR_APP = re.compile(r'"(/[^"\n]*/Unity\.app)/Contents/')
# Walks start inside Packages/ and Assets/, so a folder is skipped only by Unity's own import rules
# (hidden ".x", trailing "~") - never by name: a package may well hold a folder called Library.
SKIP_DIRS = {"node_modules"}
GUID_RE = re.compile(r"^guid:\s*([0-9a-f]{32})", re.M)
BEE_REF = re.compile(r'^-r:"Library/Bee/artifacts/200b0aE\.dag/(.+)\.ref\.dll"\s*$')


def project_asmdefs():
    out = {}
    for base in ("Packages", "Assets"):
        for dp, dns, fns in os.walk(ROOT / base):
            dns[:] = [d for d in dns if d not in SKIP_DIRS and not d.endswith("~") and not d.startswith(".")]
            for f in fns:
                if f.endswith(".asmdef"):
                    p = Path(dp) / f
                    d = json.loads(p.read_text(encoding="utf-8-sig"))
                    meta = Path(str(p) + ".meta")
                    g = None
                    if meta.exists():
                        m = GUID_RE.search(meta.read_text(errors="ignore"))
                        g = m.group(1) if m else None
                    out[d["name"]] = {"path": p, "refs": d.get("references", []) or [], "guid": g}
    return out


def discover_sources(by_guid):
    """({assembly: [project-relative .cs paths]}, [unowned Assets/ .cs paths]) - Unity's rule: the nearest
    ancestor folder holding an .asmdef (or an .asmref, which lends the folder to another assembly) owns a
    file. An unowned file under Assets/ belongs to a predefined Assembly-CSharp*."""
    owner = {}
    walked = []
    for base in ("Packages", "Assets"):
        for dp, dns, fns in os.walk(ROOT / base):
            dns[:] = [d for d in dns if d not in SKIP_DIRS and not d.endswith("~") and not d.startswith(".")]
            walked.append((dp, fns))
            for f in fns:
                if f.endswith(".asmdef"):
                    owner[dp] = json.loads((Path(dp) / f).read_text(encoding="utf-8-sig"))["name"]
                elif f.endswith(".asmref"):
                    r = json.loads((Path(dp) / f).read_text(encoding="utf-8-sig"))["reference"]
                    owner[dp] = by_guid.get(r[5:], r) if r.startswith("GUID:") else r
    src = collections.defaultdict(list)
    unowned = []
    for dp, fns in walked:
        d = dp
        while d not in owner and len(d) > len(str(ROOT)):
            d = os.path.dirname(d)
        files = [os.path.relpath(os.path.join(dp, f), ROOT) for f in fns if f.endswith(".cs")]
        if d in owner:
            src[owner[d]].extend(files)
        else:
            unowned.extend(f for f in files if f.startswith("Assets/"))
    return src, unowned


def rename_sets(full, current):
    """(new -> [old names], old name -> current name) for the renames that have happened on disk.

    `full` is tier-map.json's map. Several old names may point at one new name, and a chain
    old -> mid -> new resolves to the name that exists. A name that is still an assembly is never an
    old name, and a rename whose target is gone maps nothing."""
    new2olds, old2cur = collections.defaultdict(list), {}
    for old in full:
        if old in current:
            continue
        cur, seen = full[old], {old}
        while cur not in current and cur in full and cur not in seen:
            seen.add(cur)
            cur = full[cur]
        if cur in current:
            new2olds[cur].append(old)
            old2cur[old] = cur
    return new2olds, old2cur


def choose_rsp(dag, name, olds=()):
    """The Bee rsp for an assembly: its own when Unity compiled it under the current name, otherwise
    the newest one among its old names (the Editor's last compile predates the rename); None if none."""
    cur = Path(dag) / f"{name}.rsp"
    if cur.exists():
        return cur
    found = [p for p in (Path(dag) / f"{o}.rsp" for o in olds) if p.exists()]
    return max(found, key=lambda p: p.stat().st_mtime) if found else None


def rsp_sources(lines):
    """The .cs source lines of a Bee rsp, as project-relative paths."""
    return [ln[1:-1] for ln in lines if ln.startswith('"') and ln.endswith('.cs"')]


def deleted_assemblies(dag_sources, current, old2cur):
    """Assemblies deleted since Unity's last compile: a Bee rsp whose name is neither a current asmdef
    nor an old name of one (renames resolve first), and whose sources were all project files under
    Packages/ or Assets/. A PackageCache assembly stays out even when an .asmref lends it a project file
    (a UI Effect sample lends one to Unity.RenderPipelines.Universal.Editor), and so does a predefined
    Assembly-CSharp* or an rsp with no sources to judge by."""
    return {n for n, srcs in dag_sources.items()
            if n not in current and n not in old2cur and not n.startswith("Assembly-CSharp")
            and srcs and all(s.startswith(("Packages/", "Assets/")) for s in srcs)}


def rewrite_project_rsp(lines, strip):
    """(kept lines, Bee's source set) for a project assembly's Bee rsp. Drops -out/-refout, every Bee
    reference to a name in `strip` (project assemblies are re-added from the asmdef; deleted ones must
    not resolve to their stale DLL) and the source lines (re-discovered on disk)."""
    kept, bee_src = [], set()
    for ln in lines:
        if ln.startswith("-out:") or ln.startswith("-refout:"):
            continue
        m = BEE_REF.match(ln)
        if m and m.group(1) in strip:
            continue
        if ln.startswith('"') and ln.endswith('.cs"'):
            bee_src.add(ln[1:-1])
            continue
        kept.append(ln)
    return [k for k in kept if k.strip()], bee_src


def rewrite_predefined_rsp(lines, root, out, proj_names, old2cur, deleted):
    """(kept lines, project deps, dropped sources) for a predefined Assembly-CSharp* Bee rsp. Its project
    references are remapped old -> current into <out>/bin, a deleted assembly's is dropped, and a source
    file that no longer exists on disk is dropped and returned (Unity would drop it too)."""
    kept, pdeps, dropped = [], [], []
    for ln in lines:
        if not ln.strip() or ln.startswith("-out:") or ln.startswith("-refout:"):
            continue
        m = BEE_REF.match(ln)
        if m:
            name = m.group(1)
            if name in deleted:
                continue
            if name in proj_names or name.startswith("Assembly-CSharp"):
                cur = old2cur.get(name, name)
                pdeps.append(cur)
                kept.append(f'-r:"{out}/bin/{cur}.ref.dll"')
                continue
        if ln.startswith('"') and ln.endswith('.cs"') and not (Path(root) / ln[1:-1]).exists():
            dropped.append(ln[1:-1])
            continue
        kept.append(ln)
    return kept, pdeps, dropped


def purge_stale(bin_dir, names):
    """Delete <name>.dll and <name>.ref.dll from a reused <out>/bin for old and deleted names, so a DLL
    from an earlier run can never stand in for an assembly that no longer exists. Returns what went."""
    removed = []
    for n in sorted(names):
        for f in (Path(bin_dir) / f"{n}.dll", Path(bin_dir) / f"{n}.ref.dll"):
            if f.exists():
                f.unlink()
                removed.append(f)
    return removed


def editor_compiler(jobs):
    """(dotnet, csc.dll) of the one Editor install that the response files in `jobs` compile against.

    Never a constant: an Editor upgrade rewrites every Bee rsp to the new install and the Hub may
    remove the old one (2026-09-24, 6000.6.2f1 -> 6000.6.3f1 broke a hard-coded path). Nor
    ProjectVersion.txt, which lags until the Editor saves it. Taken from the rsps, the compiler always
    matches the engine references it compiles against, so there is no fallback to another install."""
    named = collections.defaultdict(list)
    for n, lines in jobs.items():
        for app in {m.group(1) for m in map(EDITOR_APP.search, lines) if m}:
            named[app].append(n)
    if not named:
        sys.exit('no Bee response file names a Unity Editor install ("/.../Unity.app/Contents/..."), '
                 "so no compiler can be matched to them")
    if len(named) > 1:
        found = "; ".join(f"{a} ({len(ns)} of {len(jobs)} rsps, e.g. {min(ns)})"
                          for a, ns in sorted(named.items()))
        sys.exit(f"the Bee response files name {len(named)} Unity Editor installs: {found} - "
                 "let Unity finish compiling so it rewrites Library/Bee, then re-run")
    app = Path(next(iter(named)))
    sdk = app / "Contents/Resources/Scripting/DotNetSdk"
    if not (sdk / "dotnet").is_file():
        installed = sorted(p.parent.name for p in app.parent.parent.glob("*/Unity.app"))
        sys.exit(f"Library/Bee compiles against {app}, which is not installed (no {sdk / 'dotnet'}; "
                 f"installed beside it: {', '.join(installed) or 'none'}) - reopen the project in an "
                 "installed Editor so it rewrites Library/Bee, or reinstall that one. No other install "
                 "is used: its compiler would not match these engine references.")
    csc = sorted(sdk.glob("sdk/*/Roslyn/bincore/csc.dll"))
    if len(csc) != 1:
        sys.exit(f"expected one Roslyn compiler (sdk/*/Roslyn/bincore/csc.dll) in {sdk}, found {len(csc)}"
                 + "".join(f"\n  {c}" for c in csc))
    return sdk / "dotnet", csc[0]


def main(argv=None):
    global ROOT, DAG
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--map", default=str(Path(__file__).with_name("tier-map.json")))
    ap.add_argument("--only", default="")
    ap.add_argument("-j", type=int, default=8)
    ap.add_argument("--drop", action="append", default=[], help="trial only: asm:ref to drop from asm's references")
    ap.add_argument("--root", default=str(ROOT), help="the project to compile (default: this project)")
    args = ap.parse_args(argv)
    ROOT = Path(args.root).resolve()
    DAG = ROOT / DAG_REL
    if not any(DAG.glob("*.rsp")):
        # a wiped Library/ (or one Unity has not rebuilt yet) - without the Bee response files there are no
        # defines, engine references or PackageCache sources, so nothing can be compiled honestly
        sys.exit(f"no Bee response files in {DAG.relative_to(ROOT)} - open the project in Unity once "
                 "so it rebuilds Library/, then re-run")
    out = Path(args.out).resolve()
    (out / "rsp").mkdir(parents=True, exist_ok=True)
    (out / "bin").mkdir(parents=True, exist_ok=True)
    (out / "err").mkdir(parents=True, exist_ok=True)

    full = json.load(open(args.map))["map"] if Path(args.map).exists() else {}
    asm = project_asmdefs()
    by_guid = {v["guid"]: k for k, v in asm.items() if v["guid"]}
    cur_names = set(asm)
    # every old name of each current name: only renames that have actually happened on disk
    new2olds, old2cur = rename_sets(full, cur_names)
    # an rsp from before a rename names project assemblies by their old names, one from after by the current
    proj_names = cur_names | set(old2cur)
    # assemblies deleted since Unity's last compile (renames resolved first): their Library/Bee DLLs are stale
    dag_sources = {}
    for rsp in DAG.glob("*.rsp"):
        n = rsp.stem
        if n not in proj_names and not n.startswith("Assembly-CSharp"):
            dag_sources[n] = rsp_sources(rsp.read_text(encoding="utf-8", errors="ignore").split("\n"))
    deleted = deleted_assemblies(dag_sources, cur_names, old2cur)
    strip = proj_names | deleted

    def resolve(r):
        if r.startswith("GUID:"):
            return by_guid.get(r[5:])
        return r if r in asm else None

    deps = {n: sorted({resolve(r) for r in v["refs"]} - {None}) for n, v in asm.items()}
    for spec in args.drop:
        a, r = spec.split(":", 1)
        assert r in deps[a], f"--drop {spec}: {r} is not a reference of {a}"
        deps[a].remove(r)

    sources, unowned = discover_sources(by_guid)
    src_drift = []
    missing = []
    jobs = {}
    for n in cur_names:
        rsp = choose_rsp(DAG, n, new2olds.get(n, []))  # an old name's when the Editor's last compile predates the rename
        if rsp is None:
            missing.append(n)
            continue
        # project references are re-added from the asmdef below; sources are re-discovered on disk
        kept, bee_src = rewrite_project_rsp(rsp.read_text(encoding="utf-8").split("\n"), strip)
        disk = sorted(sources.get(n, []))
        if set(disk) != bee_src:
            src_drift.append(f"{n}: Bee {len(bee_src)} -> disk {len(disk)} "
                             f"(+{len(set(disk) - bee_src)} -{len(bee_src - set(disk))})")
        kept.extend(f'"{f}"' for f in disk)
        kept.insert(0, f'-out:"{out}/bin/{n}.dll"')
        kept.insert(1, f'-refout:"{out}/bin/{n}.ref.dll"')
        for d in deps[n]:
            kept.append(f'-r:"{out}/bin/{d}.ref.dll"')
        jobs[n] = kept

    # predefined assemblies: remap their project references by name; they keep Bee's source list, minus
    # the files that are gone. A new root script is reported, not compiled: the Editor compile covers it.
    predefined_src = set()
    for pre in PREDEFINED:
        rsp = DAG / f"{pre}.rsp"
        if not rsp.exists():
            continue
        lines = rsp.read_text(encoding="utf-8").split("\n")
        predefined_src.update(rsp_sources(lines))
        kept, pdeps, dropped = rewrite_predefined_rsp(lines, ROOT, out, proj_names, old2cur, deleted)
        if dropped:
            src_drift.append(f"{pre}: {len(dropped)} source(s) gone from disk, dropped: "
                             + ", ".join(dropped[:5]) + (" ..." if len(dropped) > 5 else ""))
        kept.insert(0, f'-out:"{out}/bin/{pre}.dll"')
        kept.insert(1, f'-refout:"{out}/bin/{pre}.ref.dll"')
        jobs[pre] = kept
        deps[pre] = pdeps
    new_root = sorted(set(unowned) - predefined_src)
    if new_root:
        src_drift.append(f"root scripts newer than Unity's last compile, not compiled here ({len(new_root)}): "
                         + ", ".join(new_root[:5]) + (" ..." if len(new_root) > 5 else ""))

    if args.only:
        want = set(args.only.split(","))
        # compile the requested assemblies plus everything they depend on
        closure, stack = set(), list(want)
        while stack:
            x = stack.pop()
            if x in closure or x not in jobs:
                continue
            closure.add(x)
            stack.extend(deps.get(x, []))
        jobs = {k: v for k, v in jobs.items() if k in closure}

    dotnet = csc = None  # an empty run compiles nothing and fails below
    if jobs:
        dotnet, csc = editor_compiler(jobs)
        print(f"compiler: {csc}", flush=True)

    for n, kept in jobs.items():
        (out / "rsp" / f"{n}.rsp").write_text("\n".join(kept) + "\n", encoding="utf-8")
    purged = purge_stale(out / "bin", set(old2cur) | deleted)  # a reused <out> must not keep them alive

    # topological levels
    level = {}
    def lv(n, seen=()):
        if n in level:
            return level[n]
        ds = [d for d in deps.get(n, []) if d in jobs]
        level[n] = 0 if not ds else 1 + max(lv(d, seen + (n,)) for d in ds)
        return level[n]
    for n in jobs:
        lv(n)
    waves = collections.defaultdict(list)
    for n, l in level.items():
        waves[l].append(n)

    env = dict(os.environ, DOTNET_ROLL_FORWARD="Major")
    results = {}

    def run(n):
        # A failure with no "error" line is the compiler process dying (seen: a Roslyn
        # MissingMethodException under heavy parallel load), not the code - retry it.
        for attempt in range(3):
            for f in (out / "bin" / f"{n}.dll", out / "bin" / f"{n}.ref.dll"):
                if f.exists():
                    f.unlink()
            p = subprocess.run([str(dotnet), str(csc), "-nologo", f"@{out}/rsp/{n}.rsp"], cwd=ROOT,
                               capture_output=True, text=True, env=env)
            text = p.stdout + p.stderr
            errs = [l for l in text.splitlines() if ": error " in l or l.startswith("error ")]
            (out / "err" / f"{n}.txt").write_text(text)
            ok = p.returncode == 0 and (out / "bin" / f"{n}.dll").exists()
            if ok or errs:
                break
        if not ok and not errs:
            errs = ["compiler process failed 3x without an error line - see err/" + n + ".txt"]
        return n, ok, errs

    for l in sorted(waves):
        with cf.ThreadPoolExecutor(args.j) as ex:
            for n, ok, errs in ex.map(run, sorted(waves[l])):
                results[n] = (ok, errs)

    # A parallel run can lose an assembly to a compiler-process crash (and its dependents then
    # fail on the missing .ref.dll). Re-run every failure once, serially, in dependency order;
    # only what still fails is real.
    first = sorted((n for n, (ok, e) in results.items() if not ok), key=lambda n: level[n])
    recovered = []
    for n in first:
        _, ok, errs = run(n)
        results[n] = (ok, errs)
        if ok:
            recovered.append(n)
    produced = sum(1 for n in jobs if (out / "bin" / f"{n}.dll").exists())
    failed = {n: e for n, (ok, e) in results.items() if not ok}

    print(f"attempted {len(jobs)}  produced {produced}  failed {len(failed)}  no-rsp {len(missing)}")
    if deleted:
        print(f"  deleted since Unity's last compile, their Library/Bee DLLs ignored ({len(deleted)}): "
              + ", ".join(sorted(deleted)))
    if purged:
        print(f"  stale DLLs removed from {out.name}/bin: " + ", ".join(p.name for p in purged))
    if recovered:
        print(f"  recovered on a serial re-run (parallel-run flake, not the code): {', '.join(recovered)}")
    if missing:
        print("  no Bee rsp:", ", ".join(sorted(missing)))
    if src_drift:
        print(f"  source lists differ from Unity's last compile ({len(src_drift)}; moved/added/removed files):")
        for d in src_drift[:30]:
            print("    " + d)
    for n in sorted(failed):
        errs = failed[n]
        print(f"  FAIL {n}: {len(errs)} error(s)")
        for e in errs[:6]:
            print("     ", e.replace(str(ROOT) + "/", "")[:300])
    if not jobs:
        print("  FAIL: nothing was compiled - an empty run is not a pass")
    return 0 if jobs and not failed and produced == len(jobs) else 1


if __name__ == "__main__":
    sys.exit(main())
