#!/usr/bin/env python3
"""L1: compile runtime assemblies with a player's defines, from Unity's Bee response files, without the Editor.

  python3 .claude/skills/assembly-tier-check/playercompile.py FishNet.Runtime GameKit.Dependencies
  python3 .claude/skills/assembly-tier-check/playercompile.py --fishnet
  python3 .claude/skills/assembly-tier-check/playercompile.py --package com.module.ua-fishnet-addon
  python3 .claude/skills/assembly-tier-check/playercompile.py --override <repo path>=<scratch copy> FishNet.Runtime
  python3 .claude/skills/assembly-tier-check/playercompile.py --dag editor FishNet.Runtime

The player dag (Library/Bee/artifacts/*P.dag) is what the last player script compile left behind: ENABLE_IL2CPP, and
neither UNITY_EDITOR nor, with the Release managed code variant, UNITY_INCLUDE_INSTRUMENTATION. So a symbol used
outside its `#if UNITY_EDITOR`, or outside FishNet's `DEVELOPMENT`, fails here while every Editor test stays green.
`--dag editor` compiles the same sources with the Editor's defines, as a control.

Nothing is written under Library/. Outputs go to --out (a new temp folder by default). The defines and references
come from the chosen dag. The sources come from the Editor dag's response file of the same assembly, which every
Editor compile refreshes; each must exist, and no .cs file of the assembly's folder may be missing from the list.

The snapshot is the dag's last script compile (Library/Bee/<dag>-inputdata.json). When a named assembly's .asmdef, or
the .asmdef of a project assembly it references, is newer than that, the defines or references may be out of date:
that is "could not check". The fix is a fresh Release player script compile in the Editor: a player build, or
`UnityEditor.Build.Player.PlayerBuildInterface.CompilePlayerScripts` for StandaloneOSX with no options (about a
minute). A test-player run does not refresh it: test players compile into a dag of their own (Checked variant). The
snapshot holds no test assemblies.

Exit codes: 0 every assembly compiled with 0 errors, 1 compile errors, 2 could not check (no snapshot, a stale one,
no compiler). 2 is never a pass.
"""

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ARTIFACTS = Path("Library/Bee/artifacts")
PASS, FAIL, UNCHECKED = 0, 1, 2

# The FishNet stack: the fork, its transports, the shared GameKit code and the game's add-on.
FISHNET_PACKAGES = (
    "Packages/com.firstgeargames.fishnet",
    "Packages/com.firstgeargames.fishysteamworks",
    "Packages/com.module.ua-fishnet-shared",
    "Packages/com.module.ua-fishnet-addon",
)

# Constraints no player compile satisfies, so assemblies carrying them are never in a player dag.
EDITOR_ONLY_CONSTRAINTS = {"UNITY_EDITOR", "UNITY_INCLUDE_TESTS"}

_INSTALL = re.compile(r"^(/.+?)/(?:Unity\.app/Contents|PlaybackEngines)/")
_DIAGNOSTIC = re.compile(r": (error|warning) ([A-Z]+\d+):")


class Unchecked(Exception):
    """Nothing was compiled, or what was compiled cannot be trusted."""


def unquote(value):
    return value[1:-1] if len(value) >= 2 and value[0] == value[-1] == '"' else value


def read_rsp(path):
    return [line for line in Path(path).read_text(encoding="utf-8-sig").splitlines() if line.strip()]


def is_source(line):
    return not line.startswith(("-", "/")) and unquote(line).endswith(".cs")


def option_value(line):
    """`-r:"x"` → `x`; `/additionalfile:"x"` → `x`."""
    return unquote(line.split(":", 1)[1]) if ":" in line else ""


def find_dag(root, kind):
    """The newest `*P.dag` (player) or `*E.dag` (editor) folder under Library/Bee/artifacts. A player script compile
    with other settings gets a folder of its own (`200b0aP`, `200000P`, …), so the newest one is the freshest
    snapshot. Test players compile into `*PDevChkIns.dag`, which this never picks."""
    suffix = {"player": "P.dag", "editor": "E.dag"}[kind]
    found = [p for p in (root / ARTIFACTS).glob("*" + suffix) if p.is_dir()]
    if not found:
        raise Unchecked(f"no *{suffix} folder under {ARTIFACTS}: no {kind} script compile has run")

    def compiled(dag):
        inputdata = root / "Library/Bee" / (dag.name[:-len(".dag")] + "-inputdata.json")
        return inputdata.stat().st_mtime if inputdata.is_file() else 0

    return max(found, key=compiled)


def snapshot_time(root, dag):
    """When that dag's script compile last ran: Bee rewrites `<dag>-inputdata.json` each time, and a response file
    only when its own content changes."""
    inputdata = root / "Library/Bee" / (dag.name[:-len(".dag")] + "-inputdata.json")
    if not inputdata.is_file():
        raise Unchecked(f"no {inputdata.relative_to(root)}: no script compile has run for {dag.name}")
    return inputdata.stat().st_mtime


def install_root(lines):
    """The Unity install the response file compiles against, from its absolute reference and analyzer paths."""
    roots = set()
    for line in lines:
        if line.startswith(("-r:", "-analyzer:")):
            match = _INSTALL.match(option_value(line))
            if match:
                roots.add(match.group(1))
    if len(roots) != 1:
        raise Unchecked(f"expected one Unity install in the response file, found {sorted(roots)}")
    return Path(roots.pop())


def compiler(root_dir):
    """Unity's own dotnet and Roslyn csc.dll for that install. The MonoBleedingEdge csc wrapper is broken here."""
    scripting = root_dir / "Unity.app/Contents/Resources/Scripting/DotNetSdk"
    dotnet = scripting / "dotnet"
    cscs = sorted(glob.glob(str(scripting / "sdk/*/Roslyn/bincore/csc.dll")))
    if not dotnet.is_file() or len(cscs) != 1:
        raise Unchecked(f"no single compiler under {scripting} (dotnet: {dotnet.is_file()}, csc.dll: {len(cscs)})")
    return dotnet, Path(cscs[0])


def asmdef_index(root):
    """Assembly name → .asmdef path, for every asmdef under Assets/ and Packages/ (not in `~` or hidden folders)."""
    index = {}
    for top in ("Assets", "Packages"):
        for dirpath, dirnames, filenames in os.walk(root / top):
            dirnames[:] = [d for d in dirnames if not d.endswith("~") and not d.startswith(".")]
            for name in filenames:
                if name.endswith(".asmdef"):
                    path = Path(dirpath) / name
                    try:
                        data = json.loads(path.read_text(encoding="utf-8-sig"))
                    except (OSError, ValueError):
                        continue
                    index.setdefault(data.get("name") or path.stem, path)
    return index


def runtime_assemblies(root, package_dirs, index):
    """Every asmdef under the given folders that a player compiles: no Editor-only platform, no Editor constraint."""
    names = []
    for asm, path in sorted(index.items()):
        rel = path.relative_to(root).as_posix()
        if not any(rel.startswith(p.rstrip("/") + "/") for p in package_dirs):
            continue
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        platforms = data.get("includePlatforms") or []
        if platforms and "Editor" in platforms and len(platforms) == 1:
            continue
        if EDITOR_ONLY_CONSTRAINTS & set(data.get("defineConstraints") or []):
            continue
        names.append(asm)
    return names


def dag_references(lines, dag_name):
    """Project assemblies the response file references through the dag's own .ref.dll outputs."""
    prefix = f"{ARTIFACTS.as_posix()}/{dag_name}/"
    names = []
    for line in lines:
        if line.startswith("-r:"):
            value = option_value(line)
            if value.startswith(prefix) and value.endswith(".ref.dll"):
                names.append(value[len(prefix):-len(".ref.dll")])
    return names


def own_sources_on_disk(asmdef_path):
    """The .cs files under the asmdef's folder that belong to it: not under a nested .asmdef/.asmref, not in `~`."""
    found = set()
    base = asmdef_path.parent
    for dirpath, dirnames, filenames in os.walk(base):
        here = Path(dirpath)
        if here != base and any(f.endswith((".asmdef", ".asmref")) for f in filenames):
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if not d.endswith("~") and not d.startswith(".")]
        found.update(here / f for f in filenames if f.endswith(".cs"))
    return found


def check_sources(root, asm, sources, asmdef_path):
    """Every listed source exists, and every .cs file of the assembly's own folder is listed."""
    base = root.resolve()
    listed = {(base / s).resolve() for s in sources}
    missing = sorted(str(p.relative_to(base)) for p in listed if not p.is_file())
    on_disk = {p.resolve() for p in own_sources_on_disk(asmdef_path)}
    unlisted = sorted(str(p.relative_to(base)) for p in on_disk - listed)
    problems = []
    if missing:
        problems.append(f"{len(missing)} listed source(s) no longer exist, e.g. {missing[0]}")
    if unlisted:
        problems.append(f"{len(unlisted)} .cs file(s) on disk are not in the Editor's list, e.g. {unlisted[0]}")
    if problems:
        raise Unchecked(f"{asm}: " + "; ".join(problems) + ". Let the Editor compile first.")


def stale_asmdefs(asm, lines, dag_name, index, snapshot):
    """The .asmdef files (this assembly's and its dag references') written after the snapshot."""
    newer = []
    for name in [asm] + dag_references(lines, dag_name):
        path = index.get(name)
        if path is not None and path.stat().st_mtime > snapshot:
            newer.append(path)
    return newer


def dependency_order(names, refs_of):
    """Order the named assemblies so each comes after the named assemblies it references."""
    order, state = [], {}

    def visit(name):
        if state.get(name) == "done":
            return
        if state.get(name) == "visiting":
            raise Unchecked(f"reference cycle through {name}")
        state[name] = "visiting"
        for ref in refs_of.get(name, ()):
            if ref in refs_of:
                visit(ref)
        state[name] = "done"
        order.append(name)

    for name in names:
        visit(name)
    return order


def build_rsp(lines, sources, out_dir, asm, rebuilt, dag_name, overrides):
    """The dag's response file with this run's sources, outputs and rebuilt references."""
    prefix = f"{ARTIFACTS.as_posix()}/{dag_name}/"
    body = []
    for line in lines:
        if is_source(line):
            continue
        if line.startswith("-out:"):
            line = f'-out:"{out_dir / (asm + ".dll")}"'
        elif line.startswith("-refout:"):
            line = f'-refout:"{out_dir / (asm + ".ref.dll")}"'
        elif line.startswith("-r:"):
            value = option_value(line)
            if value.startswith(prefix) and value.endswith(".ref.dll"):
                ref = value[len(prefix):-len(".ref.dll")]
                if ref in rebuilt:
                    line = f'-r:"{rebuilt[ref]}"'
        body.append(line)
    used = set()
    for source in sources:
        path = overrides.get(source)
        if path is not None:
            used.add(source)
        body.append(f'"{path or source}"')
    unused = sorted(set(overrides) - used)
    return body, unused


def compile_one(dotnet, csc, rsp_path, cwd):
    proc = subprocess.run([str(dotnet), str(csc), "/nologo", f"@{rsp_path}"], cwd=cwd, capture_output=True,
                          text=True)
    lines = (proc.stdout + proc.stderr).splitlines()
    errors = [l for l in lines if _DIAGNOSTIC.search(l) and _DIAGNOSTIC.search(l).group(1) == "error"]
    warnings = [l for l in lines if _DIAGNOSTIC.search(l) and _DIAGNOSTIC.search(l).group(1) == "warning"]
    if proc.returncode != 0 and not errors:
        errors = [l for l in lines if l.strip()][-5:] or [f"csc exited {proc.returncode} with no output"]
    return errors, warnings


def age(seconds):
    minutes = int(seconds // 60)
    return f"{minutes // 60} h {minutes % 60} min" if minutes >= 60 else f"{minutes} min"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("assemblies", nargs="*", help="assembly names, as in their .asmdef")
    ap.add_argument("--dag", choices=["player", "editor"], default="player")
    ap.add_argument("--fishnet", action="store_true", help="every runtime assembly of the FishNet stack")
    ap.add_argument("--package", action="append", default=[], help="every runtime assembly under this folder")
    ap.add_argument("--override", action="append", default=[], metavar="REPO_PATH=FILE",
                    help="compile FILE in place of the source REPO_PATH (a scratch copy)")
    ap.add_argument("--out", help="output folder (default: a new temp folder)")
    ap.add_argument("--root", default=str(ROOT), help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    root = Path(a.root)

    try:
        index = asmdef_index(root)
        folders = list(FISHNET_PACKAGES if a.fishnet else ()) + [
            p if p.startswith(("Packages/", "Assets/")) else "Packages/" + p for p in a.package]
        names = list(dict.fromkeys(a.assemblies + runtime_assemblies(root, folders, index)))
        if not names:
            raise Unchecked("no assembly named; pass names, --fishnet or --package")
        overrides = {}
        for item in a.override:
            repo_path, _, file = item.partition("=")
            if not file or not Path(file).is_file():
                raise Unchecked(f"--override {item}: expected REPO_PATH=FILE with an existing FILE")
            overrides[repo_path] = str(Path(file).resolve())

        dag = find_dag(root, a.dag)
        editor_dag = find_dag(root, "editor")
        lines_of, sources_of = {}, {}
        for asm in names:
            rsp = dag / f"{asm}.rsp"
            if not rsp.is_file():
                raise Unchecked(f"{dag.name} has no {asm}.rsp: it is not a player assembly, or no player script "
                                f"compile has run since it was added")
            lines_of[asm] = read_rsp(rsp)
            editor_rsp = editor_dag / f"{asm}.rsp"
            if not editor_rsp.is_file():
                raise Unchecked(f"{editor_dag.name} has no {asm}.rsp: let the Editor compile first")
            sources_of[asm] = [unquote(l) for l in read_rsp(editor_rsp) if is_source(l)]
            if asm in index:
                check_sources(root, asm, sources_of[asm], index[asm])

        snapshot = snapshot_time(root, dag)
        print(f"snapshot: {dag.name}, compiled {time.strftime('%Y-%m-%d %H:%M', time.localtime(snapshot))} "
              f"({age(time.time() - snapshot)} ago)")
        stale = {asm: stale_asmdefs(asm, lines_of[asm], dag.name, index, snapshot) for asm in names}
        stale = {k: v for k, v in stale.items() if v}
        if stale:
            for asm, paths in stale.items():
                for p in paths:
                    print(f"    {asm}: {p.relative_to(root)} is newer than the snapshot")
            raise Unchecked("the snapshot predates an .asmdef it depends on; run a player script compile first")

        dotnet, csc = compiler(install_root(lines_of[names[0]]))
        print(f"compiler: {csc}")
        out = Path(a.out) if a.out else Path(tempfile.mkdtemp(prefix="playercompile-"))
        (out / "rsp").mkdir(parents=True, exist_ok=True)

        refs_of = {asm: dag_references(lines_of[asm], dag.name) for asm in names}
        rebuilt, failed, unused_overrides = {}, 0, set(overrides)
        for asm in dependency_order(names, refs_of):
            body, unused = build_rsp(lines_of[asm], sources_of[asm], out, asm, rebuilt, dag.name, overrides)
            unused_overrides &= set(unused)
            rsp_path = out / "rsp" / f"{asm}.rsp"
            rsp_path.write_text("\n".join(body) + "\n", encoding="utf-8")
            errors, warnings = compile_one(dotnet, csc, rsp_path, root)
            dll = out / f"{asm}.dll"
            if not errors and not dll.is_file():
                errors = [f"csc reported no error but wrote no {dll.name}"]
            if errors:
                failed += 1
                print(f"FAIL {asm}: {len(errors)} error(s), {len(warnings)} warning(s)")
                for line in errors[:20]:
                    print(f"    {line.strip()[:260]}")
            else:
                rebuilt[asm] = out / f"{asm}.ref.dll"
                print(f"ok   {asm}: 0 errors, {len(warnings)} warning(s)")
        if unused_overrides:
            raise Unchecked(f"--override matched no source of the named assemblies: {sorted(unused_overrides)}")
        print(f"{a.dag} dag: {len(names) - failed}/{len(names)} assemblies compiled with 0 errors (outputs: {out})")
        return FAIL if failed else PASS
    except Unchecked as e:
        print(f"UNCHECKED: {e}")
        return UNCHECKED


if __name__ == "__main__":
    sys.exit(main())
