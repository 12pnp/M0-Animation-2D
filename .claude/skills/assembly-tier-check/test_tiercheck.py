#!/usr/bin/env python3
"""Tests for tiercheck.py checks E-H (package placement, package edges, FishNet below U, UI homes).

Each test builds a tiny Assets/ + Packages/ tree in a temp folder, so nothing here reads the project.
Run: python3 -m unittest discover -s .claude/skills/assembly-tier-check -p 'test_*.py'
"""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tiercheck  # noqa: E402


class Tree:
    """A throwaway Assets/ + Packages/ tree with packages and asmdefs."""

    def __init__(self, root):
        self.root = Path(root)
        self._guid = 0
        (self.root / "Assets").mkdir(parents=True, exist_ok=True)
        (self.root / "Packages").mkdir(parents=True, exist_ok=True)

    def package(self, folder, display_name):
        path = self.root / "Packages" / folder / "package.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"name": folder, "displayName": display_name}))

    def asmdef(self, folder, name, refs=(), editor=False):
        """folder is relative to the tree root, e.g. 'Packages/com.module.pc-creator-ui/Runtime'."""
        path = self.root / folder / f"{name}.asmdef"
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {"name": name, "references": list(refs)}
        if editor:
            data["includePlatforms"] = ["Editor"]
        path.write_text(json.dumps(data))
        self._guid += 1
        guid = f"{self._guid:032x}"
        Path(f"{path}.meta").write_text(f"fileFormatVersion: 2\nguid: {guid}\n")
        return guid

    @property
    def roots(self):
        return [self.root / "Assets", self.root / "Packages"]


def standard_tree(root):
    """Today's shape in miniature: a PC assembly in a PB package (legal band placement), TA assemblies in a PC
    package (cross-tier), a PC -> TA package edge, a TC test referencing FishNet, and UI assemblies in and out of
    their homes."""
    t = Tree(root)
    t.package("com.module.pb-creator-base", "PB Creator Base")
    t.package("com.module.pc-creator-ui", "PC Creator UI")
    t.package("com.module.ta-creator-core", "TA Creator Core")
    t.package("com.module.tc-creator-rpg", "TC Creator RPG")
    t.package("com.module.ua-fishnet-addon", "UA FishNet AddOn")
    t.package("com.firstgeargames.fishnet", "TZ FishNet")
    t.asmdef("Packages/com.module.pb-creator-base/Runtime/Input", "Module.PB.InputSystem")
    t.asmdef("Packages/com.module.pb-creator-base/Runtime/Input/UI/Core", "Module.PC.UI", ["Module.PB.InputSystem"])
    t.asmdef("Packages/com.module.ta-creator-core/Runtime/Core", "Module.TA.Core", ["Module.PC.UI"])
    t.asmdef("Packages/com.module.pc-creator-ui/Runtime/UnityUI", "Module.TA.UI", ["Module.PC.UI", "Module.TA.Core"])
    t.asmdef("Packages/com.module.pc-creator-ui/Runtime/HeatUI/Elements", "Module.PC.UnityUI.Elements", ["Module.PC.UI"])
    fishnet_guid = t.asmdef("Packages/com.firstgeargames.fishnet/Runtime", "FishNet.Runtime")
    t.asmdef("Packages/com.module.tc-creator-rpg/Runtime/Inventory", "Module.TC.Inventory", ["Module.PC.UI"])
    t.asmdef("Packages/com.module.tc-creator-rpg/Runtime/Inventory/UI", "Module.TC.Inventory.UI",
             ["Module.TC.Inventory", "Module.TA.UI"])
    t.asmdef("Packages/com.module.tc-creator-rpg/Runtime/Inventory/VScript", "Module.TC.Inventory.VScript",
             ["Module.TC.Inventory", "Module.PC.UI"])
    t.asmdef("Packages/com.module.tc-creator-rpg/Tests/Runtime/Inventory", "Module.TC.Inventory.Tests",
             ["Module.TC.Inventory", f"GUID:{fishnet_guid}"])
    t.asmdef("Packages/com.module.ua-fishnet-addon/Runtime/Features/Inventory", "Module.UA.Inventory.Network",
             ["Module.TC.Inventory", "FishNet.Runtime"])
    t.asmdef("Packages/com.module.ua-fishnet-addon/Runtime/CoOpHud", "Module.UB.CoOpHud", ["Module.PC.UI"])
    t.asmdef("Assets/_Res/Example", "Module.UZ.Creator.Example", ["Module.PC.UI"])
    return t


class PackagePlacement(unittest.TestCase):
    """Check E: an assembly whose tier letter is above its package's tier letter."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.report = tiercheck.analyze(standard_tree(self.tmp.name).roots)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_T_assembly_in_a_P_package_is_flagged(self):
        flagged = {(e["asm"], e["package"]) for e in self.report["placement"]}
        self.assertIn(("Module.TA.UI", "com.module.pc-creator-ui"), flagged)

    def test_a_higher_band_in_the_same_tier_is_legal_but_listed(self):
        flagged = {e["asm"] for e in self.report["placement"]}
        self.assertNotIn("Module.PC.UI", flagged)
        self.assertIn("Module.PC.UI", {e["asm"] for e in self.report["band_placement"]})

    def test_vendor_packages_and_Assets_are_not_placements(self):
        every = {e["asm"] for e in self.report["placement"] + self.report["band_placement"]}
        self.assertNotIn("FishNet.Runtime", every)
        self.assertNotIn("Module.UZ.Creator.Example", every)

    def test_only_the_cross_tier_assembly_is_flagged(self):
        self.assertEqual(["Module.TA.UI"], [e["asm"] for e in self.report["placement"]])


class PackageEdges(unittest.TestCase):
    """Check F: an asmdef edge from one com.module package into a package with a higher tier letter."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.report = tiercheck.analyze(standard_tree(self.tmp.name).roots)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_P_package_referencing_a_T_package_is_flagged_with_its_edges(self):
        edges = self.report["package_edges"]
        self.assertIn(("com.module.pc-creator-ui", "com.module.ta-creator-core"), edges)
        self.assertEqual([("Module.TA.UI", "Module.TA.Core")],
                         edges[("com.module.pc-creator-ui", "com.module.ta-creator-core")])

    def test_downward_and_same_package_edges_are_not_flagged(self):
        edges = self.report["package_edges"]
        self.assertNotIn(("com.module.ta-creator-core", "com.module.pb-creator-base"), edges)
        self.assertNotIn(("com.module.tc-creator-rpg", "com.module.tc-creator-rpg"), edges)
        self.assertEqual(1, len(edges))


class FishNetBelowU(unittest.TestCase):
    """Check G: a Module.P* or Module.T* assembly referencing FishNet."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.report = tiercheck.analyze(standard_tree(self.tmp.name).roots)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_TC_assembly_referencing_FishNet_by_GUID_is_flagged(self):
        self.assertIn(("Module.TC.Inventory.Tests", "FishNet.Runtime"),
                      {(e["src"], e["dst"]) for e in self.report["fishnet"]})

    def test_a_U_assembly_may_reference_FishNet(self):
        self.assertNotIn("Module.UA.Inventory.Network", {e["src"] for e in self.report["fishnet"]})
        self.assertEqual(1, len(self.report["fishnet"]))


class UiHomes(unittest.TestCase):
    """Check H: UI lives in Module.PC.UI(.Editor/.Tests), a <Feature>.VScript, or Module.UB.CoOp.UI."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tree = standard_tree(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_ui_assemblies_outside_the_homes_are_flagged(self):
        report = tiercheck.analyze(self.tree.roots)
        self.assertEqual(["Module.PC.UnityUI.Elements", "Module.TA.UI", "Module.TC.Inventory.UI", "Module.UB.CoOpHud"],
                         report["ui_strays"])

    def test_the_homes_are_not_flagged(self):
        pkg = "Packages/com.module.pc-creator-ui"
        self.tree.asmdef(f"{pkg}/Editor", "Module.PC.UI.Editor", ["Module.PC.UI"], editor=True)
        self.tree.asmdef(f"{pkg}/Tests/Runtime", "Module.PC.UI.Tests", ["Module.PC.UI"])
        self.tree.asmdef("Packages/com.module.ua-fishnet-addon/Runtime/CoOp", "Module.UB.CoOp.UI", ["Module.PC.UI"])
        strays = tiercheck.analyze(self.tree.roots)["ui_strays"]
        for home in ("Module.PC.UI", "Module.PC.UI.Editor", "Module.PC.UI.Tests", "Module.UB.CoOp.UI",
                     "Module.TC.Inventory.VScript"):
            self.assertNotIn(home, strays)

    def test_names_that_merely_contain_UI_letters_are_not_UI(self):
        self.tree.asmdef("Packages/com.module.ta-creator-core/Runtime/Build", "Module.TA.Build.GUIDs")
        self.tree.asmdef("Packages/com.module.ta-creator-core/Runtime/Kit", "Module.TA.UIKit")
        strays = tiercheck.analyze(self.tree.roots)["ui_strays"]
        self.assertNotIn("Module.TA.Build.GUIDs", strays)
        self.assertNotIn("Module.TA.UIKit", strays)

    def test_editor_assemblies_with_a_UI_suffix_segment_are_flagged(self):
        self.tree.asmdef("Packages/com.module.pc-creator-ui/Editor/UnityUI", "Module.TA.Editor.CoreUI",
                         ["Module.TA.UI"], editor=True)
        self.assertIn("Module.TA.Editor.CoreUI", tiercheck.analyze(self.tree.roots)["ui_strays"])


class Gate(unittest.TestCase):
    """The new checks gate like B and C: today's cases go in the baseline, a new one fails."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tree = standard_tree(self.tmp.name)
        self.baseline = Path(self.tmp.name) / "baseline.json"

    def tearDown(self):
        self.tmp.cleanup()

    def run_gate(self, *extra):
        argv = ["--roots", *map(str, self.tree.roots), "--baseline", str(self.baseline), *extra]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = tiercheck.main(argv)
        return code, out.getvalue()

    def test_unbaselined_cases_fail_and_name_every_check(self):
        code, text = self.run_gate()
        self.assertEqual(1, code, text)
        for word in ("package placement", "package edge", "FishNet", "UI home"):
            self.assertIn(word, text)

    def test_baselined_cases_pass_and_a_new_one_fails(self):
        self.assertEqual(0, self.run_gate("--update-baseline")[0])
        base = json.loads(self.baseline.read_text())
        self.assertEqual([["Module.TA.UI", "com.module.pc-creator-ui"]], base["tier_placement"])
        self.assertEqual([["com.module.pc-creator-ui", "com.module.ta-creator-core"]], base["package_edges"])
        self.assertEqual([["Module.TC.Inventory.Tests", "FishNet.Runtime"]], base["fishnet_below_u"])
        self.assertIn("Module.TC.Inventory.UI", base["ui_homes"])

        code, text = self.run_gate()
        self.assertEqual(0, code, text)

        self.tree.asmdef("Packages/com.module.tc-creator-rpg/Runtime/Stats/UI", "Module.TC.Stats.UI", ["Module.PC.UI"])
        code, text = self.run_gate()
        self.assertEqual(1, code, text)
        self.assertIn("Module.TC.Stats.UI", text)

    def test_paying_debt_down_never_fails(self):
        self.assertEqual(0, self.run_gate("--update-baseline")[0])
        (self.tree.root / "Packages/com.module.tc-creator-rpg/Runtime/Inventory/UI/Module.TC.Inventory.UI.asmdef").unlink()
        code, text = self.run_gate()
        self.assertEqual(0, code, text)


if __name__ == "__main__":
    unittest.main()
