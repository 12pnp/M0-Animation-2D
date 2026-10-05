using System;
using System.Collections;
using System.IO;
using BoneBurst.Anim;
using BoneBurst.Data;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.Playables;
using UnityEngine.TestTools;
using UnityEngine.Timeline;
using Object = UnityEngine.Object;

namespace BoneBurst.Timeline.Tests
{
    /// <summary>
    ///     A real <see cref="PlayableDirector" /> playing a real <see cref="TimelineAsset" /> (built in memory, the
    ///     same shape as the demo timeline) drives a live skeleton end to end: the first clip starts, the second
    ///     crossfades over the first when the clips overlap, and a flip clip flips while it has weight.
    /// </summary>
    public class BoneBurstDirectorPlayTests
    {
        private const string Samples =
            "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples";

        private BoneBurstAsset m_Asset;
        private GameObject m_DirectorObject;

        private GameObject m_Object;
        private TimelineAsset m_Timeline;

        [TearDown]
        public void TearDown()
        {
            if (m_DirectorObject != null) Object.Destroy(m_DirectorObject);
            if (m_Object != null) Object.Destroy(m_Object);
            if (m_Timeline != null)
            {
                foreach (TrackAsset track in m_Timeline.GetOutputTracks())
                foreach (TimelineClip clip in track.GetClips())
                    Object.Destroy(clip.asset);

                Object.Destroy(m_Timeline);
            }

            if (m_Asset != null) Object.Destroy(m_Asset);
        }

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
            m_Object = new GameObject("BoneBurst director play test");
            m_Object.SetActive(false);
            BoneBurstSkeleton component = m_Object.AddComponent<BoneBurstSkeleton>();
            component.Asset = m_Asset;
            m_Object.SetActive(true);
            return component;
        }

        private BoneBurstAnimationBehaviour Template(string animation, bool loop)
        {
            return new BoneBurstAnimationBehaviour { Asset = m_Asset, animation = animation, loop = loop };
        }

        [UnityTest]
        public IEnumerator RealTimeline_CrossfadesAtTheOverlap_AndFlipsWhileTheClipHasWeight()
        {
            BoneBurstSkeleton skeleton = Spawn();
            for (int i = 0; i < 2; i++) yield return Next();

            // The demo timeline's shape: idle, then walk blending in over a 0.4 s overlap, and a flip clip.
            m_Timeline = ScriptableObject.CreateInstance<TimelineAsset>();
            BoneBurstAnimationTrack baseTrack = m_Timeline.CreateTrack<BoneBurstAnimationTrack>(null, "base");
            baseTrack.trackIndex = 0;
            TimelineClip idleClip = baseTrack.CreateClip<BoneBurstAnimationClip>();
            idleClip.displayName = "idle";
            idleClip.start = 0;
            idleClip.duration = 1.6;
            idleClip.blendOutDuration = 0.4;
            ((BoneBurstAnimationClip)idleClip.asset).template = Template("idle", true);
            TimelineClip walkClip = baseTrack.CreateClip<BoneBurstAnimationClip>();
            walkClip.displayName = "walk";
            walkClip.start = 1.2;
            walkClip.duration = 1.8;
            walkClip.blendInDuration = 0.4;
            ((BoneBurstAnimationClip)walkClip.asset).template = Template("walk", true);
            BoneBurstFlipTrack flipTrack = m_Timeline.CreateTrack<BoneBurstFlipTrack>(null, "flip");
            TimelineClip flipClip = flipTrack.CreateClip<BoneBurstFlipClip>();
            flipClip.displayName = "flipX";
            flipClip.start = 2.2;
            flipClip.duration = 0.8;
            ((BoneBurstFlipClip)flipClip.asset).template.flipX = true;

            m_DirectorObject = new GameObject("director");
            PlayableDirector director = m_DirectorObject.AddComponent<PlayableDirector>();
            director.playableAsset = m_Timeline;
            director.SetGenericBinding(baseTrack, skeleton);
            director.SetGenericBinding(flipTrack, skeleton);

            yield return Next();
            director.Play();

            int walkIndex = Array.FindIndex(m_Asset.Blob.Skeleton.Animations, a => a.Name == "walk");
            int idleIndex = Array.FindIndex(m_Asset.Blob.Skeleton.Animations, a => a.Name == "idle");

            yield return Next();
            BoneTrackEntry entry = skeleton.AnimationState.GetTrack(0);
            Assert.IsNotNull(entry, "the director's first frame must have started the idle clip");
            Assert.AreEqual(idleIndex, entry.Animation);

            // Inside the overlap and the default-mix window: walk is mixing over idle.
            while (director.time < 1.3f)
            {
                Assert.That(director.time, Is.LessThan(4f), "the director stopped advancing");
                yield return Next();
            }

            entry = skeleton.AnimationState.GetTrack(0);
            Assert.AreEqual(walkIndex, entry.Animation, "the overlapping walk clip took over");
            Assert.IsNotNull(entry.MixingFrom, "walk crossfades from idle while the mix runs");
            Assert.AreEqual(idleIndex, entry.MixingFrom.Animation);
            Assert.AreEqual(m_Asset.DefaultMix, entry.MixDuration, 1e-5f,
                "without a custom duration the asset's default mix paces the crossfade");
            Assert.That(entry.TrackTime,
                Is.EqualTo(director.time - walkClip.start).Within(0.05f),
                "the entry runs at the clip's position on the timeline");

            // Past the mix and into the flip window: idle has ended, walk stands alone, the flip is on.
            while (director.time < 2.4f) yield return Next();

            entry = skeleton.AnimationState.GetTrack(0);
            Assert.AreEqual(walkIndex, entry.Animation);
            Assert.IsNull(entry.MixingFrom, "the finished crossfade ended idle, as stock AnimationState does");
            Assert.IsTrue(skeleton.FlipX, "the flip clip has weight, so the skeleton is flipped");
        }
    }
}