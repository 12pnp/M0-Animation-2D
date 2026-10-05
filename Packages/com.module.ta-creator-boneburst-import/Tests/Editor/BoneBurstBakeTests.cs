using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using BoneBurst.Blob;
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
    ///     <see cref="BoneBurstBake" /> on a real export folder: what it finds and refuses, the three outputs and
    ///     their settings, a rebake that keeps GUIDs and settings, and every way it must write nothing.
    /// </summary>
    /// <remarks>
    ///     Each test works in its own temporary folder under <c>Assets/</c> (the bake only writes inside Assets) and
    ///     deletes it afterwards; that folder is the test's own, never an output path of the bake.
    /// </remarks>
    public class BoneBurstBakeTests
    {
        private const string Samples =
            "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples/spineboy-pro";

        private static readonly string[] Dropped =
            { "MeshDef.Edges", "SkeletonDef.ImagesPath", "SkeletonDef.AudioPath" };

        private readonly List<Object> m_Owned = new();

        private string m_Root, m_Export;

        [SetUp]
        public void SetUp()
        {
            m_Root = $"Assets/BoneBurstBakeTest_{Guid.NewGuid().ToString("N").Substring(0, 8)}";
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

        private BoneBurstBake.Source Export()
        {
            BoneBurstBake.Source source = BoneBurstBake.FindSource(m_Export, out string error);
            Assert.IsNotNull(source, error);
            return source;
        }

        private BoneBurstBakeSettings Settings(BoneBurstBake.Source source)
        {
            BoneBurstBakeSettings settings = BoneBurstBake.SettingsFor(source);
            m_Owned.Add(settings);
            return settings;
        }

        private static string[] FilesIn(string folder)
        {
            return Directory.GetFiles(folder).OrderBy(f => f).ToArray();
        }

        [Test]
        public void FindSource_AcceptsAnExport_RefusesAnythingElse()
        {
            BoneBurstBake.Source source = Export();
            Assert.AreEqual(1, source.Pages.Length);
            Assert.AreEqual("spineboy-pro", source.BaseName);

            string missingPage = $"{m_Root}/no-page";
            Directory.CreateDirectory(missingPage);
            File.Copy($"{Samples}/spineboy-pro.json", $"{missingPage}/spineboy-pro.json");
            File.Copy($"{Samples}/spineboy-pro.atlas.txt", $"{missingPage}/spineboy-pro.atlas.txt");
            // spine-unity's own importer reacts to the export too, and complains about the texture that is missing on purpose.
            LogAssert.Expect(LogType.Error, new Regex("^Material is missing texture: spineboy-pro_Material"));
            AssetDatabase.Refresh();
            Assert.IsNull(BoneBurstBake.FindSource(missingPage, out string error));
            StringAssert.Contains("missing the atlas page", error);

            File.Copy($"{Samples}/spineboy-pro.json", $"{m_Export}/second.json");
            AssetDatabase.Refresh();
            Assert.IsNull(BoneBurstBake.FindSource(m_Export, out error));
            StringAssert.Contains("exactly one", error);

            Assert.IsNull(BoneBurstBake.FindSource($"{m_Root}/nothing-here", out error));

            // Every problem at once, in one message: two .json files, no atlas. Not Spine exports: spine-unity's
            // importer opens a modal "AtlasAsset for ..." dialog for a Spine JSON without an atlas, which blocks the
            // run (it hung the full suite on 2026-10-01). FindSource only counts the files.
            string twoProblems = $"{m_Root}/two-problems";
            Directory.CreateDirectory(twoProblems);
            File.WriteAllText($"{twoProblems}/a.json", "{}");
            File.WriteAllText($"{twoProblems}/b.json", "{}");
            AssetDatabase.Refresh();
            Assert.IsNull(BoneBurstBake.FindSource(twoProblems, out error));
            StringAssert.Contains("2 .json and 0 .skel.bytes files", error);
            StringAssert.Contains("0 .atlas.txt files", error);
        }

        [Test]
        public void Bake_WritesDataTextureAndAsset_AndLeavesTheExportAlone()
        {
            BoneBurstBake.Source source = Export();
            BoneBurstBakeSettings settings = Settings(source);
            Assert.AreEqual("spineboy-pro", settings.Name);
            Assert.AreEqual($"{m_Root}/spineboy-pro_BoneBurst", settings.OutputFolder);
            string[] exportBefore = FilesIn(m_Export);

            BoneBurstBake.Result result = BoneBurstBake.Bake(source, settings);
            Assert.IsTrue(result.Ok, result.Error);
            Debug.Log(result.Report);

            string output = settings.OutputFolder;
            CollectionAssert.AreEquivalent(
                new[] { "spineboy-pro.sbdata.bytes", "spineboy-pro.png", "spineboy-pro_BoneBurst.asset" },
                Directory.GetFiles(output).Where(f => !f.EndsWith(".meta")).Select(Path.GetFileName));
            CollectionAssert.AreEqual(exportBefore, FilesIn(m_Export), "the export folder was changed");

            // The data is exactly the export, read at the bake's scale.
            BoneBurstAsset asset = result.Asset;
            Assert.AreEqual($"{output}/spineboy-pro_BoneBurst.asset", AssetDatabase.GetAssetPath(asset));
            Assert.AreEqual($"{output}/spineboy-pro.sbdata.bytes", BoneBurstBake.DataPathOf(asset));
            BoneBurstData data = BoneBurstDataReader.Read(File.ReadAllBytes(BoneBurstBake.DataPathOf(asset)));
            Assert.AreEqual(0.01f, data.Scale);
            DeepComparer model = new(Dropped);
            model.Compare("skeleton", SkeletonJsonReader.Read(File.ReadAllText($"{m_Export}/spineboy-pro.json"), 0.01f),
                data.Skeleton);
            Assert.IsEmpty(model.Failures, string.Join("\n", model.Failures.Take(20)));
            Assert.AreEqual(131, asset.Keys.Entries.Count);

            // The page is the copy, imported for runtime use.
            Assert.AreEqual(1, asset.PageReferences.Length);
            Assert.AreEqual($"{output}/spineboy-pro.png",
                AssetDatabase.GUIDToAssetPath(asset.PageReferences[0].AssetGuid));
            TextureImporter texture = (TextureImporter)AssetImporter.GetAtPath($"{output}/spineboy-pro.png");
            Assert.IsFalse(texture.mipmapEnabled);
            Assert.IsFalse(texture.isReadable);
            Assert.AreEqual(TextureImporterCompression.Compressed, texture.textureCompression);
            Assert.AreEqual(2048, texture.maxTextureSize, "auto size: the 2048 × 1024 page, rounded up");

            Assert.AreEqual("BoneBurst/Unlit", asset.Shader.name);
            Assert.AreEqual(0.2f, asset.DefaultMix);
        }

        /// <summary>
        ///     An export folder with a binary export only (M2's <c>mix-and-match-pro.skel.bytes</c> and its
        ///     <c>holding-items</c> atlas), the page a stand-in PNG under the atlas's page name.
        /// </summary>
        private string BinaryExport()
        {
            const string m2 = "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/m2-mix-and-match";
            string folder = $"{m_Root}/m2-mix-and-match";
            Directory.CreateDirectory(folder);
            File.Copy($"{m2}/mix-and-match-pro.skel.bytes", $"{folder}/mix-and-match-pro.skel.bytes");
            File.Copy($"{m2}/holding-items.atlas.txt", $"{folder}/holding-items.atlas.txt");
            AtlasDef atlas = AtlasReader.Read(File.ReadAllText($"{m2}/holding-items.atlas.txt"));
            Texture2D page = new(4, 4);
            m_Owned.Add(page);
            foreach (AtlasPageDef def in atlas.Pages) File.WriteAllBytes($"{folder}/{def.Name}", page.EncodeToPNG());
            AssetDatabase.Refresh();
            return folder;
        }

        [Test]
        public void Bake_FromABinaryExport_BakesWhatTheBinaryReaderReads()
        {
            string folder = BinaryExport();
            BoneBurstBake.Source source = BoneBurstBake.FindSource(folder, out string error);
            Assert.IsNotNull(source, error);
            Assert.IsTrue(source.IsBinary);
            Assert.AreEqual("mix-and-match-pro", source.BaseName, "the name drops the whole .skel.bytes");

            BoneBurstBakeSettings settings = Settings(source);
            BoneBurstBake.Result result = BoneBurstBake.Bake(source, settings);
            Assert.IsTrue(result.Ok, result.Error);
            StringAssert.Contains("(skel + atlas)", result.Report);

            SkeletonDef expected =
                SkeletonBinaryReader.Read(File.ReadAllBytes($"{folder}/mix-and-match-pro.skel.bytes"), settings.Scale);
            BoneBurstData data = BoneBurstDataReader.Read(File.ReadAllBytes(BoneBurstBake.DataPathOf(result.Asset)));
            DeepComparer model = new(Dropped);
            model.Compare("skeleton", expected, data.Skeleton);
            Assert.Greater(model.Checks, 1000, "too few comparisons to mean anything");
            Assert.IsEmpty(model.Failures, string.Join("\n", model.Failures.Take(20)));
            Assert.AreEqual(BoneBurstKeyTable.BuildEntries(expected).Length, result.Asset.Keys.Entries.Count);
            Assert.IsTrue(result.Asset.TryGetBlob(out _), "the baked asset builds its blob from its references");
        }

        [Test]
        public void FindSource_WithJsonAndItsBinaryTwin_TakesTheJson()
        {
            File.Copy(
                "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/m2-mix-and-match/mix-and-match-pro.skel.bytes",
                $"{m_Export}/spineboy-pro.skel.bytes");
            AssetDatabase.Refresh();

            BoneBurstBake.Source source = Export();

            Assert.IsFalse(source.IsBinary);
            StringAssert.EndsWith("spineboy-pro.json", source.Export);
        }

        [Test]
        public void Rebake_KeepsEveryGuid_AndRemembersTheSettings()
        {
            BoneBurstBake.Source source = Export();
            BoneBurstBakeSettings settings = Settings(source);
            Assert.IsTrue(BoneBurstBake.Bake(source, settings).Ok);
            string output = settings.OutputFolder;
            string[] paths =
            {
                $"{output}/spineboy-pro.sbdata.bytes", $"{output}/spineboy-pro.png",
                $"{output}/spineboy-pro_BoneBurst.asset"
            };
            string[] guids = paths.Select(AssetDatabase.AssetPathToGUID).ToArray();

            BoneBurstBakeSettings again = Settings(source);
            Assert.AreEqual(settings.OutputFolder, again.OutputFolder);
            again.Scale = 0.02f;
            again.TintBlack = true;
            again.Shader = BoneBurstBakeSettings.ShaderChoice.Lit2D;
            again.Mixes = new[] { new BoneBurstAsset.MixPair { From = "walk", To = "run", Duration = 0.3f } };
            again.CompressTextures = false;
            BoneBurstBake.Result result = BoneBurstBake.Bake(source, again);
            Assert.IsTrue(result.Ok, result.Error);

            CollectionAssert.AreEqual(guids, paths.Select(AssetDatabase.AssetPathToGUID).ToArray(),
                "a rebake changed a GUID");
            Assert.IsTrue(result.Asset.TintBlack);
            Assert.AreEqual(0.02f,
                BoneBurstDataReader.Read(File.ReadAllBytes(BoneBurstBake.DataPathOf(result.Asset))).Scale);
            Assert.AreEqual(TextureImporterCompression.Uncompressed,
                ((TextureImporter)AssetImporter.GetAtPath(paths[1])).textureCompression);

            BoneBurstBakeSettings remembered = Settings(source);
            Assert.AreEqual(0.02f, remembered.Scale);
            Assert.IsTrue(remembered.TintBlack);
            Assert.AreEqual(BoneBurstBakeSettings.ShaderChoice.Lit2D, remembered.Shader);
            Assert.AreEqual(1, remembered.Mixes.Length);
            Assert.IsFalse(remembered.CompressTextures);

            // The asset's context-menu rebake finds its export again.
            BoneBurstBake.Source found = BoneBurstBake.SourceOf(result.Asset, out string error);
            Assert.IsNotNull(found, error);
            Assert.AreEqual(m_Export, found.Folder);
        }

        [Test]
        public void PreviousBake_IsFoundByItsLabel_InAnyFolderUnderAnyName()
        {
            BoneBurstBake.Source source = Export();
            BoneBurstBakeSettings settings = Settings(source);
            settings.Name = "hero";
            settings.OutputFolder = $"{m_Root}/elsewhere/baked";
            settings.MaxTextureSize = BoneBurstBakeSettings.TextureSize.Size1024;
            Assert.IsTrue(BoneBurstBake.Bake(source, settings).Ok);

            string data = $"{m_Root}/elsewhere/baked/hero.sbdata.bytes";
            CollectionAssert.AreEqual(new[] { BoneBurstBake.DataLabel },
                AssetDatabase.GetLabels(AssetDatabase.LoadAssetAtPath<Object>(data)));
            CollectionAssert.Contains(AssetDatabase.FindAssets($"l:{BoneBurstBake.DataLabel}"),
                AssetDatabase.AssetPathToGUID(data));

            BoneBurstBakeSettings found = Settings(source);
            Assert.AreEqual("hero", found.Name);
            Assert.AreEqual($"{m_Root}/elsewhere/baked", found.OutputFolder);
            Assert.AreEqual(BoneBurstBakeSettings.TextureSize.Size1024, found.MaxTextureSize);

            // Given a data file of another export, the settings are the defaults, not that export's.
            BoneBurstBakeSettings other =
                BoneBurstBake.SettingsFor(source,
                    "Assets/BoneBurstDemo/mix-and-match-pro_BoneBurst/mix-and-match-pro.sbdata.bytes");
            m_Owned.Add(other);
            Assert.AreEqual($"{m_Root}/spineboy-pro_BoneBurst", other.OutputFolder);
        }

        [Test]
        public void Variants_ShareDataAndTextures_KeepTheirGuids_AndAreRemembered()
        {
            BoneBurstBake.Source source = Export();
            BoneBurstBakeSettings settings = Settings(source);
            settings.Variants = new[]
            {
                new BoneBurstBakeSettings.Variant
                {
                    Suffix = "Lit2D", Shader = BoneBurstBakeSettings.ShaderChoice.Lit2D, TintBlack = true
                }
            };
            BoneBurstBake.Result result = BoneBurstBake.Bake(source, settings);
            Assert.IsTrue(result.Ok, result.Error);
            StringAssert.Contains("variant created", result.Report);

            string path = $"{settings.OutputFolder}/spineboy-pro_BoneBurst_Lit2D.asset";
            BoneBurstAsset variant = AssetDatabase.LoadAssetAtPath<BoneBurstAsset>(path);
            Assert.IsNotNull(variant, path);
            Assert.AreEqual(result.Asset.DataReference.AssetGuid, variant.DataReference.AssetGuid);
            CollectionAssert.AreEqual(result.Asset.PageReferences, variant.PageReferences);
            Assert.AreEqual("BoneBurst/Lit2D", variant.Shader.name);
            Assert.IsTrue(variant.TintBlack);
            Assert.AreEqual("BoneBurst/Unlit", result.Asset.Shader.name);
            string guid = AssetDatabase.AssetPathToGUID(path);

            BoneBurstBakeSettings again = Settings(source);
            Assert.AreEqual(1, again.Variants.Length, "the variant was not found beside the previous bake");
            Assert.AreEqual("Lit2D", again.Variants[0].Suffix);
            Assert.AreEqual(BoneBurstBakeSettings.ShaderChoice.Lit2D, again.Variants[0].Shader);
            Assert.IsTrue(again.Variants[0].TintBlack);
            again.Variants[0].TintBlack = false;
            again.DefaultMix = 0.5f;
            result = BoneBurstBake.Bake(source, again);
            Assert.IsTrue(result.Ok, result.Error);
            StringAssert.Contains("variant rebaked", result.Report);

            Assert.AreEqual(guid, AssetDatabase.AssetPathToGUID(path), "a rebake changed the variant's GUID");
            variant = AssetDatabase.LoadAssetAtPath<BoneBurstAsset>(path);
            Assert.IsFalse(variant.TintBlack);
            Assert.AreEqual(0.5f, variant.DefaultMix, "a variant takes the bake's mixes");
        }

        [Test]
        public void ForeignAssetAtAVariantPath_StopsTheBake_AndBadSuffixesAreRefused()
        {
            BoneBurstBake.Source source = Export();
            BoneBurstBakeSettings settings = Settings(source);
            Directory.CreateDirectory(settings.OutputFolder);
            AssetDatabase.Refresh();
            string path = $"{settings.OutputFolder}/spineboy-pro_BoneBurst_Lit2D.asset";
            AssetDatabase.CreateAsset(new Material(Shader.Find("BoneBurst/Unlit")), path);
            settings.Variants = new[] { new BoneBurstBakeSettings.Variant { Suffix = "Lit2D" } };

            BoneBurstBake.Result result = BoneBurstBake.Bake(source, settings);
            Assert.IsFalse(result.Ok);
            StringAssert.Contains(path, result.Error);
            Assert.IsInstanceOf<Material>(AssetDatabase.LoadAssetAtPath<Object>(path));
            Assert.IsFalse(File.Exists($"{settings.OutputFolder}/spineboy-pro.sbdata.bytes"));

            foreach (string[] suffixes in new[]
                         { new[] { "" }, new[] { "a/b" }, new[] { " x" }, new[] { "Lit", "lit" } })
            {
                settings.Variants = suffixes.Select(x => new BoneBurstBakeSettings.Variant { Suffix = x }).ToArray();
                result = BoneBurstBake.Bake(source, settings);
                Assert.IsFalse(result.Ok, $"suffixes '{string.Join("', '", suffixes)}' were accepted");
                StringAssert.Contains("variant", result.Error);
            }

            Assert.IsFalse(File.Exists($"{settings.OutputFolder}/spineboy-pro.sbdata.bytes"));
        }

        [Test]
        public void DropCreate_BuildsAReadySkeleton_UnderTheParent_AsOneUndoStep()
        {
            BoneBurstBake.Source source = Export();
            BoneBurstBake.Result result = BoneBurstBake.Bake(source, Settings(source));
            Assert.IsTrue(result.Ok, result.Error);

            // The Test Runner runs EditMode tests in its own untitled scene and restores the open one afterwards.
            GameObject parent = new("parent");
            try
            {
                parent.transform.position = new Vector3(5, 0, 0);

                Undo.IncrementCurrentGroup();
                GameObject go = BoneBurstDrop.Create(result.Asset, parent.transform, new Vector3(1, 2, 0));
                Assert.AreEqual("spineboy-pro", go.name, "the _BoneBurst suffix is dropped");
                Assert.AreSame(parent.transform, go.transform.parent);
                Assert.AreEqual(new Vector3(1, 2, 0), go.transform.position);
                Assert.IsNotNull(go.GetComponent<MeshFilter>());
                Assert.IsNotNull(go.GetComponent<MeshRenderer>());
                BoneBurstSkeleton skeleton = go.GetComponent<BoneBurstSkeleton>();
                Assert.AreSame(result.Asset, skeleton.Asset);
                Assert.IsTrue(skeleton.Skin.IsEmpty, "spineboy's default skin draws, so it stays on it");
                Assert.AreEqual(result.Asset.Keys.KeyOf(BoneBurstKeyKind.Animation, "idle"), skeleton.Animation);

                Undo.PerformUndo();
                Assert.IsTrue(go == null, "Undo did not remove the created skeleton");
            }
            finally
            {
                Object.DestroyImmediate(parent);
            }
        }

        [Test]
        public void EditModePreview_MeshesTheDroppedSkeleton_AndRebuildsAfterAnInspectorChange()
        {
            BoneBurstBake.Source source = Export();
            BoneBurstBake.Result result = BoneBurstBake.Bake(source, Settings(source));
            Assert.IsTrue(result.Ok, result.Error);
            GameObject go = BoneBurstDrop.Create(result.Asset, null, Vector3.zero);
            try
            {
                BoneBurstSkeleton skeleton = go.GetComponent<BoneBurstSkeleton>();
                Assert.IsNotNull(skeleton.Data, "OnEnable did not run in Edit mode");
                PreviewTick();
                Mesh mesh = go.GetComponent<MeshFilter>().sharedMesh;
                Assert.IsNotNull(mesh);
                Assert.Greater(mesh.vertexCount, 0, "the preview built no mesh");
                Assert.AreEqual(HideFlags.DontSave, mesh.hideFlags & HideFlags.DontSave,
                    "the preview mesh would be saved");
                Bounds idle = mesh.bounds;

                // An Inspector edit: the serialized start animation, through SerializedObject as the Inspector does.
                SerializedObject serialized = new(skeleton);
                serialized.FindProperty("m_Animation").FindPropertyRelative("m_String").stringValue = "run";
                serialized.ApplyModifiedProperties();
                PreviewTick();
                Bounds run = go.GetComponent<MeshFilter>().sharedMesh.bounds;
                Assert.AreNotEqual(idle.size, run.size, "the preview did not rebuild for the new start animation");
            }
            finally
            {
                Object.DestroyImmediate(go);
                PreviewTick();
            }
        }

        /// <summary>
        ///     One tick of the Editor's preview driver (<c>BoneBurstEditModePreview</c>).
        /// </summary>
        private static void PreviewTick()
        {
            BoneBurstSkeleton.RestartQueuedPreviews();
            if (!BoneBurstSystem.HasPendingWork) return;
            BoneBurstSystem.Schedule(0);
            BoneBurstSystem.Complete();
        }

        [Test]
        public void DeletedAsset_HasItsBlobFreed()
        {
            BoneBurstBake.Source source = Export();
            BoneBurstBake.Result result = BoneBurstBake.Bake(source, Settings(source));
            Assert.IsTrue(result.Ok, result.Error);
            BoneBurstAsset asset = result.Asset;
            SkeletonBlob blob = asset.Blob;
            Assert.IsTrue(blob.IsCreated);

            // DeleteAsset destroys the asset without OnDisable; the Editor's tick frees the blob.
            AssetDatabase.DeleteAsset(AssetDatabase.GetAssetPath(asset));
            Assert.IsTrue(asset == null, "the asset was not destroyed");
            BoneBurstAsset.FreeDestroyed();
            Assert.IsFalse(blob.IsCreated, "the deleted asset's blob is still allocated (a native leak)");
        }

        [Test]
        public void DropStartSkinAndAnimation_PickWhatDraws()
        {
            string skeletons = "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples";
            SkeletonDef mix =
                SkeletonJsonReader.Read(File.ReadAllText($"{skeletons}/mix-and-match/mix-and-match-pro.json"), 0.01f);
            Assert.AreEqual("skin-base", BoneBurstDrop.StartSkin(mix), "the default skin holds only paths");
            Assert.AreEqual("idle", BoneBurstDrop.StartAnimation(mix));

            SkeletonDef boy = SkeletonJsonReader.Read(File.ReadAllText($"{Samples}/spineboy-pro.json"), 0.01f);
            Assert.IsNull(BoneBurstDrop.StartSkin(boy));
            Assert.AreEqual("idle", BoneBurstDrop.StartAnimation(boy));
        }

        [Test]
        public void ForeignFileAtATarget_StopsTheBake_WritesNothing()
        {
            BoneBurstBake.Source source = Export();
            BoneBurstBakeSettings settings = Settings(source);
            Directory.CreateDirectory(settings.OutputFolder);
            string foreign = $"{settings.OutputFolder}/spineboy-pro.sbdata.bytes";
            File.WriteAllText(foreign, "someone else's file");
            AssetDatabase.Refresh();

            BoneBurstBake.Result result = BoneBurstBake.Bake(source, settings);
            Assert.IsFalse(result.Ok);
            StringAssert.Contains(foreign, result.Error);
            Assert.AreEqual("someone else's file", File.ReadAllText(foreign));
            Assert.IsFalse(File.Exists($"{settings.OutputFolder}/spineboy-pro.png"));
            Assert.IsFalse(File.Exists($"{settings.OutputFolder}/spineboy-pro_BoneBurst.asset"));
        }

        [Test]
        public void OtherAssetTypeAtTheAssetPath_StopsTheBake()
        {
            BoneBurstBake.Source source = Export();
            BoneBurstBakeSettings settings = Settings(source);
            Directory.CreateDirectory(settings.OutputFolder);
            AssetDatabase.Refresh();
            string path = $"{settings.OutputFolder}/spineboy-pro_BoneBurst.asset";
            AssetDatabase.CreateAsset(new Material(Shader.Find("BoneBurst/Unlit")), path);

            BoneBurstBake.Result result = BoneBurstBake.Bake(source, settings);
            Assert.IsFalse(result.Ok);
            StringAssert.Contains("not a BoneBurstAsset", result.Error);
            Assert.IsInstanceOf<Material>(AssetDatabase.LoadAssetAtPath<Object>(path));
            Assert.IsFalse(File.Exists($"{settings.OutputFolder}/spineboy-pro.sbdata.bytes"));
        }

        [Test]
        public void BadSettings_AreRefused_BeforeAnythingIsWritten()
        {
            BoneBurstBake.Source source = Export();
            BoneBurstBakeSettings settings = Settings(source);
            string output = settings.OutputFolder;

            settings.OutputFolder = m_Export;
            StringAssert.Contains("export folder", BoneBurstBake.Bake(source, settings).Error);

            settings.OutputFolder = "Packages/somewhere";
            StringAssert.Contains("inside Assets", BoneBurstBake.Bake(source, settings).Error);

            settings.OutputFolder = output;
            settings.Mixes = new[] { new BoneBurstAsset.MixPair { From = "walk", To = "no-such", Duration = 0.1f } };
            StringAssert.Contains("'no-such' is not an animation", BoneBurstBake.Bake(source, settings).Error);

            settings.Mixes = new BoneBurstAsset.MixPair[0];
            settings.Scale = 0;
            StringAssert.Contains("scale", BoneBurstBake.Bake(source, settings).Error);

            Assert.IsFalse(Directory.Exists(output), "a refused bake created its output folder");
        }
    }
}