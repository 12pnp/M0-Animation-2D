using System;
using System.Collections.Generic;
using System.IO;
using BoneBurst.Editor;
using ModuleP1;
using NUnit.Framework;
using UnityEditor;
using UnityEngine.TestTools;
using Object = UnityEngine.Object;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     What the bake records: AssetSystem references only — the data, one per page, the shader (GUID + type,
    ///     durable ints when the mapping knows the file; in M0 nothing is addressable, so the ints stay -1) — from
    ///     which the blob builds with no AssetManager in the Editor, and a rebake that keeps them.
    /// </summary>
    /// <remarks>
    ///     Like <see cref="BoneBurstBakeTests" />, each test works in its own temporary folder under
    ///     <c>Assets/</c> and deletes it afterwards.
    /// </remarks>
    public class BoneBurstBakePageGuidTests
    {
        private const string Samples =
            "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples/spineboy-pro";

        private readonly List<Object> m_Owned = new();

        private string m_Root, m_Export;

        [SetUp]
        public void SetUp()
        {
            m_Root = $"Assets/BoneBurstBakeGuidTest_{Guid.NewGuid().ToString("N").Substring(0, 8)}";
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

        private BoneBurstBake.Result Bake(out string dataPath)
        {
            BoneBurstBake.Source source = BoneBurstBake.FindSource(m_Export, out string error);
            Assert.IsNotNull(source, error);
            BoneBurstBakeSettings settings = BoneBurstBake.SettingsFor(source);
            m_Owned.Add(settings);
            BoneBurstBake.Result result = BoneBurstBake.Bake(source, settings);
            Assert.IsTrue(result.Ok, result.Error);
            dataPath = $"{settings.OutputFolder}/{settings.Name}.sbdata.bytes";
            return result;
        }

        [Test]
        public void Bake_RecordsReferencesForDataPagesAndShader_WithTheDurableKeyWhenKnown()
        {
            BoneBurstBake.Result result = Bake(out string dataPath);
            BoneBurstAsset asset = result.Asset;

            Assert.AreEqual(1, asset.PageReferences.Length, "one AssetSystem reference per page");
            string pagePath = $"{Path.GetDirectoryName(dataPath)?.Replace('\\', '/')}/spineboy-pro.png";
            Assert.AreEqual(AssetDatabase.AssetPathToGUID(pagePath), asset.PageReferences[0].AssetGuid,
                "the reference names the page texture that was written");
            Assert.AreEqual(AssetTypeCodes.Texture, asset.PageReferences[0].AssetType);
            if (asset.PageReferences[0].IsBaked)
                Assert.AreNotEqual(-1, asset.PageReferences[0].AssetIndex,
                    "a baked key is durable, never the fastlane's ephemeral slot");
            else
                Assert.AreEqual(-1, asset.PageReferences[0].AssetIndex,
                    "M0: nothing is addressable, so the ints stay unbaked");

            Assert.AreEqual(AssetDatabase.AssetPathToGUID(dataPath), asset.DataReference.AssetGuid,
                "the data is a reference to the .sbdata.bytes the bake wrote");
            Assert.AreEqual(AssetTypeCodes.TextAsset, asset.DataReference.AssetType);
            Assert.AreEqual(dataPath, BoneBurstBake.DataPathOf(asset));

            Assert.AreEqual("BoneBurst/Unlit", asset.Shader.name,
                "the shader is a direct reference to the chosen shader asset");

            StringAssert.Contains("shader BoneBurst/Unlit", result.Report);
            StringAssert.Contains("AssetSystem references: data, 1 pages, 0 rim mask(s);", result.Report);
        }

        [Test]
        public void Bake_TheBlobBuildsQuietly_FromReferencesAlone()
        {
            BoneBurstBake.Result result = Bake(out _);

            // Nothing in memory: in the Editor the GUID cache answers every reference with no AssetManager at all,
            // and every page has a reference, so the build does not warn.
            Assert.IsTrue(result.Asset.TryGetBlob(out _));
            LogAssert.NoUnexpectedReceived();
        }

        [Test]
        public void Rebake_KeepsTheReferences()
        {
            BoneBurstBake.Result first = Bake(out string dataPath);
            string pageGuid = first.Asset.PageReferences[0].AssetGuid;
            string dataGuid = first.Asset.DataReference.AssetGuid;

            BoneBurstBake.Source source = BoneBurstBake.FindSource(m_Export, out string error);
            Assert.IsNotNull(source, error);
            BoneBurstBakeSettings settings = BoneBurstBake.SettingsFor(source, dataPath);
            m_Owned.Add(settings);

            BoneBurstBake.Result second = BoneBurstBake.Bake(source, settings);
            Assert.IsTrue(second.Ok, second.Error);
            Assert.AreEqual(pageGuid, second.Asset.PageReferences[0].AssetGuid, "a rebake keeps the page reference");
            Assert.AreEqual(dataGuid, second.Asset.DataReference.AssetGuid, "and the data reference");
        }
    }
}