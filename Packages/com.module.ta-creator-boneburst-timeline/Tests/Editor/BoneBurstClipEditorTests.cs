using BoneBurst.Timeline.Editor;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.Playables;
using UnityEngine.Timeline;

namespace BoneBurst.Timeline.Tests
{
    /// <summary>
    ///     The clip editor's asset sync: a clip with no asset takes the bound skeleton's asset, an asset that
    ///     disagrees with the binding is kept, and without a binding nothing is filled.
    /// </summary>
    /// <remarks>
    ///     The skeleton component never enables here — the sync reads only the binding and the asset field, so no
    ///     baked data is needed.
    /// </remarks>
    public class BoneBurstClipEditorTests
    {
        private BoneBurstAsset m_AssetA;
        private BoneBurstAsset m_AssetB;
        private TimelineClip m_Clip;
        private GameObject m_DirectorObject;
        private GameObject m_SkeletonObject;
        private TimelineAsset m_Timeline;

        private BoneBurstAnimationClip ClipAsset => (BoneBurstAnimationClip)m_Clip.asset;

        private PlayableDirector Director => m_DirectorObject.GetComponent<PlayableDirector>();

        [SetUp]
        public void SetUp()
        {
            m_AssetA = ScriptableObject.CreateInstance<BoneBurstAsset>();
            m_AssetA.name = "skeleton asset";
            m_AssetB = ScriptableObject.CreateInstance<BoneBurstAsset>();
            m_AssetB.name = "other asset";
            m_SkeletonObject = new GameObject("clip editor test skeleton");
            m_SkeletonObject.SetActive(false);
            BoneBurstSkeleton skeleton = m_SkeletonObject.AddComponent<BoneBurstSkeleton>();
            skeleton.Asset = m_AssetA;

            m_Timeline = ScriptableObject.CreateInstance<TimelineAsset>();
            BoneBurstAnimationTrack track = m_Timeline.CreateTrack<BoneBurstAnimationTrack>(null, "animation");
            m_Clip = track.CreateClip<BoneBurstAnimationClip>();
            m_DirectorObject = new GameObject("clip editor test director");
            PlayableDirector director = m_DirectorObject.AddComponent<PlayableDirector>();
            director.playableAsset = m_Timeline;
            director.SetGenericBinding(track, skeleton);
        }

        [TearDown]
        public void TearDown()
        {
            Object.DestroyImmediate(m_DirectorObject);
            Object.DestroyImmediate(m_SkeletonObject);
            Object.DestroyImmediate(m_Timeline);
            Object.DestroyImmediate(m_AssetA);
            Object.DestroyImmediate(m_AssetB);
        }

        [Test]
        public void EmptyAsset_IsFilledFromTheBoundSkeleton()
        {
            BoneBurstAnimationClipEditor.SyncAssetToBinding(m_Clip, Director);

            Assert.AreSame(m_AssetA, ClipAsset.template.Asset,
                "a new clip takes the bound skeleton's asset, so its key popup and duration are right");
        }

        [Test]
        public void DifferentAsset_IsKeptForTheAuthorToSee()
        {
            ClipAsset.template.Asset = m_AssetB;

            BoneBurstAnimationClipEditor.SyncAssetToBinding(m_Clip, Director);

            Assert.AreSame(m_AssetB, ClipAsset.template.Asset,
                "an assigned asset is never clobbered; the Inspector warns about the mismatch instead");
            Assert.AreSame(m_SkeletonObject.GetComponent<BoneBurstSkeleton>(),
                BoneBurstAnimationClipEditor.BoundSkeleton(m_Clip, Director),
                "the binding resolves to the track's skeleton");
        }

        [Test]
        public void WithoutABinding_NothingIsFilled()
        {
            Assert.IsNull(BoneBurstAnimationClipEditor.BoundSkeleton(m_Clip, null),
                "no director, no binding");

            BoneBurstAnimationClipEditor.SyncAssetToBinding(m_Clip, null);
            Assert.IsNull(ClipAsset.template.Asset, "without a director nothing is filled");

            TimelineClip unbound = m_Timeline.CreateTrack<BoneBurstAnimationTrack>(null, "unbound")
                .CreateClip<BoneBurstAnimationClip>();
            BoneBurstAnimationClipEditor.SyncAssetToBinding(unbound, Director);
            BoneBurstAnimationClip unboundAsset = (BoneBurstAnimationClip)unbound.asset;
            Assert.IsNull(unboundAsset.template.Asset, "a track with no binding fills nothing");
        }
    }
}