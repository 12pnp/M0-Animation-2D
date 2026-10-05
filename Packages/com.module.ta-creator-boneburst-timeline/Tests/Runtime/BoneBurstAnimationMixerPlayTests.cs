using System;
using System.IO;
using System.Text.RegularExpressions;
using BoneBurst.Anim;
using BoneBurst.Data;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.Playables;
using UnityEngine.TestTools;
using Object = UnityEngine.Object;

namespace BoneBurst.Timeline.Tests
{
    /// <summary>
    ///     The animation mixer's play path, as unit tests in play mode (the edit-mode branch owns the Editor
    ///     scrubbing): clip starts call <c>SetAnimation</c> with the clip's time and settings, two clips starting
    ///     together apply in end-time order, empty clips and clip ends set the empty animation, director pause and
    ///     resume freeze and thaw only the timeline's own entry, and a key the skeleton lacks warns and changes
    ///     nothing.
    /// </summary>
    public class BoneBurstAnimationMixerPlayTests
    {
        private const string Samples =
            "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples";

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
            m_Object = new GameObject("BoneBurst timeline mixer play test");
            m_Object.SetActive(false);
            BoneBurstSkeleton component = m_Object.AddComponent<BoneBurstSkeleton>();
            component.Asset = m_Asset;
            m_Object.SetActive(true);
            return component;
        }

        private ScriptPlayable<BoneBurstAnimationMixer> BuildMixer(BoneBurstSkeleton skeleton, int inputs)
        {
            m_Graph = PlayableGraph.Create("BoneBurst timeline mixer play test");
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

        private float AnimationDuration(string name)
        {
            return m_Asset.Blob.Content.Animations[AnimationIndex(name)].Duration;
        }

        [Test]
        public void ClipStart_SetsAnimation_WithClipTimeLoopAndTrackEntrySettings()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstAnimationMixer> mixer = BuildMixer(skeleton, 1);
            BoneBurstAnimationBehaviour template = new()
            {
                Asset = m_Asset,
                animation = "walk",
                loop = true,
                eventThreshold = 0.3f,
                drawOrderThreshold = 0.4f,
                attachmentThreshold = 0.6f,
                alpha = 0.8f
            };
            ScriptPlayable<BoneBurstAnimationBehaviour> clip = AddClip(mixer, 0, template);
            clip.SetTime(0.25f);

            mixer.SetInputWeight(0, 1f);
            m_Graph.Evaluate(0);

            BoneTrackEntry entry = skeleton.AnimationState.GetTrack(0);
            Assert.IsNotNull(entry, "the clip start must have set an animation");
            Assert.AreEqual(AnimationIndex("walk"), entry.Animation);
            Assert.IsTrue(entry.Loop);
            Assert.AreEqual((float)clip.GetTime(), entry.TrackTime, 1e-4f, "the entry starts at the clip's time");
            Assert.AreEqual(1f, entry.TimeScale, 1e-5f, "clip speed 1 and root speed 1");
            Assert.AreEqual(0.3f, entry.EventThreshold, 1e-5f);
            Assert.AreEqual(0.4f, entry.MixDrawOrderThreshold, 1e-5f);
            Assert.AreEqual(0.6f, entry.MixAttachmentThreshold, 1e-5f);
            Assert.AreEqual(0.8f, entry.Alpha, 1e-5f);
        }

        [Test]
        public void TwoClipsStartingSameFrame_ClipEndingSoonerIsAppliedFirst()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstAnimationMixer> mixer = BuildMixer(skeleton, 2);
            float walkDuration = AnimationDuration("walk");
            float idleDuration = AnimationDuration("idle");
            // Input 0 holds the longer animation, so the mixer must swap the two before applying them.
            string longer = walkDuration > idleDuration ? "walk" : "idle";
            string shorter = walkDuration > idleDuration ? "idle" : "walk";

            ScriptPlayable<BoneBurstAnimationBehaviour> longClip =
                AddClip(mixer, 0, new BoneBurstAnimationBehaviour { Asset = m_Asset, animation = longer });
            ScriptPlayable<BoneBurstAnimationBehaviour> shortClip =
                AddClip(mixer, 1, new BoneBurstAnimationBehaviour { Asset = m_Asset, animation = shorter });
            longClip.SetDuration(Math.Max(walkDuration, idleDuration));
            shortClip.SetDuration(Math.Min(walkDuration, idleDuration));

            mixer.SetInputWeight(0, 1f);
            mixer.SetInputWeight(1, 1f);
            m_Graph.Evaluate(0);

            BoneTrackEntry entry = skeleton.AnimationState.GetTrack(0);
            Assert.AreEqual(AnimationIndex(longer), entry.Animation,
                "the clip ending later is applied last, so it is the current entry");
            Assert.IsNotNull(entry.MixingFrom);
            Assert.AreEqual(AnimationIndex(shorter), entry.MixingFrom.Animation,
                "the clip ending sooner is applied first, so it mixes out under the other");
        }

        [Test]
        public void EmptyKey_SetsEmptyAnimation_WithTheCustomMixDuration()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstAnimationMixer> mixer = BuildMixer(skeleton, 1);
            AddClip(mixer, 0, new BoneBurstAnimationBehaviour
            {
                Asset = m_Asset,
                customDuration = true,
                useBlendDuration = false,
                mixDuration = 0.3f
            });

            mixer.SetInputWeight(0, 1f);
            m_Graph.Evaluate(0);

            BoneTrackEntry entry = skeleton.AnimationState.GetTrack(0);
            Assert.IsNotNull(entry);
            Assert.IsTrue(entry.IsEmptyAnimation, "an empty key clip must set the empty animation");
            Assert.AreEqual(0.3f, entry.MixDuration, 1e-5f);
            Assert.AreEqual(0.3f, entry.TrackEnd, 1e-5f);
        }

        [Test]
        public void ClipEnd_WithDefaultSettings_MixesOutToTheEmptyAnimation()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstAnimationMixer> mixer = BuildMixer(skeleton, 1);
            AddClip(mixer, 0, new BoneBurstAnimationBehaviour { Asset = m_Asset, animation = "walk" });

            mixer.SetInputWeight(0, 1f);
            m_Graph.Evaluate(0);
            mixer.SetInputWeight(0, 0f);
            m_Graph.Evaluate(0);

            BoneTrackEntry entry = skeleton.AnimationState.GetTrack(0);
            Assert.IsNotNull(entry);
            Assert.IsTrue(entry.IsEmptyAnimation, "after the last clip the track mixes out to the empty animation");
            Assert.AreEqual(0.1f, entry.MixDuration, 1e-5f, "the end mix out duration");
        }

        [Test]
        public void ClipEnd_WithNegativeMixOut_PausesTheStartedEntry()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstAnimationMixer> mixer = BuildMixer(skeleton, 1);
            AddClip(mixer, 0, new BoneBurstAnimationBehaviour
            {
                Asset = m_Asset,
                animation = "walk",
                endMixOutDuration = -1f
            });

            mixer.SetInputWeight(0, 1f);
            m_Graph.Evaluate(0);
            mixer.SetInputWeight(0, 0f);
            m_Graph.Evaluate(0);

            BoneTrackEntry entry = skeleton.AnimationState.GetTrack(0);
            Assert.IsNotNull(entry);
            Assert.AreEqual(AnimationIndex("walk"), entry.Animation, "a negative mix out pauses instead of emptying");
            Assert.AreEqual(0f, entry.TimeScale, "the entry is frozen");
        }

        [Test]
        public void DirectorPause_FreezesTheStartedEntry_ResumeThawsIt()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstAnimationMixer> mixer = BuildMixer(skeleton, 1);
            AddClip(mixer, 0, new BoneBurstAnimationBehaviour { Asset = m_Asset, animation = "walk" });

            mixer.SetInputWeight(0, 1f);
            m_Graph.Evaluate(0);
            BoneBurstAnimationMixer behaviour = mixer.GetBehaviour();
            Assert.AreEqual(1f, skeleton.AnimationState.GetTrack(0).TimeScale);

            behaviour.OnBehaviourPause(mixer, default);
            Assert.AreEqual(0f, skeleton.AnimationState.GetTrack(0).TimeScale, "pause freezes the timeline's entry");

            behaviour.OnBehaviourPlay(mixer, default);
            Assert.AreEqual(1f, skeleton.AnimationState.GetTrack(0).TimeScale, "resume restores the time scale");
        }

        [Test]
        public void DirectorPause_WithDontPauseWithDirector_LeavesTheEntryRunning()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstAnimationMixer> mixer = BuildMixer(skeleton, 1);
            AddClip(mixer, 0, new BoneBurstAnimationBehaviour
            {
                Asset = m_Asset,
                animation = "walk",
                dontPauseWithDirector = true
            });

            mixer.SetInputWeight(0, 1f);
            m_Graph.Evaluate(0);
            mixer.GetBehaviour().OnBehaviourPause(mixer, default);

            Assert.AreEqual(1f, skeleton.AnimationState.GetTrack(0).TimeScale,
                "dontPauseWithDirector opts the clip out of freezing");
        }

        [Test]
        public void KeyTheSkeletonDoesNotHave_WarnsAndKeepsThePreviousAnimation()
        {
            BoneBurstSkeleton skeleton = Spawn();
            ScriptPlayable<BoneBurstAnimationMixer> mixer = BuildMixer(skeleton, 2);
            AddClip(mixer, 0, new BoneBurstAnimationBehaviour { Asset = m_Asset, animation = "walk" });
            mixer.SetInputWeight(0, 1f);
            m_Graph.Evaluate(0);
            BoneTrackEntry started = skeleton.AnimationState.GetTrack(0);
            float trackTime = started.TrackTime;

            AddClip(mixer, 1, new BoneBurstAnimationBehaviour { Asset = m_Asset, animation = "does-not-exist" });
            mixer.SetInputWeight(1, 1f);
            LogAssert.Expect(LogType.Warning, new Regex("does-not-exist"));
            m_Graph.Evaluate(0);

            BoneTrackEntry entry = skeleton.AnimationState.GetTrack(0);
            Assert.AreSame(started, entry, "a key the skeleton lacks must not interrupt the running animation");
            Assert.AreEqual(trackTime, entry.TrackTime, "and must not move its time");
        }
    }
}