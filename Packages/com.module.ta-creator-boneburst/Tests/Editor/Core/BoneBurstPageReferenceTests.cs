using System;
using System.IO;
using BoneBurst.Blob;
using BoneBurst.Data;
using Cysharp.Threading.Tasks;
using ModuleP1;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using Object = UnityEngine.Object;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     <see cref="BoneBurstAsset" /> on AssetSystem references: data, pages and shader resolve through the
    ///     editor's GUID cache when no loader exists; a page delivery through <see cref="BoneBurstAsset.PageLoaded" />
    ///     patches already-cached materials, duplicates are ignored, and <see cref="BoneBurstAsset.Free" /> forgets
    ///     it; data that is not in hand makes <see cref="BoneBurstAsset.Blob" /> ask for
    ///     <see cref="BoneBurstAsset.PrepareAsync" />; a page without a reference — or a reference nothing resolves
    ///     — warns and renders untextured.
    /// </summary>
    public class BoneBurstPageReferenceTests
    {
        private const string Samples =
            "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples";

        // Files the AssetDatabase knows: Data~ files are file-IO only, with no GUID to resolve.
        private const string PagePath = "Assets/BoneBurstDemo/mix-and-match-pro_BoneBurst/mix-and-match-pro.png";

        private const string DataPath =
            "Assets/BoneBurstDemo/mix-and-match-pro_BoneBurst/mix-and-match-pro.sbdata.bytes";

        private const string Lit2DPath = "Packages/com.module.ta-creator-boneburst/Shaders/BoneBurst-Lit2D.shader";

        private BoneBurstAsset m_Asset;
        private Texture2D[] m_Textures;

        [SetUp]
        public void SetUp()
        {
            string atlasText = File.ReadAllText($"{Samples}/spineboy-pro/spineboy-pro.atlas.txt");
            SkeletonDef skeleton =
                SkeletonJsonReader.Read(File.ReadAllText($"{Samples}/spineboy-pro/spineboy-pro.json"), 0.01f);
            m_Asset = ScriptableObject.CreateInstance<BoneBurstAsset>();
            m_Asset.name = "pages";
            m_Asset.SetDataBytes(
                BoneBurstDataWriter.Write(skeleton, AtlasReader.Read(atlasText), 0.01f));
            m_Textures = new[] { new Texture2D(2, 2), new Texture2D(2, 2) };
        }

        [TearDown]
        public void TearDown()
        {
            if (m_Asset != null) Object.DestroyImmediate(m_Asset);
            foreach (Texture2D texture in m_Textures) Object.DestroyImmediate(texture);
        }

        private static IndexGenericAsset Reference(string guid, short assetType = AssetTypeCodes.Texture)
        {
            return new IndexGenericAsset(guid, -1, -1, assetType, -1);
        }

        /// <summary>
        ///     An asset with references only, no in-memory content: what a bake writes.
        /// </summary>
        private static BoneBurstAsset ReferencedAsset(string dataGuid)
        {
            BoneBurstAsset asset = ScriptableObject.CreateInstance<BoneBurstAsset>();
            asset.name = "referenced";
            asset.SetData(Reference(dataGuid, AssetTypeCodes.TextAsset));
            asset.SetPages(new[] { Reference(AssetDatabase.AssetPathToGUID(PagePath)) });
            return asset;
        }

        [Test]
        public void DataReference_BuildsTheBlobThroughTheEditorCache_WithoutALoader()
        {
            BoneBurstAsset asset = ReferencedAsset(AssetDatabase.AssetPathToGUID(DataPath));
            try
            {
                Assert.IsTrue(asset.TryGetBlob(out _), "the editor's GUID cache answers the data reference");
                Assert.IsTrue(asset.IsReady);
                Assert.IsTrue(asset.PrepareAsync().Status == UniTaskStatus.Succeeded,
                    "a built blob needs no preparing");
            }
            finally
            {
                Object.DestroyImmediate(asset);
            }
        }

        [Test]
        public void DataNotInHand_TryGetBlobIsFalse_AndBlobAsksForPrepareAsync()
        {
            BoneBurstAsset asset = ReferencedAsset("nothing-resolves-this");
            try
            {
                Assert.IsFalse(asset.TryGetBlob(out SkeletonBlob _));
                InvalidOperationException e = Assert.Throws<InvalidOperationException>(() => _ = asset.Blob);
                StringAssert.Contains("await PrepareAsync() first", e.Message);
            }
            finally
            {
                Object.DestroyImmediate(asset);
            }
        }

        [Test]
        public void PrepareAsync_WithoutALoader_FailsLoudly_AndRetriesOnTheNextCall()
        {
            BoneBurstAsset asset = ReferencedAsset("nothing-resolves-this");
            try
            {
                InvalidOperationException e =
                    Assert.Throws<InvalidOperationException>(() => asset.PrepareAsync().GetAwaiter().GetResult());
                // AssetRuntime (V2) refuses an un-indexed reference before any load: the failure names why.
                StringAssert.Contains("the AssetRuntime loads only indexed references", e.Message);
                Assert.Throws<InvalidOperationException>(() => asset.PrepareAsync().GetAwaiter().GetResult(),
                    "a failed load is not cached: the next call tries again");
            }
            finally
            {
                Object.DestroyImmediate(asset);
            }
        }

        [Test]
        public void NoData_SaysAssign()
        {
            BoneBurstAsset asset = ScriptableObject.CreateInstance<BoneBurstAsset>();
            try
            {
                Assert.IsFalse(asset.HasData);
                InvalidOperationException e = Assert.Throws<InvalidOperationException>(() => _ = asset.Blob);
                StringAssert.Contains("assign the baked skeleton data", e.Message);
            }
            finally
            {
                Object.DestroyImmediate(asset);
            }
        }

        [Test]
        public void Shader_EmptyMeansUnlit_ASetShaderIsUsed()
        {
            m_Asset.SetPages(new[] { Reference(AssetDatabase.AssetPathToGUID(PagePath)) });
            Assert.AreEqual("BoneBurst/Unlit", m_Asset.MaterialFor(0, (BlendMode)0).shader.name,
                "no shader renders with BoneBurst/Unlit");

            m_Asset.Free();
            m_Asset.SetShader(AssetDatabase.LoadAssetAtPath<Shader>(Lit2DPath));
            Assert.AreEqual("BoneBurst/Lit2D", m_Asset.MaterialFor(0, (BlendMode)0).shader.name,
                "the asset's own shader");
        }

        [Test]
        public void Free_ForgetsDeliveredPages()
        {
            m_Asset.SetPages(new[] { Reference("nothing-resolves-this") });
            _ = m_Asset.Blob;
            m_Asset.PageLoaded(0, m_Textures[0]);
            Assert.AreSame(m_Textures[0], m_Asset.MaterialFor(0, (BlendMode)0).mainTexture);

            m_Asset.Free();
            _ = m_Asset.Blob;
            LogAssert.ignoreFailingMessages = true; // the no-loader warning
            Assert.IsNull(m_Asset.MaterialFor(0, (BlendMode)0).mainTexture,
                "a freed asset no longer holds the page: its handle was released");
            LogAssert.ignoreFailingMessages = false;
        }

        [Test]
        public void MaterialFor_ResolvesAReferenceThroughTheEditorCache_WithoutALoader()
        {
            m_Asset.SetPages(new[] { Reference(AssetDatabase.AssetPathToGUID(PagePath)) });
            _ = m_Asset.Blob;

            Material material = m_Asset.MaterialFor(0, (BlendMode)0);

            Texture2D expected = AssetDatabase.LoadAssetAtPath<Texture2D>(PagePath);
            Assert.AreSame(expected, material.mainTexture,
                "no AssetRuntime runs, and the editor answers the reference by its GUID");
        }

        [Test]
        public void PageLoaded_PatchesAlreadyCachedMaterials_AndServesLaterOnes()
        {
            m_Asset.SetPages(new[] { Reference("nothing-resolves-this") });
            _ = m_Asset.Blob;
            Material material = m_Asset.MaterialFor(0, (BlendMode)0);
            Assert.IsNull(material.mainTexture, "nothing resolves, so the material starts untextured");

            m_Asset.PageLoaded(0, m_Textures[0]);

            Assert.AreSame(m_Textures[0], material.mainTexture, "the delivery patches the cached material");
            Assert.AreSame(m_Textures[0], m_Asset.MaterialFor(0, (BlendMode)1).mainTexture,
                "a material built after the delivery takes it from the cache");

            m_Asset.PageLoaded(0, m_Textures[1]);
            Assert.AreSame(m_Textures[0], material.mainTexture, "a late duplicate delivery is ignored");
        }

        [Test]
        public void PageLoaded_OutOfRangeOrEmpty_IsIgnored()
        {
            m_Asset.SetPages(new[] { Reference("nothing-resolves-this") });
            _ = m_Asset.Blob;
            Assert.DoesNotThrow(() => m_Asset.PageLoaded(5, m_Textures[0]));
            Assert.DoesNotThrow(() => m_Asset.PageLoaded(0, null));
        }

        [Test]
        public void UnresolvableReference_WarnsOnce_AndRendersUntextured()
        {
            m_Asset.SetPages(new[] { Reference("nothing-resolves-this") });
            _ = m_Asset.Blob;

            LogAssert.Expect(LogType.Warning,
                "pages: page 0 is an AssetSystem reference, but no AssetRuntime runs; it renders untextured.");
            Material material = m_Asset.MaterialFor(0, (BlendMode)0);
            LogAssert.NoUnexpectedReceived();
            Assert.IsNull(material.mainTexture);
        }

        [Test]
        public void PageWithoutAReference_WarnsAtTheBlobBuild()
        {
            LogAssert.Expect(LogType.Error,
                "pages: 1 of the atlas's 1 pages have no AssetSystem reference; they render untextured.");
            _ = m_Asset.Blob;
            LogAssert.NoUnexpectedReceived();
        }

        [Test]
        public void Free_DisposesThePageHandles_WithoutThrowing()
        {
            // M0 has no loader, so the handles stay default (null) — the release path's real exercise is a
            // project with the AssetSystem; here we prove the teardown is safe and repeatable.
            m_Asset.SetPages(new[] { Reference(AssetDatabase.AssetPathToGUID(PagePath)) });
            _ = m_Asset.Blob;
            _ = m_Asset.MaterialFor(0, (BlendMode)0);

            Assert.DoesNotThrow(() => m_Asset.Free());
            Assert.DoesNotThrow(() => m_Asset.Free(), "freeing twice is safe (the handles dispose idempotently)");
        }
    }
}