using System.Collections;
using System.Collections.Generic;
using System.IO;
using BoneBurst.Anim;
using BoneBurst.Data;
using BoneBurst.Instance;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     P3 end to end: a playing <see cref="BoneBurstSkeleton" /> is re-posed and re-meshed by the Burst jobs
    ///     every frame, matches the managed reference driven with the same frame deltas, and delivers its events.
    /// </summary>
    public class AnimationPlayModeTests
    {
        private const string Samples =
            "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples";

        private const float PositionTolerance = 1e-4f;
        private BoneBurstAsset m_Asset;

        private GameObject m_Object;

        [TearDown]
        public void TearDown()
        {
            if (m_Object != null) Object.Destroy(m_Object);
            if (m_Asset != null) Object.Destroy(m_Asset);
        }

        private BoneBurstSkeleton Spawn(string folder, string skeleton, string atlas)
        {
            string atlasText = File.ReadAllText($"{Samples}/{folder}/{atlas}");
            m_Asset = ScriptableObject.CreateInstance<BoneBurstAsset>();
            BakedTestData.Assign(m_Asset, $"{Samples}/{folder}/{skeleton}", atlasText, BakedTestData.DefaultScale);
            int pages = AtlasReader.Read(atlasText).Pages.Count;
            Texture2D[] pageTextures = new Texture2D[pages];
            for (int i = 0; i < pages; i++) pageTextures[i] = new Texture2D(2, 2);
            m_Asset.SetPageTextures(pageTextures);
            m_Object = new GameObject("BoneBurst animation test");
            m_Object.SetActive(false);
            BoneBurstSkeleton component = m_Object.AddComponent<BoneBurstSkeleton>();
            component.Asset = m_Asset;
            m_Object.SetActive(true);
            return component;
        }

        [UnityTest]
        public IEnumerator Raptor_Walk_BurstMatchesManagedEveryFrame()
        {
            BoneBurstSkeleton skeleton = Spawn("raptor", "raptor.json", "raptor.atlas.txt");
            skeleton.PlayAnimation("walk", true);
            List<BoneBurstEvent> events = new();
            skeleton.Event += (_, e) => events.Add(e);

            ManagedPose reference = new(skeleton.Blob.Content, -1)
            {
                LinearColorSpace = QualitySettings.activeColorSpace == ColorSpace.Linear
            };
            BoneAnimationState track = new(skeleton.Asset.AnimationStateData);
            CommandBuffer buffer = new();
            track.SetAnimation(0, "walk", true);

            for (int frame = 0; frame < 90; frame++)
            {
                yield return BoneBurstFrames.Next();
                Assert.AreEqual(1, BoneBurstSystem.LastFrameMeshed, "a playing skeleton is meshed every frame");

                track.Update(Time.deltaTime * skeleton.TimeScale);
                reference.Time += Time.deltaTime * skeleton.TimeScale;
                track.Apply(buffer);
                reference.Pose(buffer);
                reference.BuildMesh();
                track.AfterApply(buffer, reference.FiredEvents(), reference.TotalAlpha, reference.Rotation);

                Vector3[] positions = CpuMesh.Positions(skeleton);
                Assert.AreEqual(reference.Counts.Vertices, positions.Length, $"frame {frame} vertex count");
                float worst = 0;
                for (int i = 0; i < positions.Length; i++)
                    worst = Mathf.Max(worst, Mathf.Abs(positions[i].x - reference.Vertices[i].Position.x),
                        Mathf.Abs(positions[i].y - reference.Vertices[i].Position.y));

                Assert.That(worst, Is.LessThanOrEqualTo(PositionTolerance),
                    $"frame {frame}: largest difference {worst}");
            }

            Assert.That(events.Exists(e => e.IsComplete), "a looping walk completes at least once in 90 frames");
        }

        [UnityTest]
        public IEnumerator CelestialCircus_Physics_BurstMatchesManagedEveryFrame()
        {
            BoneBurstSkeleton skeleton = Spawn("celestial-circus", "celestial-circus-pro.json",
                "celestial-circus.atlas.txt");
            skeleton.PlayAnimation("swing", true);
            ManagedPose reference = new(skeleton.Blob.Content, -1)
            {
                LinearColorSpace = QualitySettings.activeColorSpace == ColorSpace.Linear
            };
            BoneAnimationState track = new(skeleton.Asset.AnimationStateData);
            CommandBuffer buffer = new();
            track.SetAnimation(0, "swing", true);
            float worstOverall = 0;
            for (int frame = 0; frame < 120; frame++)
            {
                // Move the GameObject part-way through: physics must feel it, and the reference is told the same.
                if (frame == 40) skeleton.transform.position += new Vector3(0.5f, -0.25f, 0);
                yield return BoneBurstFrames.Next();
                Assert.AreEqual(1, BoneBurstSystem.LastFrameMeshed, "a physics skeleton is meshed every frame");

                float delta = Time.deltaTime * skeleton.TimeScale;
                track.Update(delta);
                reference.Time += delta;
                if (frame == 40) reference.PhysicsTranslate(0.5f, -0.25f);
                track.Apply(buffer);
                reference.Pose(buffer);
                reference.BuildMesh();
                track.AfterApply(buffer, reference.FiredEvents(), reference.TotalAlpha, reference.Rotation);

                Vector3[] positions = CpuMesh.Positions(skeleton);
                Assert.AreEqual(reference.Counts.Vertices, positions.Length, $"frame {frame} vertex count");
                float worst = 0;
                for (int i = 0; i < positions.Length; i++)
                    worst = Mathf.Max(worst, Mathf.Abs(positions[i].x - reference.Vertices[i].Position.x),
                        Mathf.Abs(positions[i].y - reference.Vertices[i].Position.y));

                worstOverall = Mathf.Max(worstOverall, worst);
                Assert.That(worst, Is.LessThanOrEqualTo(PositionTolerance),
                    $"frame {frame}: largest difference {worst}");
            }

            // Bit parity is the goal; the tolerance only guards Burst's own pow/acos. Report what was seen.
            Debug.Log($"BoneBurst physics play-mode: largest Burst vs managed vertex difference {worstOverall}");
        }

        [UnityTest]
        public IEnumerator Physics_KeepsSteppingWithoutAnimation()
        {
            BoneBurstSkeleton skeleton = Spawn("celestial-circus", "celestial-circus-pro.json",
                "celestial-circus.atlas.txt");
            yield return BoneBurstFrames.Next();
            yield return BoneBurstFrames.Next();
            skeleton.transform.position += new Vector3(1, 0, 0);
            Vector3[] before = CpuMesh.Positions(skeleton);
            yield return BoneBurstFrames.Next();
            yield return BoneBurstFrames.Next();
            Assert.AreEqual(1, BoneBurstSystem.LastFrameMeshed, "physics steps with no animation playing");
            Vector3[] after = CpuMesh.Positions(skeleton);
            bool moved = false;
            for (int i = 0; i < before.Length && !moved; i++) moved = before[i] != after[i];
            Assert.That(moved, "moving the GameObject swings the physics bones");
            Assert.That(skeleton.PhysicsTime, Is.GreaterThan(0), "the physics clock advances");
        }

        [UnityTest]
        public IEnumerator Crossfade_UsesAssetDefaultMix()
        {
            BoneBurstSkeleton skeleton = Spawn("spineboy-pro", "spineboy-pro.json", "spineboy-pro.atlas.txt");
            skeleton.PlayAnimation("walk", true);
            yield return BoneBurstFrames.Next();
            yield return BoneBurstFrames.Next();
            skeleton.PlayAnimation("run", true);
            yield return BoneBurstFrames.Next();
            BoneTrackEntry run = skeleton.AnimationState.GetTrack(0);
            Assert.AreEqual("run", run.Name);
            Assert.AreEqual(0.2f, run.MixDuration, "the asset's default mix (0.2, as spine-unity imports)");
            Assert.IsNotNull(run.MixingFrom, "walk mixes out");
            Assert.AreEqual("walk", run.MixingFrom.Name);
            for (int i = 0; i < 30; i++) yield return BoneBurstFrames.Next();
            Assert.IsNull(run.MixingFrom, "the crossfade has finished");
        }

        [UnityTest]
        public IEnumerator StopAnimation_StopsRemeshing()
        {
            BoneBurstSkeleton skeleton = Spawn("spineboy-pro", "spineboy-pro.json", "spineboy-pro.atlas.txt");
            skeleton.PlayAnimation("run", true);
            yield return BoneBurstFrames.Next();
            yield return BoneBurstFrames.Next();
            Assert.AreEqual(1, BoneBurstSystem.LastFrameMeshed);
            Assert.AreEqual("run", skeleton.AnimationName);

            skeleton.StopAnimation();
            yield return BoneBurstFrames.Next();
            yield return BoneBurstFrames.Next();
            Assert.AreEqual(0, BoneBurstSystem.LastFrameMeshed, "a stopped skeleton costs nothing per frame");
        }
    }
}