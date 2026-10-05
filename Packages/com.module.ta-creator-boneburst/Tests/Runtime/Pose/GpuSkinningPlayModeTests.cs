using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using BoneBurst.Anim;
using BoneBurst.Data;
using BoneBurst.Instance;
using NUnit.Framework;
using Unity.Collections;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.TestTools;
using CommandBuffer = BoneBurst.Anim.CommandBuffer;
using Object = UnityEngine.Object;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     P7 end to end (<c>Doc/Format/GpuSkinning.md</c>): the jobs build the static GPU mesh, write the pose
    ///     record, upload it, and switch materials; evaluating the uploaded buffer with the shader's arithmetic
    ///     gives the managed reference's CPU mesh. Skipped where the platform cannot skin on the GPU.
    /// </summary>
    public class GpuSkinningPlayModeTests
    {
        private const string Samples =
            "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples";

        private const string Synthetic = "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/synthetic";

        // Burst evaluates double trig with its own library; allow a few float ulps at skeleton scale.
        private const float PositionTolerance = 1e-4f;
        private BoneBurstAsset m_Asset;

        private GameObject m_Object;

        [SetUp]
        public void SetUp()
        {
            if (!BoneBurstGpu.IsSupported) Assert.Ignore("GPU skinning needs shader model 4.5 on this platform");
        }

        [TearDown]
        public void TearDown()
        {
            if (m_Object != null) Object.Destroy(m_Object);
            if (m_Asset != null) Object.Destroy(m_Asset);
        }

        private BoneBurstSkeleton Spawn(string skeletonPath, string atlasPath, float scale, string animation = null)
        {
            Assert.IsTrue(File.Exists(skeletonPath), $"missing {skeletonPath}");
            string atlasText = File.ReadAllText(atlasPath);
            m_Asset = ScriptableObject.CreateInstance<BoneBurstAsset>();
            BakedTestData.Assign(m_Asset, skeletonPath, atlasText, scale);
            int pages = AtlasReader.Read(atlasText).Pages.Count;
            Texture2D[] pageTextures = new Texture2D[pages];
            for (int i = 0; i < pages; i++) pageTextures[i] = new Texture2D(2, 2);
            m_Asset.SetPageTextures(pageTextures);

            m_Object = new GameObject("BoneBurst GPU test");
            m_Object.SetActive(false);
            BoneBurstSkeleton component = m_Object.AddComponent<BoneBurstSkeleton>();
            component.Asset = m_Asset;
            component.GpuSkinning = true;
            m_Object.SetActive(true);
            if (animation != null) component.PlayAnimation(animation, true);
            return component;
        }

        [UnityTest]
        public IEnumerator Spineboy_SetupPose_UploadedRecordSkinsToReference()
        {
            BoneBurstSkeleton skeleton = Spawn($"{Samples}/spineboy-pro/spineboy-pro.json",
                $"{Samples}/spineboy-pro/spineboy-pro.atlas.txt", 0.01f);
            yield return BoneBurstFrames.Next();

            Assert.AreEqual(GpuMeshState.Built, skeleton.LastGpuState, "the first GPU frame builds the static mesh");
            Assert.IsTrue(skeleton.Mesh.HasVertexAttribute(VertexAttribute.TexCoord3), "skinning stream");
            foreach (Material material in skeleton.GetComponent<MeshRenderer>().sharedMaterials)
                Assert.IsTrue(material.IsKeywordEnabled(BoneBurstMaterials.GpuKeyword), $"{material.name} keyword");

            ManagedPose reference = new(skeleton.Blob.Content, -1)
            {
                LinearColorSpace = QualitySettings.activeColorSpace == ColorSpace.Linear
            };
            reference.SetupPoseAndMesh();
            AssertSkinsTo(reference, skeleton);
        }

        [UnityTest]
        public IEnumerator Synthetic_Animating_ReusesStaticMesh()
        {
            // gpu.json 'wave': bones and colours animate, attachments and draw order do not.
            BoneBurstSkeleton skeleton = Spawn($"{Synthetic}/gpu.json", $"{Synthetic}/synthetic.atlas.txt", 1,
                "wave");
            yield return BoneBurstFrames.Next();
            Assert.AreEqual(GpuMeshState.Built, skeleton.LastGpuState);
            int reused = 0;
            for (int frame = 0; frame < 10; frame++)
            {
                yield return BoneBurstFrames.Next();
                Assert.AreEqual(GpuMeshState.Reused, skeleton.LastGpuState, $"frame {frame}");
                reused += BoneBurstSystem.LastFrameGpuReused;
                Assert.That(BoneBurstGpu.LastUploadCount, Is.GreaterThan(0), "a record is uploaded every frame");
            }

            Assert.That(reused, Is.GreaterThanOrEqualTo(10));
        }

        [UnityTest]
        public IEnumerator Synthetic_Animating_UploadedRecordSkinsToReference()
        {
            BoneBurstSkeleton skeleton = Spawn($"{Synthetic}/gpu.json", $"{Synthetic}/synthetic.atlas.txt", 1,
                "wave");
            skeleton.TimeScale = 0;
            yield return BoneBurstFrames.Next();
            yield return BoneBurstFrames.Next();
            Assert.AreEqual(GpuMeshState.Reused, skeleton.LastGpuState);
            ManagedPose reference = new(skeleton.Blob.Content, -1)
            {
                LinearColorSpace = QualitySettings.activeColorSpace == ColorSpace.Linear
            };
            BoneAnimationState track = new(new BoneAnimationStateData(reference.Content));
            CommandBuffer buffer = new();
            track.SetAnimation(0, Array.FindIndex(skeleton.Blob.Skeleton.Animations, a => a.Name == "wave"), true);
            track.Update(0);
            track.Apply(buffer);
            reference.Pose(buffer);
            reference.BuildMesh();
            AssertSkinsTo(reference, skeleton);
        }

        [UnityTest]
        public IEnumerator Clipping_FallsBackToCpuMesh()
        {
            BoneBurstSkeleton skeleton = Spawn($"{Synthetic}/clipping.json", $"{Synthetic}/synthetic.atlas.txt", 1,
                "still");
            yield return BoneBurstFrames.Next();
            Assert.AreEqual(GpuMeshState.Cpu, skeleton.LastGpuState, "an active clip builds the CPU mesh");
            Assert.That(BoneBurstSystem.LastFrameGpuFallback, Is.EqualTo(1));
            Assert.IsFalse(skeleton.Mesh.HasVertexAttribute(VertexAttribute.TexCoord3));
            foreach (Material material in skeleton.GetComponent<MeshRenderer>().sharedMaterials)
                Assert.IsFalse(material.IsKeywordEnabled(BoneBurstMaterials.GpuKeyword), $"{material.name} keyword");
        }

        [UnityTest]
        public IEnumerator TurningOff_ReturnsToCpuMaterials()
        {
            BoneBurstSkeleton skeleton = Spawn($"{Synthetic}/gpu.json", $"{Synthetic}/synthetic.atlas.txt", 1);
            yield return BoneBurstFrames.Next();
            Assert.AreEqual(GpuMeshState.Built, skeleton.LastGpuState);
            skeleton.GpuSkinning = false;
            yield return BoneBurstFrames.Next();
            Assert.AreEqual(GpuMeshState.Cpu, skeleton.LastGpuState);
            Assert.IsFalse(skeleton.Mesh.HasVertexAttribute(VertexAttribute.TexCoord3));
            foreach (Material material in skeleton.GetComponent<MeshRenderer>().sharedMaterials)
                Assert.IsFalse(material.IsKeywordEnabled(BoneBurstMaterials.GpuKeyword), $"{material.name} keyword");
        }

        /// <summary>
        ///     Reads back the uploaded pose record and evaluates the static mesh with the shader's arithmetic.
        /// </summary>
        private static void AssertSkinsTo(ManagedPose reference, BoneBurstSkeleton skeleton)
        {
            Mesh mesh = skeleton.Mesh;
            Assert.That(reference.Counts.Vertices, Is.GreaterThan(0), "reference mesh is empty");
            Assert.AreEqual(reference.Counts.Vertices, mesh.vertexCount, "vertex count");
            int poseBase = skeleton.Data.GpuBase, size = skeleton.Data.GpuSize;
            Assert.That(poseBase, Is.GreaterThanOrEqualTo(0), "no pose record");
            float4[] pose = new float4[size];
            BoneBurstGpu.PoseBuffer.GetData(pose, 0, poseBase, size);
            NativeArray<float4> staged = BoneBurstGpu.PoseData;
            for (int i = 0; i < size; i++) Assert.AreEqual(staged[poseBase + i], pose[i], $"uploaded record {i}");
            float4[] influences = BoneBurstGpu.InfluenceData.ToArray();

            Vector3[] positions = mesh.vertices;
            List<Vector4> skin = new();
            mesh.GetUVs(3, skin);
            Vector2[] uvs = mesh.uv;
            float worst = 0;
            for (int k = 0; k < positions.Length; k++)
            {
                float2 world = Skin(positions[k], skin[k], pose, influences, out float4 color);
                SkeletonVertex v = reference.Vertices[k];
                worst = Mathf.Max(worst, Mathf.Abs(world.x - v.Position.x), Mathf.Abs(world.y - v.Position.y));
                Assert.AreEqual(v.Position.z, positions[k].z, $"z {k}");
                Assert.AreEqual(v.Uv.x, uvs[k].x, $"uv.x {k}");
                Assert.AreEqual(v.Uv.y, uvs[k].y, $"uv.y {k}");
                Assert.AreEqual(new Color32(v.R, v.G, v.B, v.A),
                    new Color32(Byte(color.x), Byte(color.y), Byte(color.z), Byte(color.w)), $"colour {k}");
            }

            Assert.That(worst, Is.LessThanOrEqualTo(PositionTolerance), $"largest position difference {worst}");
            Bounds bounds = mesh.bounds;
            Assert.That(bounds.min.x, Is.LessThanOrEqualTo(reference.Min.x + PositionTolerance), "bounds min x");
            Assert.That(bounds.max.y, Is.GreaterThanOrEqualTo(reference.Max.y - PositionTolerance), "bounds max y");
        }

        /// <summary>
        ///     <c>BoneBurstCommon.hlsl</c> <c>BoneBurstSkin</c>, with the record already at base 0.
        /// </summary>
        private static float2 Skin(Vector3 position, Vector4 skin, float4[] pose, float4[] influences, out float4 color)
        {
            uint count = (uint)skin.y;
            float2 world;
            if (count == 0)
            {
                uint bone = 2 * (uint)skin.z;
                float4 m = pose[bone];
                float4 t = pose[bone + 1];
                world = new float2(position.x * m.x + position.y * m.y + t.x,
                    position.x * m.z + position.y * m.w + t.y);
            }
            else
            {
                world = new float2(0, 0);
                uint first = (uint)skin.x;
                for (uint i = 0; i < count; i++)
                {
                    float4 influence = influences[first + i];
                    uint bone = 2 * (uint)influence.w;
                    float4 m = pose[bone];
                    float4 t = pose[bone + 1];
                    world.x += (influence.x * m.x + influence.y * m.y + t.x) * influence.z;
                    world.y += (influence.x * m.z + influence.y * m.w + t.y) * influence.z;
                }
            }

            color = pose[(uint)skin.w];
            return world;
        }

        private static byte Byte(float value)
        {
            return (byte)math.round(value * 255);
        }
    }
}