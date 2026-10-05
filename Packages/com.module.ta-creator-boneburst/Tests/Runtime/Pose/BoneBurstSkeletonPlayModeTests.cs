using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using BoneBurst.Anim;
using BoneBurst.Constraints;
using BoneBurst.Data;
using BoneBurst.Instance;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.TestTools;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     P2 end to end: a <see cref="BoneBurstSkeleton" /> meshed by the Burst jobs matches the managed
    ///     reference (<see cref="ManagedPose" />, itself at parity with spine-unity in edit mode), is meshed once,
    ///     and re-meshes only when something changes.
    /// </summary>
    public class BoneBurstSkeletonPlayModeTests
    {
        private const string Samples =
            "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples";

        // Burst evaluates double trig with its own library; allow a few float ulps at skeleton scale.
        private const float PositionTolerance = 1e-4f;

        // Every category holds a name "x", so the skin bakes as "x (A)" and the event as "x (B)" (NameKeys.md §2).
        private const string AllNamedX =
            "{\"skeleton\":{\"spine\":\"4.3.00\"}," +
            "\"bones\":[{\"name\":\"root\"},{\"name\":\"x\",\"parent\":\"root\"}]," +
            "\"slots\":[{\"name\":\"x\",\"bone\":\"x\"}]," +
            "\"skins\":[{\"name\":\"default\"},{\"name\":\"x\"}]," +
            "\"events\":{\"x\":{}}," +
            "\"animations\":{\"x\":{\"events\":[{\"time\":0.05,\"name\":\"x\"},{\"time\":0.5,\"name\":\"x\"}]}}}";

        private BoneBurstAsset m_Asset;

        private GameObject m_Object;

        [TearDown]
        public void TearDown()
        {
            if (m_Object != null) Object.Destroy(m_Object);
            if (m_Asset != null) Object.Destroy(m_Asset);
        }

        private BoneBurstSkeleton Spawn(string folder, string skeleton, string atlas, float scale)
        {
            string skeletonPath = $"{Samples}/{folder}/{skeleton}", atlasPath = $"{Samples}/{folder}/{atlas}";
            Assert.IsTrue(File.Exists(skeletonPath), $"missing {skeletonPath}");
            string atlasText = File.ReadAllText(atlasPath);
            m_Asset = ScriptableObject.CreateInstance<BoneBurstAsset>();
            BakedTestData.Assign(m_Asset, skeletonPath, atlasText, scale);
            int pages = AtlasReader.Read(atlasText).Pages.Count;
            Texture2D[] pageTextures = new Texture2D[pages];
            for (int i = 0; i < pages; i++) pageTextures[i] = new Texture2D(2, 2);
            m_Asset.SetPageTextures(pageTextures);

            m_Object = new GameObject("BoneBurst test");
            m_Object.SetActive(false);
            BoneBurstSkeleton component = m_Object.AddComponent<BoneBurstSkeleton>();
            component.Asset = m_Asset;
            m_Object.SetActive(true);
            return component;
        }

        /// <summary>
        ///     A skeleton from JSON with no atlas, given its serialized skin and animation keys before it is enabled,
        ///     as a scene would.
        /// </summary>
        private BoneBurstSkeleton SpawnJson(string json, BoneBurstKey skin, BoneBurstKey animation)
        {
            m_Asset = ScriptableObject.CreateInstance<BoneBurstAsset>();
            byte[] bytes = BoneBurstDataWriter.Write(SkeletonJsonReader.Read(json, 0.01f),
                AtlasReader.Read(string.Empty),
                0.01f);
            m_Asset.SetDataBytes(bytes);
            m_Asset.SetPageTextures(new Texture2D[0]);

            m_Object = new GameObject("BoneBurst keys test");
            m_Object.SetActive(false);
            BoneBurstSkeleton component = m_Object.AddComponent<BoneBurstSkeleton>();
            component.Asset = m_Asset;
            component.Skin = skin;
            component.Animation = animation;
            m_Object.SetActive(true);
            return component;
        }

        [UnityTest]
        public IEnumerator SuffixedKeys_ResolveSkinAnimationAndEventKeyId()
        {
            BoneBurstKeyTable keys = new(BoneBurstKeyTable.BuildEntries(SkeletonJsonReader.Read(AllNamedX)));
            BoneBurstKey skinKey = keys.KeyOf(BoneBurstKeyKind.Skin, "x");
            BoneBurstKey eventKey = keys.KeyOf(BoneBurstKeyKind.Event, "x");
            Assert.AreEqual("x (A)", skinKey.String, "the skin key must be suffixed, or this test proves nothing");
            Assert.AreEqual("x (B)", eventKey.String, "the event key must be suffixed, or this test proves nothing");

            BoneBurstSkeleton skeleton = SpawnJson(AllNamedX, skinKey, keys.KeyOf(BoneBurstKeyKind.Animation, "x"));
            List<BoneBurstEvent> events = new();
            skeleton.Event += (_, e) => events.Add(e);
            Assert.AreEqual("x", skeleton.CurrentSkin?.Name, "key 'x (A)' shows skin 'x'");
            Assert.AreEqual("x", skeleton.AnimationName, "the serialized animation key plays on enable");
            Assert.AreEqual("x", skeleton.Animation.String);

            for (int i = 0; i < 120 && !events.Exists(e => !e.IsComplete); i++) yield return BoneBurstFrames.Next();
            BoneBurstEvent fired = events.Find(e => !e.IsComplete);
            Assert.AreEqual("x", fired.Name, "event 'x' fires");
            Assert.AreEqual(eventKey.Id, fired.KeyId, "KeyId is the baked key's id");
            Assert.AreNotEqual(BoneBurstKey.IdOf("x"), fired.KeyId, "KeyId is not the hash of the event's name");
        }

        [UnityTest]
        public IEnumerator SkinKeyOfAnotherKind_LogsAndShowsDefaultSkin()
        {
            // "x" is the animation's key; the skin named "x" is keyed "x (A)". Looking up by text would find it.
            LogAssert.Expect(LogType.Error, new Regex("skin 'x' not found"));
            BoneBurstSkeleton skeleton = SpawnJson(AllNamedX, "x", default);
            Assert.IsNull(skeleton.CurrentSkin, "a key that names no skin shows the default skin only");
            yield return BoneBurstFrames.Next();
        }

        [UnityTest]
        public IEnumerator Spineboy_BurstMeshMatchesManagedReference()
        {
            BoneBurstSkeleton skeleton = Spawn("spineboy-pro", "spineboy-pro.json", "spineboy-pro.atlas.txt", 0.01f);
            yield return BoneBurstFrames.Next();

            Assert.AreEqual(1, BoneBurstSystem.LastFrameMeshed, "the new skeleton should be meshed on its first frame");
            ManagedPose reference = new(skeleton.Blob.Content, -1)
            {
                LinearColorSpace = QualitySettings.activeColorSpace == ColorSpace.Linear
            };
            reference.SetupPoseAndMesh();
            AssertMeshEquals(reference, skeleton);

            yield return BoneBurstFrames.Next();
            Assert.AreEqual(0, BoneBurstSystem.LastFrameMeshed, "an unchanged skeleton must not be re-meshed");
        }

        [UnityTest]
        public IEnumerator MixAndMatch_SkinChange_Remeshes()
        {
            BoneBurstSkeleton skeleton = Spawn("mix-and-match", "mix-and-match-pro.json", "mix-and-match.atlas.txt",
                0.01f);
            yield return BoneBurstFrames.Next();
            int before = skeleton.Mesh.vertexCount;

            skeleton.Skin = "full-skins/girl";
            yield return BoneBurstFrames.Next();

            Assert.AreEqual(1, BoneBurstSystem.LastFrameMeshed);
            int skin = skeleton.Blob.FindSkin("full-skins/girl");
            Assert.That(skin, Is.GreaterThanOrEqualTo(0), "sample skin missing");
            ManagedPose reference = new(skeleton.Blob.Content, skin)
            {
                LinearColorSpace = QualitySettings.activeColorSpace == ColorSpace.Linear
            };
            reference.SetupPoseAndMesh();
            AssertMeshEquals(reference, skeleton);
            Assert.AreNotEqual(before, skeleton.Mesh.vertexCount, "a different skin should change the mesh");
        }

        [UnityTest]
        public IEnumerator MixAndMatch_CombinedSkin_MatchesManagedReference()
        {
            // M2's SpineLook pattern: new skin, AddSkin per part, SetSkin, SetupPoseSlots.
            BoneBurstSkeleton skeleton = Spawn("mix-and-match", "mix-and-match-pro.json", "mix-and-match.atlas.txt",
                0.01f);
            yield return BoneBurstFrames.Next();
            string[] parts = { "skin-base", "clothes/hoodie-orange", "hair/pink", "eyes/violet", "legs/pants-jeans" };
            BoneBurstSkin look = new("look", skeleton.Blob);
            foreach (string part in parts) look.AddSkin(skeleton.Blob.GetSkin(part));
            skeleton.SetSkin(look);
            skeleton.SetupPoseSlots();
            yield return BoneBurstFrames.Next();

            Assert.AreEqual(1, BoneBurstSystem.LastFrameMeshed, "a skin change re-meshes");
            Assert.AreSame(look, skeleton.CurrentSkin);
            ManagedPose reference = new(skeleton.Blob.Content, -1)
            {
                LinearColorSpace = QualitySettings.activeColorSpace == ColorSpace.Linear
            };
            BoneBurstSkin referenceLook = new("look", skeleton.Blob);
            foreach (string part in parts) referenceLook.AddSkin(skeleton.Blob.GetSkin(part));
            reference.SetSkin(referenceLook);
            reference.SetupPoseSlots();
            reference.Pose(null, PhysicsMode.None);
            reference.BuildMesh();
            AssertMeshEquals(reference, skeleton);
        }

        [UnityTest]
        public IEnumerator TintBlack_WritesDarkColourStreams()
        {
            BoneBurstSkeleton skeleton = Spawn("spineboy-pro", "spineboy-pro.json", "spineboy-pro.atlas.txt", 0.01f);
            skeleton.enabled = false;
            m_Asset.TintBlack = true;
            skeleton.enabled = true;
            yield return BoneBurstFrames.Next();
            ManagedPose reference = new(skeleton.Blob.Content, -1)
            {
                LinearColorSpace = QualitySettings.activeColorSpace == ColorSpace.Linear, TintBlack = true
            };
            reference.SetupPoseAndMesh();
            // Both CPU paths: this frame (the first, uploaded into the Mesh's tint stream) and the next (vertex
            // fetch, when the platform has it: the shared tint list).
            for (int pass = 0; pass < 2; pass++)
            {
                if (!skeleton.LastMeshFetched)
                {
                    Assert.IsTrue(skeleton.Mesh.HasVertexAttribute(VertexAttribute.TexCoord1), "uv2 stream");
                    Assert.IsTrue(skeleton.Mesh.HasVertexAttribute(VertexAttribute.TexCoord2), "uv3 stream");
                }

                List<Vector4> tint = new();
                skeleton.GetCpuVertices(new List<Vector3>(),
                    new List<Color32>(), new List<Vector2>(), tint);
                Assert.AreEqual(reference.Counts.Vertices, tint.Count, $"pass {pass}: tint count");
                for (int i = 0; i < reference.Counts.Vertices; i++)
                {
                    Assert.AreEqual(reference.Tint[i].x, tint[i].x, $"pass {pass}: uv2.x {i}");
                    Assert.AreEqual(reference.Tint[i].w, tint[i].w, $"pass {pass}: uv3.y {i}");
                }

                skeleton.SetupPose();
                yield return BoneBurstFrames.Next();
            }
        }

        /// <summary>
        ///     Bounds with a margin: every frame of an animating skeleton, on both paths, the Mesh bounds contain the
        ///     exact bounds of the pose (culling never cuts it) and are not looser than the limit; and on most
        ///     frames the native Mesh.bounds call is skipped.
        /// </summary>
        [UnityTest]
        public IEnumerator Bounds_ContainThePoseEveryFrame([Values(false, true)] bool gpu)
        {
            BoneBurstSkeleton skeleton = Spawn("spineboy-pro", "spineboy-pro.json", "spineboy-pro.atlas.txt", 0.01f);
            skeleton.GpuSkinning = gpu;
            skeleton.PlayAnimation(gpu ? "idle" : "walk", true);
            yield return BoneBurstFrames.Next();
            int unchanged = 0, frames = 60;
            Bounds previous = skeleton.Mesh.bounds;
            for (int frame = 0; frame < frames; frame++)
            {
                yield return BoneBurstFrames.Next();
                MeshOutput output = skeleton.Data.Output[0];
                Bounds exact = new() { center = output.Center, extents = output.Extents };
                Bounds set = skeleton.Mesh.bounds;
                Assert.That(set.Contains(exact.min) && set.Contains(exact.max),
                    $"frame {frame}: mesh bounds {set} do not contain the pose {exact}");
                Assert.That(set.extents.x,
                    Is.LessThanOrEqualTo(exact.extents.x * 1.5f + 0.05f * Mathf.Max(exact.extents.x, exact.extents.y) +
                                         1e-4f),
                    $"frame {frame}: bounds too loose");
                if (set == previous) unchanged++;
                previous = set;
            }

            Debug.Log($"[Bounds] gpu={gpu}: Mesh.bounds unchanged on {unchanged}/{frames} frames");
            Assert.Greater(unchanged, frames / 2, "the margin should skip most Mesh.bounds updates");
        }

        [UnityTest]
        public IEnumerator Destroy_RemovesInstance()
        {
            int before = BoneBurstSystem.InstanceCount;
            Spawn("raptor", "raptor.json", "raptor.atlas.txt", 0.01f);
            yield return BoneBurstFrames.Next();
            Assert.AreEqual(before + 1, BoneBurstSystem.InstanceCount);

            Object.Destroy(m_Object);
            m_Object = null;
            yield return BoneBurstFrames.Next();
            yield return BoneBurstFrames.Next();
            Assert.AreEqual(before, BoneBurstSystem.InstanceCount);
        }

        private static void AssertMeshEquals(ManagedPose reference, BoneBurstSkeleton skeleton)
        {
            Mesh mesh = skeleton.Mesh;
            Assert.That(reference.Counts.Vertices, Is.GreaterThan(0), "reference mesh is empty");
            Assert.AreEqual(reference.Counts.Vertices, mesh.vertexCount, "vertex count");
            Assert.AreEqual(reference.Counts.Submeshes, mesh.subMeshCount, "submesh count");

            List<Vector3> positionList = new();
            List<Color32> colorList = new();
            List<Vector2> uvList = new();
            skeleton.GetCpuVertices(positionList, colorList, uvList);
            Vector3[] positions = positionList.ToArray();
            Vector2[] uvs = uvList.ToArray();
            Color32[] colors = colorList.ToArray();
            float worst = 0;
            for (int i = 0; i < positions.Length; i++)
            {
                SkeletonVertex v = reference.Vertices[i];
                worst = Mathf.Max(worst, Mathf.Abs(positions[i].x - v.Position.x),
                    Mathf.Abs(positions[i].y - v.Position.y));
                Assert.AreEqual(v.Uv.x, uvs[i].x, $"uv.x {i}");
                Assert.AreEqual(v.Uv.y, uvs[i].y, $"uv.y {i}");
                Assert.AreEqual(new Color32(v.R, v.G, v.B, v.A), colors[i], $"colour {i}");
            }

            Assert.That(worst, Is.LessThanOrEqualTo(PositionTolerance), $"largest position difference {worst}");

            int index = 0;
            for (int s = 0; s < mesh.subMeshCount; s++)
                foreach (int i in mesh.GetIndices(s))
                    Assert.AreEqual(reference.Indices[index++], (uint)i, $"index {index - 1}");

            Assert.AreEqual(reference.Indices.Length, index, "index count");
            Material[] materials = skeleton.GetComponent<MeshRenderer>().sharedMaterials;
            Assert.AreEqual(mesh.subMeshCount, materials.Length, "one material per submesh");
            CollectionAssert.AllItemsAreNotNull(materials);
            Assert.That(mesh.bounds.size.x, Is.GreaterThan(0), "bounds");
        }
    }
}