#!/usr/bin/env python3
"""Tests for tiercompile.py's rename, deleted-assembly and predefined-source rules.

The unit tests use temp folders only. MirrorCompile runs the real offline compile against a code-only copy of
the project (Library/ symlinked), so it needs the Editor's Library/Bee and takes about a minute; it runs only
with TIERCOMPILE_MIRROR=1.
Run: python3 -m unittest discover -s .claude/skills/assembly-tier-check -p 'test_*.py'
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import tiercompile  # noqa: E402

BEE = "Library/Bee/artifacts/200b0aE.dag"


class RenameSets(unittest.TestCase):
    def test_two_old_names_for_one_new_name_both_map_to_it(self):
        new2olds, old2cur = tiercompile.rename_sets({"ModuleT1.UI": "Module.PC.UI", "Module.TA.UI": "Module.PC.UI"},
                                                    {"Module.PC.UI"})
        self.assertEqual(["Module.TA.UI", "ModuleT1.UI"], sorted(new2olds["Module.PC.UI"]))
        self.assertEqual({"ModuleT1.UI": "Module.PC.UI", "Module.TA.UI": "Module.PC.UI"}, old2cur)

    def test_a_chain_resolves_to_the_current_name(self):
        _, old2cur = tiercompile.rename_sets({"A1": "A2", "A2": "A3"}, {"A3"})
        self.assertEqual({"A1": "A3", "A2": "A3"}, old2cur)

    def test_a_name_that_is_still_an_assembly_is_not_an_old_name(self):
        new2olds, old2cur = tiercompile.rename_sets({"A": "B"}, {"A", "B"})
        self.assertEqual({}, old2cur)
        self.assertEqual({}, dict(new2olds))

    def test_a_rename_whose_target_is_gone_maps_nothing(self):
        self.assertEqual({}, tiercompile.rename_sets({"A": "B"}, {"C"})[1])


class ChooseRsp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dag = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def touch(self, name, age_s):
        p = self.dag / f"{name}.rsp"
        p.write_text("-target:library\n")
        t = time.time() - age_s
        os.utime(p, (t, t))
        return p

    def test_the_current_name_wins(self):
        self.touch("Old", 10)
        cur = self.touch("New", 100)
        self.assertEqual(cur, tiercompile.choose_rsp(self.dag, "New", ["Old"]))

    def test_the_newest_old_rsp_wins_when_there_is_none_for_the_current_name(self):
        self.touch("Older", 100)
        newer = self.touch("Newer", 10)
        self.assertEqual(newer, tiercompile.choose_rsp(self.dag, "New", ["Older", "Newer"]))

    def test_no_rsp_gives_none(self):
        self.assertIsNone(tiercompile.choose_rsp(self.dag, "New", ["Old"]))


class DeletedAssemblies(unittest.TestCase):
    def test_a_project_assembly_with_no_asmdef_is_deleted(self):
        found = tiercompile.deleted_assemblies(
            {"Module.PC.InputSystem.UI": ["Packages/com.module.pb-creator-base/Runtime/Input/UI/UnityPlayerInputPlayer.cs"],
             "Module.PC.UI": ["Packages/com.module.pb-creator-base/Runtime/Input/UI/Core/UIFocus.cs"]},
            {"Module.PC.UI"}, {})
        self.assertEqual({"Module.PC.InputSystem.UI"}, found)

    def test_a_renamed_assembly_is_not_deleted(self):
        found = tiercompile.deleted_assemblies({"Module.TA.UI": ["Packages/com.module.pc-creator-ui/Runtime/x.cs"]},
                                               {"Module.PC.UI"}, {"Module.TA.UI": "Module.PC.UI"})
        self.assertEqual(set(), found)

    def test_a_PackageCache_assembly_is_not_deleted(self):
        found = tiercompile.deleted_assemblies({"Unity.Timeline": ["Library/PackageCache/com.unity.timeline@1/a.cs"]},
                                               set(), {})
        self.assertEqual(set(), found)

    def test_a_PackageCache_assembly_that_an_asmref_lends_a_project_file_is_not_deleted(self):
        # Seen 2026-09-25: the UI Effect sample lends one Assets/ file to Unity.RenderPipelines.Universal.Editor.
        found = tiercompile.deleted_assemblies(
            {"Unity.RenderPipelines.Universal.Editor": [
                "Library/PackageCache/com.unity.render-pipelines.universal@17/Editor/a.cs",
                "Assets/Samples/UI Effect/5.10.8/ShaderGraph Support (Unity 6 URP)/UniversalUIEffectSubTarget.cs"]},
            set(), {})
        self.assertEqual(set(), found)

    def test_an_assembly_with_no_sources_is_not_deleted(self):
        self.assertEqual(set(), tiercompile.deleted_assemblies({"Empty": []}, set(), {}))

    def test_predefined_assemblies_are_never_deleted(self):
        found = tiercompile.deleted_assemblies({"Assembly-CSharp": ["Assets/Scripts/A.cs"]}, set(), {})
        self.assertEqual(set(), found)


class ProjectRsp(unittest.TestCase):
    def test_a_deleted_assemblys_Bee_reference_is_stripped(self):
        lines = ["-target:library", '-out:"Library/Bee/x.dll"',
                 f'-r:"{BEE}/Module.UB.FishNet.InputSystem.ref.dll"',
                 f'-r:"{BEE}/Unity.InputSystem.ref.dll"',
                 '"Packages/com.module.ua-fishnet-addon/Runtime/Player/FishNetPlayerHandler.cs"']
        kept, bee_src = tiercompile.rewrite_project_rsp(lines, {"Module.UB.FishNet.InputSystem"})
        self.assertNotIn(f'-r:"{BEE}/Module.UB.FishNet.InputSystem.ref.dll"', kept)
        self.assertIn(f'-r:"{BEE}/Unity.InputSystem.ref.dll"', kept)
        self.assertEqual({"Packages/com.module.ua-fishnet-addon/Runtime/Player/FishNetPlayerHandler.cs"}, bee_src)
        self.assertFalse(any(k.startswith("-out:") for k in kept))


class PredefinedRsp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "Assets/Scripts").mkdir(parents=True)
        (self.root / "Assets/Scripts/Keep.cs").write_text("class Keep {}")
        self.out = self.root / "out"

    def tearDown(self):
        self.tmp.cleanup()

    def rewrite(self, lines, proj_names=(), old2cur=None, deleted=()):
        return tiercompile.rewrite_predefined_rsp(lines, self.root, self.out, set(proj_names), old2cur or {},
                                                  set(deleted))

    def test_a_root_script_that_is_gone_is_dropped_and_reported(self):
        kept, deps, dropped = self.rewrite(["-target:library", '"Assets/Scripts/Keep.cs"', '"Assets/Scripts/Gone.cs"'])
        self.assertIn('"Assets/Scripts/Keep.cs"', kept)
        self.assertNotIn('"Assets/Scripts/Gone.cs"', kept)
        self.assertEqual(["Assets/Scripts/Gone.cs"], dropped)

    def test_a_reference_to_a_deleted_assembly_is_dropped(self):
        kept, deps, _ = self.rewrite([f'-r:"{BEE}/Module.PC.InputSystem.UI.ref.dll"'],
                                     deleted={"Module.PC.InputSystem.UI"})
        self.assertEqual([], [k for k in kept if "InputSystem.UI" in k])
        self.assertEqual([], deps)

    def test_a_reference_to_an_old_name_is_remapped(self):
        kept, deps, _ = self.rewrite([f'-r:"{BEE}/Module.TA.UI.ref.dll"'], proj_names={"Module.TA.UI", "Module.PC.UI"},
                                     old2cur={"Module.TA.UI": "Module.PC.UI"})
        self.assertIn(f'-r:"{self.out}/bin/Module.PC.UI.ref.dll"', kept)
        self.assertEqual(["Module.PC.UI"], deps)


class StaleBin(unittest.TestCase):
    def test_old_and_deleted_names_leave_the_bin(self):
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir = Path(tmp)
            for f in ("Old.dll", "Old.ref.dll", "Gone.ref.dll", "Live.ref.dll"):
                (bin_dir / f).write_text("x")
            removed = tiercompile.purge_stale(bin_dir, {"Old", "Gone"})
            self.assertEqual(["Gone.ref.dll", "Old.dll", "Old.ref.dll"], sorted(p.name for p in removed))
            self.assertTrue((bin_dir / "Live.ref.dll").exists())


@unittest.skipUnless(os.environ.get("TIERCOMPILE_MIRROR") == "1", "set TIERCOMPILE_MIRROR=1 to run the offline compile")
class MirrorCompile(unittest.TestCase):
    """The real compiler on a code-only copy of the project, with Library/ symlinked in."""

    PROJECT = tiercompile.ROOT
    CODE = (".cs", ".asmdef", ".asmref", ".dll", ".rsp")

    @classmethod
    def copy_code(cls, rel):
        """Copy the code files under Packages/ or Assets/ path `rel` from the project into the mirror."""
        start = cls.PROJECT / rel
        walk = [(str(start.parent), [], [start.name])] if start.is_file() else os.walk(start)
        for dp, dns, fns in walk:
            dns[:] = [d for d in dns if d != ".git" and not d.endswith("~") and not d.startswith(".")]
            for f in fns:
                src = Path(dp) / f
                if f.endswith(cls.CODE) or f.endswith((".asmdef.meta", ".asmref.meta")):
                    dst = cls.mirror / src.relative_to(cls.PROJECT)
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dst)

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.mirror = Path(cls.tmp.name) / "mirror"
        for base in ("Packages", "Assets"):
            cls.copy_code(base)
        (cls.mirror / "Library").symlink_to(cls.PROJECT / "Library")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def setUp(self):
        self.touched = []

    def tearDown(self):
        for rel in self.touched:  # each test starts from the project's state
            self.copy_code(rel)

    def compile(self, name, *extra):
        out = Path(self.tmp.name) / name
        p = subprocess.run([sys.executable, str(HERE / "tiercompile.py"), str(out), "--root", str(self.mirror), *extra],
                           capture_output=True, text=True)
        return p.returncode, p.stdout + p.stderr

    def test_1_a_deleted_assemblys_stale_dll_does_not_satisfy_its_old_consumer(self):
        # Module.UB.FishNet.TSpatial goes, and the Player assembly still uses its types (RegionAssetSpawnGate,
        # IPlayerSpawnDataProvider) while its asmdef no longer references it: that must fail, not pass on the stale
        # Library/Bee DLL. (Until UI + input plan P7 this deleted Module.UB.FishNet.InputSystem, which P7 really deleted.)
        spatial = "Packages/com.module.ua-fishnet-addon/Runtime/Spatial"
        player = "Packages/com.module.ua-fishnet-addon/Runtime/Player/Module.UB.FishNet.Player.asmdef"
        self.touched += [spatial, player]
        guid_file = self.PROJECT / spatial / "Module.UB.FishNet.TSpatial.asmdef.meta"
        guid = next(ln.split()[1] for ln in guid_file.read_text().splitlines() if ln.startswith("guid:"))
        shutil.rmtree(self.mirror / spatial)
        asmdef = self.mirror / player
        data = json.loads(asmdef.read_text(encoding="utf-8-sig"))
        data["references"] = [r for r in data["references"]
                              if r not in ("Module.UB.FishNet.TSpatial", f"GUID:{guid}")]
        asmdef.write_text(json.dumps(data, indent=4))
        code, text = self.compile("deleted", "--only", "Module.UB.FishNet.Player")
        self.assertNotEqual(0, code, text)
        self.assertIn("FAIL Module.UB.FishNet.Player", text)
        self.assertIn("error CS0246", text)  # a TSpatial type is not found (the log keeps only the first errors)
        self.assertIn("Module.UB.FishNet.TSpatial", text)  # reported as deleted since Unity's last compile

    def test_2_a_deleted_root_script_is_dropped_from_Assembly_CSharp(self):
        self.touched.append("Assets/Scripts/Test_InputSystemComparison.cs")
        (self.mirror / "Assets/Scripts/Test_InputSystemComparison.cs").unlink()
        code, text = self.compile("rootgone", "--only", "Assembly-CSharp")
        self.assertEqual(0, code, text)
        self.assertIn("Assets/Scripts/Test_InputSystemComparison.cs", text)  # reported as source drift


if __name__ == "__main__":
    unittest.main()
