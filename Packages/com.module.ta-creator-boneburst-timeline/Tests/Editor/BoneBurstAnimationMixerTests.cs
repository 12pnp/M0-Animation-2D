using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
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
    ///     The animation mixer's Edit-mode branch: scrubbing pins the playhead clip on the real animation state at
    ///     the clip's time, leaves the instance dirty for the Editor's preview driver (posed here through the same
    ///     zero-delta tick the driver runs), and a rebuild drops the scrub — the property that keeps edit-time
    ///     mutation out of Play mode.
    /// </summary>
    /// <remarks>
    ///     A hand-built <see cref="PlayableGraph" /> stands in for the Timeline: each clip is a
    ///     <see cref="BoneBurstAnimationBehaviour" /> playable connected to the mixer, the output's
    ///     <c>UserData</c> is the bound skeleton, and <c>Evaluate(0)</c> runs <c>ProcessFrame</c>.
    /// </remarks>
    public class BoneBurstAnimationMixerTests
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
            if (m_Object != null) Object.DestroyImmediate(m_Object);
            if (m_Asset != null) Object.DestroyImmediate(m_Asset);
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
            m_Object = new GameObject("BoneBurst timeline mixer test");
            m_Object.SetActive(false);
            BoneBurstSkeleton component = m_Object.AddComponent<BoneBurstSkeleton>();
            component.Asset = m_Asset;
            m_Object.SetActive(true);
            return component;
        }

        private ScriptPlayable<BoneBurstAnimationMixer> BuildMixer(BoneBurstSkeleton skeleton, int inputs)
        {
            m_Graph = PlayableGraph.Create("BoneBurst timeline mixer test");
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

        /// <summary>
        ///     What <c>BoneBurstEditModePreview.Tick</c> does: one zero-delta frame when work is pending.
        /// </summary>
        private static void DriverTick()
        {
            if (!BoneBurstSystem.HasPendingWork) return;
            BoneBurstSystem.Schedule(0);
            BoneBurstSystem.Complete();
        }

        [Test]
        public void Scrubbing_SetsTheClipOnTheRealState_AtTheClipTime_AndLeavesWorkPending()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstAnimationMixer> mixer = BuildMixer(skeleton, 1);
            ScriptPlayable<BoneBurstAnimationBehaviour> clip = AddClip(mixer, 0,
                new BoneBurstAnimationBehaviour { Asset = m_Asset, animation = "walk", loop = true });
            clip.SetTime(0.4f);

            mixer.SetInputWeight(0, 1f);
            m_Graph.Evaluate(0);

            BoneTrackEntry entry = skeleton.AnimationState.GetTrack(0);
            Assert.IsNotNull(entry, "the scrub must set the clip on the real animation state");
            Assert.AreEqual(AnimationIndex("walk"), entry.Animation);
            Assert.IsTrue(entry.Loop);
            Assert.AreEqual(0.4f, entry.TrackTime, 1e-4f, "the entry is pinned at the clip's time");

            Assert.IsTrue(BoneBurstSystem.HasPendingWork, "the scrub must leave the instance dirty for the driver");
            DriverTick();
            Assert.AreEqual(1, BoneBurstSystem.LastFrameMeshed, "the driver tick posed and meshed the skeleton");
        }

        [Test]
        public void Scrubbing_MovingThePlayhead_MovesTheSameEntry()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstAnimationMixer> mixer = BuildMixer(skeleton, 1);
            ScriptPlayable<BoneBurstAnimationBehaviour> clip = AddClip(mixer, 0,
                new BoneBurstAnimationBehaviour { Asset = m_Asset, animation = "walk", loop = true });

            clip.SetTime(0.4f);
            mixer.SetInputWeight(0, 1f);
            m_Graph.Evaluate(0);
            BoneTrackEntry first = skeleton.AnimationState.GetTrack(0);

            clip.SetTime(0.9f);
            m_Graph.Evaluate(0);

            BoneTrackEntry entry = skeleton.AnimationState.GetTrack(0);
            Assert.AreSame(first, entry, "scrubbing within one clip moves the entry, it does not restart it");
            Assert.AreEqual(0.9f, entry.TrackTime, 1e-4f);
        }

        [Test]
        public void Scrubbing_ToAnotherClip_SwitchesWithoutAMixChain()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstAnimationMixer> mixer = BuildMixer(skeleton, 2);
            AddClip(mixer, 0, new BoneBurstAnimationBehaviour { Asset = m_Asset, animation = "walk", loop = true });
            AddClip(mixer, 1, new BoneBurstAnimationBehaviour { Asset = m_Asset, animation = "idle", loop = true });

            mixer.SetInputWeight(0, 1f);
            m_Graph.Evaluate(0);

            mixer.SetInputWeight(1, 1f);
            m_Graph.Evaluate(0);

            BoneTrackEntry entry = skeleton.AnimationState.GetTrack(0);
            Assert.AreEqual(AnimationIndex("idle"), entry.Animation,
                "the last clip with weight is the one under the playhead");
            Assert.IsNull(entry.MixingFrom, "the scrub shows the clip as it is, with no crossfade bookkeeping");
        }

        [Test]
        public void ScrubbedClip_PosesThroughTheDriverTick_LikeTheManagedReference()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstAnimationMixer> mixer = BuildMixer(skeleton, 1);
            ScriptPlayable<BoneBurstAnimationBehaviour> clip = AddClip(mixer, 0,
                new BoneBurstAnimationBehaviour { Asset = m_Asset, animation = "walk", loop = true });
            clip.SetTime(0.5f);

            mixer.SetInputWeight(0, 1f);
            m_Graph.Evaluate(0);
            DriverTick();

            // What the Scene view then shows: walk at the scrub time, like this managed reference.
            ManagedPose reference = new(m_Asset.Blob.Content, -1)
            {
                LinearColorSpace = QualitySettings.activeColorSpace == ColorSpace.Linear
            };
            BoneAnimationState referenceState = new(m_Asset.AnimationStateData);
            CommandBuffer buffer = new();
            BoneTrackEntry referenceEntry = referenceState.SetAnimation(0, AnimationIndex("walk"), true);
            referenceEntry.TrackTime = 0.5f;
            referenceState.Apply(buffer);
            reference.Pose(buffer);
            reference.BuildMesh();

            List<Vector3> positions = new();
            List<Color32> colors = new();
            List<Vector2> uvs = new();
            skeleton.GetCpuVertices(positions, colors, uvs);
            Assert.AreEqual(reference.Counts.Vertices, positions.Count, "vertex count");
            float worst = 0;
            for (int i = 0; i < positions.Count; i++)
                worst = Mathf.Max(worst, Mathf.Abs(positions[i].x - reference.Vertices[i].Position.x),
                    Mathf.Abs(positions[i].y - reference.Vertices[i].Position.y));

            Assert.That(worst, Is.LessThanOrEqualTo(PositionTolerance),
                $"the driver tick did not pose the scrubbed clip; largest difference {worst}");
        }

        [Test]
        public void EmptyKey_ClearsTheTrack()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstAnimationMixer> mixer = BuildMixer(skeleton, 2);
            ScriptPlayable<BoneBurstAnimationBehaviour> walk = AddClip(mixer, 0,
                new BoneBurstAnimationBehaviour { Asset = m_Asset, animation = "walk", loop = true });
            ScriptPlayable<BoneBurstAnimationBehaviour> empty = AddClip(mixer, 1,
                new BoneBurstAnimationBehaviour { Asset = m_Asset });
            mixer.SetInputWeight(0, 1f);
            m_Graph.Evaluate(0);
            Assert.IsNotNull(skeleton.AnimationState.GetTrack(0));

            mixer.SetInputWeight(0, 0f);
            mixer.SetInputWeight(1, 1f);
            m_Graph.Evaluate(0);

            Assert.IsNull(skeleton.AnimationState.GetTrack(0), "an empty clip leaves the track empty in the preview");
        }

        [Test]
        public void KeyTheSkeletonLacks_WarnsAndLeavesTheTrackAlone()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstAnimationMixer> mixer = BuildMixer(skeleton, 1);
            AddClip(mixer, 0,
                new BoneBurstAnimationBehaviour { Asset = m_Asset, animation = "does-not-exist", loop = true });

            mixer.SetInputWeight(0, 1f);
            LogAssert.Expect(LogType.Warning, new Regex("does-not-exist"));
            m_Graph.Evaluate(0);

            Assert.IsNull(skeleton.AnimationState.GetTrack(0), "a key the skeleton lacks sets nothing");
        }

        [Test]
        public void Scrubbing_DoesNotOutliveTheInstance_ARebuildDropsIt()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstAnimationMixer> mixer = BuildMixer(skeleton, 1);
            ScriptPlayable<BoneBurstAnimationBehaviour> clip = AddClip(mixer, 0,
                new BoneBurstAnimationBehaviour { Asset = m_Asset, animation = "walk", loop = true });
            clip.SetTime(0.4f);
            mixer.SetInputWeight(0, 1f);
            m_Graph.Evaluate(0);
            Assert.IsNotNull(skeleton.AnimationState.GetTrack(0));

            // Entering Play mode and an Inspector change both rebuild the instance from serialized fields
            // (BoneBurstEditModePreview calls Uninstall; OnValidate queues RestartPreview).
            skeleton.RestartPreview();

            Assert.IsNull(skeleton.AnimationState.GetTrack(0),
                "the rebuilt instance plays only its serialized start animation, not the scrub");
            Assert.IsTrue(skeleton.Animation.IsEmpty, "the scrub never wrote the serialized start animation key");
            DriverTick();
            Assert.AreEqual(1, BoneBurstSystem.LastFrameMeshed, "the rebuilt instance is meshed again");
        }
    }
}