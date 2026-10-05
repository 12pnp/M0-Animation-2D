#!/usr/bin/env python3
"""Tests for playercompile.py's snapshot, source, ordering and response-file rules.

Temp folders only; nothing here compiles. The real L1 check is playercompile.py itself (`--fishnet`), and its red demo is
recorded in Packages/com.firstgeargames.fishnet/Doc/Bugfix-Plan.md (I0 step 3).
Run: python3 -m unittest discover -s .claude/skills/assembly-tier-check -p 'test_*.py'
"""
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import playercompile  # noqa: E402

DAG = "200b0aP.dag"
UNITY = "/Applications/Unity/Hub/Editor/6000.6.3f1"


def write(path, text=""):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def asmdef(folder, name, **fields):
    return write(folder / f"{name}.asmdef", json.dumps(dict(name=name, **fields)))


class InstallRoot(unittest.TestCase):
    def test_an_editor_and_a_player_path_name_the_same_install(self):
        lines = [f'-r:"{UNITY}/Unity.app/Contents/Managed/UnityEngine/UnityEngine.CoreModule.dll"',
                 f'-r:"{UNITY}/PlaybackEngines/MacStandaloneSupport/Variations/il2cpp/Managed/UnityEngine.dll"',
                 '-r:"Library/Bee/artifacts/200b0aP.dag/GameKit.Dependencies.ref.dll"']
        self.assertEqual(Path(UNITY), playercompile.install_root(lines))

    def test_two_installs_is_not_a_guess(self):
        lines = [f'-r:"{UNITY}/Unity.app/Contents/Managed/UnityEngine.dll"',
                 '-analyzer:"/Applications/Unity/Hub/Editor/6000.6.2f1/Unity.app/Contents/Tools/x.dll"']
        with self.assertRaises(playercompile.Unchecked):
            playercompile.install_root(lines)

    def test_no_install_is_not_a_guess(self):
        with self.assertRaises(playercompile.Unchecked):
            playercompile.install_root(['-r:"Assets/Plugins/x.dll"'])


class BuildRsp(unittest.TestCase):
    LINES = ['-target:library',
             f'-out:"Library/Bee/artifacts/{DAG}/Add.On.dll"',
             f'-refout:"Library/Bee/artifacts/{DAG}/Add.On.ref.dll"',
             '-define:ENABLE_IL2CPP',
             f'-r:"Library/Bee/artifacts/{DAG}/FishNet.Runtime.ref.dll"',
             f'-r:"Library/Bee/artifacts/{DAG}/UniTask.ref.dll"',
             '"Packages/add/A.cs"']

    def test_outputs_go_to_the_run_folder_under_the_same_file_name(self):
        body, _ = playercompile.build_rsp(self.LINES, ["Packages/add/A.cs"], Path("/out"), "Add.On", {}, DAG, {})
        self.assertIn('-out:"/out/Add.On.dll"', body)
        self.assertIn('-refout:"/out/Add.On.ref.dll"', body)

    def test_a_reference_rebuilt_in_this_run_points_at_the_new_output(self):
        body, _ = playercompile.build_rsp(self.LINES, [], Path("/out"), "Add.On",
                                          {"FishNet.Runtime": Path("/out/FishNet.Runtime.ref.dll")}, DAG, {})
        self.assertIn('-r:"/out/FishNet.Runtime.ref.dll"', body)
        self.assertIn(f'-r:"Library/Bee/artifacts/{DAG}/UniTask.ref.dll"', body)

    def test_sources_come_from_the_given_list_and_an_override_replaces_one(self):
        body, unused = playercompile.build_rsp(self.LINES, ["Packages/add/A.cs", "Packages/add/B.cs"], Path("/out"),
                                               "Add.On", {}, DAG, {"Packages/add/B.cs": "/scratch/B.cs",
                                                                   "Packages/add/C.cs": "/scratch/C.cs"})
        self.assertEqual(['"Packages/add/A.cs"', '"/scratch/B.cs"'], [l for l in body if l.endswith('.cs"')])
        self.assertEqual(["Packages/add/C.cs"], unused)


class DependencyOrder(unittest.TestCase):
    def test_each_assembly_comes_after_the_named_ones_it_references(self):
        order = playercompile.dependency_order(
            ["Add.On", "FishNet.Runtime", "GameKit"],
            {"Add.On": ["FishNet.Runtime", "UniTask"], "FishNet.Runtime": ["GameKit"], "GameKit": []})
        self.assertEqual(["GameKit", "FishNet.Runtime", "Add.On"], order)

    def test_a_cycle_is_not_ordered(self):
        with self.assertRaises(playercompile.Unchecked):
            playercompile.dependency_order(["A", "B"], {"A": ["B"], "B": ["A"]})


class Sources(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.asmdef = asmdef(self.root / "Packages/p/Runtime", "P.Runtime")
        write(self.root / "Packages/p/Runtime/A.cs")
        write(self.root / "Packages/p/Runtime/Sub/B.cs")
        asmdef(self.root / "Packages/p/Runtime/Nested", "P.Nested")
        write(self.root / "Packages/p/Runtime/Nested/N.cs")
        write(self.root / "Packages/p/Runtime/Samples~/S.cs")

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_nested_assembly_and_a_tilde_folder_are_not_this_assemblys_sources(self):
        playercompile.check_sources(self.root, "P.Runtime",
                                    ["Packages/p/Runtime/A.cs", "Packages/p/Runtime/Sub/B.cs"], self.asmdef)

    def test_a_file_the_editor_has_not_compiled_yet_is_unchecked(self):
        with self.assertRaises(playercompile.Unchecked):
            playercompile.check_sources(self.root, "P.Runtime", ["Packages/p/Runtime/A.cs"], self.asmdef)

    def test_a_listed_file_that_is_gone_is_unchecked(self):
        with self.assertRaises(playercompile.Unchecked):
            playercompile.check_sources(self.root, "P.Runtime", ["Packages/p/Runtime/A.cs",
                                                                 "Packages/p/Runtime/Sub/B.cs",
                                                                 "Packages/p/Runtime/Gone.cs"], self.asmdef)


class Snapshot(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_snapshot_is_the_dags_last_compile(self):
        dag = self.root / "Library/Bee/artifacts" / DAG
        dag.mkdir(parents=True)
        inputdata = write(self.root / "Library/Bee/200b0aP-inputdata.json", "{}")
        os.utime(inputdata, (1000, 1000))
        self.assertEqual(1000, playercompile.snapshot_time(self.root, dag))

    def test_the_newest_player_dag_is_the_snapshot_and_a_test_players_dag_is_never_picked(self):
        for name, stamp in (("200b0aP", 1000), ("200000P", 3000), ("200b0aPDevChkIns", 5000)):
            (self.root / "Library/Bee/artifacts" / f"{name}.dag").mkdir(parents=True)
            os.utime(write(self.root / f"Library/Bee/{name}-inputdata.json", "{}"), (stamp, stamp))
        self.assertEqual("200000P.dag", playercompile.find_dag(self.root, "player").name)

    def test_no_compile_is_unchecked(self):
        dag = self.root / "Library/Bee/artifacts" / DAG
        dag.mkdir(parents=True)
        with self.assertRaises(playercompile.Unchecked):
            playercompile.snapshot_time(self.root, dag)

    def test_an_asmdef_written_after_the_snapshot_is_reported(self):
        mine = asmdef(self.root / "Packages/p", "Add.On")
        theirs = asmdef(self.root / "Packages/f", "FishNet.Runtime")
        os.utime(mine, (1000, 1000))
        os.utime(theirs, (3000, 3000))
        lines = [f'-r:"Library/Bee/artifacts/{DAG}/FishNet.Runtime.ref.dll"']
        index = {"Add.On": mine, "FishNet.Runtime": theirs}
        self.assertEqual([theirs], playercompile.stale_asmdefs("Add.On", lines, DAG, index, 2000))
        self.assertEqual([], playercompile.stale_asmdefs("Add.On", lines, DAG, index, time.time()))


class RuntimeAssemblies(unittest.TestCase):
    def test_editor_only_and_test_assemblies_are_not_player_assemblies(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            asmdef(root / "Packages/p/Runtime", "P.Runtime")
            asmdef(root / "Packages/p/Editor", "P.Editor", includePlatforms=["Editor"])
            asmdef(root / "Packages/p/Tests", "P.Tests", defineConstraints=["UNITY_INCLUDE_TESTS"])
            asmdef(root / "Packages/p/Mppm", "P.Mppm", defineConstraints=["UNITY_EDITOR"])
            asmdef(root / "Packages/q/Runtime", "Q.Runtime")
            index = playercompile.asmdef_index(root)
            self.assertEqual(["P.Runtime"], playercompile.runtime_assemblies(root, ["Packages/p"], index))


if __name__ == "__main__":
    unittest.main()
