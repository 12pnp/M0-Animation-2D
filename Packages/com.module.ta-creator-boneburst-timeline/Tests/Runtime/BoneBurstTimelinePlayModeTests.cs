using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using BoneBurst.Anim;
using BoneBurst.Data;
using BoneBurst.Instance;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.Playables;
using UnityEngine.TestTools;
using Object = UnityEngine.Object;

namespace BoneBurst.Timeline.Tests
{
    /// <summary>
    ///     P1 end to end: a Timeline-style playable graph drives a live skeleton. A started clip advances on the game
    ///     clock, its first pose is applied in the same evaluation (<see cref="BoneBurstSystem.ReapplyNow" />), and a
    ///     second clip mixes from the first with the asset's mix duration.
    /// </summary>
    public class BoneBurstTimelinePlayModeTests
    {
        private const string Samples =
            "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples";

        private const float PositionTolerance = 1e-4f;
        private BoneBurstAsset m_Asset;
        private PlayableGraph m_Graph;

        private GameObject m_Object;

        [TearDown]
        public void TearDown()
        {
            if (m_Graph.IsValid()) m_Graph.Destroy();
            if (m_Object != null) Object.Destroy(m_Object);
            if (m_Asset != null) Object.Destroy(m_Asset);
        }

        /// <summary>
        ///     Advances one frame and resumes after the system's Complete, as BoneBurst's own play-mode tests do.
        /// </summary>
        private static IEnumerator Next()
        {
            yield return null;
            yield return new WaitForEndOfFrame();
            Assert.AreEqual(BoneBurstSystem.FramesScheduled, BoneBurstSystem.FramesCompleted,
                "resumed before BoneBurstSystem.Complete; the frame's output is not applied yet");
        }

        private BoneBurstSkeleton Spawn()
        {
            string atlasText = File.ReadAllText($"{Samples}/spineboy-pro/spineboy-pro.atlas.txt");
            m_Asset = ScriptableObject.CreateInstance<BoneBurstAsset>();
            SkeletonDef skeleton =
                SkeletonJsonReader.Read(File.ReadAllText($"{Samples}/spineboy-pro/spineboy-pro.json"), 0.01f);
            m_Asset.SetDataBytes(BoneBurstDataWriter.Write(skeleton, AtlasReader.Read(atlasText), 0.01f));
            int pages = AtlasReader.Read(atlasText).Pages.Count;
            Texture2D[] pageTextures = new Texture2D[pages];
            for (int i = 0; i < pages; i++) pageTextures[i] = new Texture2D(2, 2);
            m_Asset.SetPageTextures(pageTextures);
            m_Object = new GameObject("BoneBurst timeline play test");
            m_Object.SetActive(false);
            BoneBurstSkeleton component = m_Object.AddComponent<BoneBurstSkeleton>();
            component.Asset = m_Asset;
            m_Object.SetActive(true);
            return component;
        }

        private ScriptPlayable<BoneBurstAnimationMixer> BuildMixer(BoneBurstSkeleton skeleton, int inputs)
        {
            m_Graph = PlayableGraph.Create("BoneBurst timeline play test");
            ScriptPlayable<BoneBurstAnimationMixer> mixer =
                ScriptPlayable<BoneBurstAnimationMixer>.Create(m_Graph, inputs);
            ScriptPlayableOutput output = ScriptPlayableOutput.Create(m_Graph, "skeleton");
            output.SetSourcePlayable(mixer);
            output.SetUserData(skeleton);
            return mixer;
        }

        private ScriptPlayable<BoneBurstAnimationBehaviour> AddClip(
            ScriptPlayable<BoneBurstAnimationMixer> mixer, int input, BoneBurstAnimationBehaviour template)
        {
            ScriptPlayable<BoneBurstAnimationBehaviour> clip =
                ScriptPlayable<BoneBurstAnimationBehaviour>.Create(m_Graph, template);
            mixer.ConnectInput(input, clip, 0);
            mixer.SetInputWeight(input, 0f);
            return clip;
        }

        private int AnimationIndex(string name)
        {
            return Array.FindIndex(m_Asset.Blob.Skeleton.Animations, a => a.Name == name);
        }

        private static float Worst(List<Vector3> positions, ManagedPose reference)
        {
            float worst = 0;
            for (int i = 0; i < positions.Count; i++)
                worst = Mathf.Max(worst, Mathf.Abs(positions[i].x - reference.Vertices[i].Position.x),
                    Mathf.Abs(positions[i].y - reference.Vertices[i].Position.y));

            return worst;
        }

        [UnityTest]
        public IEnumerator ClipStarted_AdvancesOnTheGameClock()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstAnimationMixer> mixer = BuildMixer(skeleton, 1);
            AddClip(mixer, 0, new BoneBurstAnimationBehaviour { Asset = m_Asset, animation = "walk", loop = true });

            float expected = 0;
            for (int frame = 0; frame < 30; frame++)
            {
                yield return Next();
                if (frame == 5)
                {
                    mixer.SetInputWeight(0, 1f);
                    m_Graph.Evaluate(0);
                }
                else if (frame > 5)
                {
                    expected += Time.deltaTime;
                }
            }

            BoneTrackEntry entry = skeleton.AnimationState.GetTrack(0);
            Assert.AreEqual(AnimationIndex("walk"), entry.Animation);
            Assert.That(entry.TrackTime, Is.EqualTo(expected).Within(1e-3f),
                "between clip starts the entry advances on the game clock, at clip and root speed 1");
        }

        [UnityTest]
        public IEnumerator ClipStart_IsPosedInTheSameEvaluation()
        {
            BoneBurstSkeleton skeleton = Spawn();
            // No start animation: the skeleton settles on its setup pose, so the clip starts with no entry to mix
            // from and the first pose is pure walk at time 0.
            for (int i = 0; i < 3; i++) yield return Next();

            ScriptPlayable<BoneBurstAnimationMixer> mixer = BuildMixer(skeleton, 1);
            AddClip(mixer, 0, new BoneBurstAnimationBehaviour { Asset = m_Asset, animation = "walk", loop = true });
            mixer.SetInputWeight(0, 1f);
            m_Graph.Evaluate(0);

            // No yield: the mesh must already show walk at time 0, like this managed reference.
            ManagedPose reference = new(skeleton.Blob.Content, -1)
            {
                LinearColorSpace = QualitySettings.activeColorSpace == ColorSpace.Linear
            };
            BoneAnimationState referenceState = new(skeleton.Asset.AnimationStateData);
            CommandBuffer buffer = new();
            referenceState.SetAnimation(0, AnimationIndex("walk"), true);
            referenceState.Apply(buffer);
            reference.Pose(buffer);
            reference.BuildMesh();

            List<Vector3> positions = new();
            List<Color32> colors = new();
            List<Vector2> uvs = new();
            skeleton.GetCpuVertices(positions, colors, uvs);
            Assert.AreEqual(reference.Counts.Vertices, positions.Count, "vertex count");
            Assert.That(Worst(positions, reference), Is.LessThanOrEqualTo(PositionTolerance),
                "the new animation's first pose was not applied in the same evaluation");

            // The next scheduled frame continues from that pose, one frame ahead of the reference.
            yield return Next();
            referenceState.Update(Time.deltaTime);
            reference.Time += Time.deltaTime;
            referenceState.Apply(buffer);
            reference.Pose(buffer);
            reference.BuildMesh();
            skeleton.GetCpuVertices(positions, colors, uvs);
            Assert.That(Worst(positions, reference), Is.LessThanOrEqualTo(PositionTolerance),
                "the frame after the clip start did not continue from the reapplied pose");
        }

        [UnityTest]
        public IEnumerator SecondClip_MixesFromTheFirst_WithTheAssetsMixDuration()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstAnimationMixer> mixer = BuildMixer(skeleton, 2);
            AddClip(mixer, 0, new BoneBurstAnimationBehaviour { Asset = m_Asset, animation = "walk", loop = true });
            AddClip(mixer, 1, new BoneBurstAnimationBehaviour { Asset = m_Asset, animation = "idle", loop = true });
            mixer.SetInputWeight(0, 1f);
            m_Graph.Evaluate(0);

            for (int i = 0; i < 10; i++) yield return Next();

            mixer.SetInputWeight(1, 1f);
            m_Graph.Evaluate(0);
            BoneTrackEntry entry = skeleton.AnimationState.GetTrack(0);
            Assert.AreEqual(AnimationIndex("idle"), entry.Animation);
            Assert.IsNotNull(entry.MixingFrom, "the second clip crossfades from the first");
            Assert.AreEqual(AnimationIndex("walk"), entry.MixingFrom.Animation);
            Assert.AreEqual(m_Asset.DefaultMix, entry.MixDuration, 1e-5f,
                "the mix duration comes from the asset's default mix");

            float mixTime = entry.MixTime;
            yield return Next();
            entry = skeleton.AnimationState.GetTrack(0);
            Assert.That(entry.MixTime, Is.GreaterThan(mixTime), "the mix advances on the game clock");
        }
    }
}