using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using BoneBurst.Data;
using BoneBurst.Editor;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using Object = UnityEngine.Object;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     <see cref="BoneBurstRebakeOnChange" />: an export folder baked before is rebaked, with its previous
    ///     settings and every GUID kept, when its export changes (the BoneBurst editor's Export to Unity writing it
    ///     again); a folder never baked is left alone; a broken export is said, not baked.
    /// </summary>
    /// <remarks>
    ///     The rebake runs after the import (<c>EditorApplication.delayCall</c>), so each test yields frames. Each
    ///     works in its own temporary folder under <c>Assets/</c> and deletes it afterwards.
    /// </remarks>
    public class BoneBurstRebakeOnChangeTests
    {
        private const string Samples =
            "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples/spineboy-pro";

        private readonly List<Object> m_Owned = new();

        private string m_Root, m_Export;

        [SetUp]
        public void SetUp()
        {
            m_Root = $"Assets/BoneBurstRebakeTest_{Guid.NewGuid().ToString("N").Substring(0, 8)}";
            m_Export = $"{m_Root}/spineboy-pro";
            Directory.CreateDirectory(m_Export);
            foreach (string file in new[] { "spineboy-pro.json", "spineboy-pro.atlas.txt", "spineboy-pro.png" })
                File.Copy($"{Samples}/{file}", $"{m_Export}/{file}");

            AssetDatabase.Refresh();
        }

        [TearDown]
        public void TearDown()
        {
            foreach (Object owned in m_Owned) Object.DestroyImmediate(owned);
            m_Owned.Clear();
            AssetDatabase.DeleteAsset(m_Root);
        }

        private string Json => $"{m_Export}/spineboy-pro.json";

        /// <summary>
        ///     The export as the BoneBurst editor writes it again: the same file with another
        ///     <c>skeleton.hash</c>, imported as a refresh would import it.
        /// </summary>
        private void ExportAgain(string hash)
        {
            string text = File.ReadAllText(Json);
            text = Regex.Replace(text, "\"hash\"\\s*:\\s*\"[^\"]*\"", $"\"hash\":\"{hash}\"");
            File.WriteAllText(Json, text);
            AssetDatabase.ImportAsset(Json, ImportAssetOptions.ForceUpdate);
        }

        private string BakeOnce()
        {
            BoneBurstBake.Source source = BoneBurstBake.FindSource(m_Export, out string error);
            Assert.IsNotNull(source, error);
            BoneBurstBakeSettings settings = BoneBurstBake.SettingsFor(source);
            m_Owned.Add(settings);
            BoneBurstBake.Result result = BoneBurstBake.Bake(source, settings);
            Assert.IsTrue(result.Ok, result.Error);
            return settings.OutputFolder;
        }

        private static IEnumerator Frames(int count)
        {
            for (int i = 0; i < count; i++) yield return null;
        }

        [UnityTest]
        public IEnumerator AnExportNeverBaked_IsLeftAlone()
        {
            ExportAgain("never-baked");
            yield return Frames(5);

            Assert.IsFalse(BoneBurstBake.WasBaked(m_Export));
            Assert.IsFalse(AssetDatabase.IsValidFolder($"{m_Root}/spineboy-pro_BoneBurst"),
                "an export nobody baked was baked");
        }

        [UnityTest]
        public IEnumerator ABakedExport_IsRebakedWhenItChanges_KeepingEveryGuid()
        {
            string output = BakeOnce();
            Assert.IsTrue(BoneBurstBake.WasBaked(m_Export));
            string data = $"{output}/spineboy-pro.sbdata.bytes";
            string[] paths = { data, $"{output}/spineboy-pro.png", $"{output}/spineboy-pro_BoneBurst.asset" };
            string[] guids = paths.Select(AssetDatabase.AssetPathToGUID).ToArray();

            LogAssert.Expect(LogType.Log, new Regex("^BoneBurst rebake on change: "));
            ExportAgain("changed-by-the-editor");
            yield return Frames(5);

            Assert.AreEqual("changed-by-the-editor",
                BoneBurstDataReader.Read(File.ReadAllBytes(data)).Skeleton.Hash, "the change was not baked");
            CollectionAssert.AreEqual(guids, paths.Select(AssetDatabase.AssetPathToGUID).ToArray(),
                "a rebake on change changed a GUID");
        }

        [UnityTest]
        public IEnumerator ABrokenExport_IsSaid_NotBaked()
        {
            string output = BakeOnce();
            string data = $"{output}/spineboy-pro.sbdata.bytes";
            byte[] before = File.ReadAllBytes(data);
            // A second .json: the folder no longer holds exactly one export. (Deleting the atlas would do too,
            // but stock spine-unity's own importer, also in this project, logs an error for that.)
            File.WriteAllText($"{m_Export}/notes.json", "{}");
            AssetDatabase.ImportAsset($"{m_Export}/notes.json");

            LogAssert.Expect(LogType.Warning, new Regex("^BoneBurst rebake on change: .*cannot be baked"));
            ExportAgain("half-written");
            yield return Frames(5);

            CollectionAssert.AreEqual(before, File.ReadAllBytes(data), "a broken export was baked");
        }

        [UnityTest]
        public IEnumerator TheBakesOwnOutput_StartsNoBake()
        {
            string output = BakeOnce();
            string data = $"{output}/spineboy-pro.sbdata.bytes";
            byte[] before = File.ReadAllBytes(data);

            AssetDatabase.ImportAsset($"{output}/spineboy-pro.png", ImportAssetOptions.ForceUpdate);
            yield return Frames(5);

            CollectionAssert.AreEqual(before, File.ReadAllBytes(data));
            LogAssert.NoUnexpectedReceived();
        }
    }
}
