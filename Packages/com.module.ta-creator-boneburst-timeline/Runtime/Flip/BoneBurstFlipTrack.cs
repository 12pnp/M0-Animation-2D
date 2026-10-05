using UnityEditor;
using UnityEngine;
using UnityEngine.Playables;
using UnityEngine.Timeline;
#if UNITY_EDITOR
using System.ComponentModel;
#endif

namespace BoneBurst.Timeline
{
    /// <summary>
    ///     Flips the bound <see cref="BoneBurstSkeleton" /> over the extent of each clip, as spine-unity's Skeleton
    ///     Flip track does: the clip with the greatest weight wins, and the flip the skeleton had when the track
    ///     started is restored when no clip dominates and when the timeline stops.
    /// </summary>
    [TrackColor(0.855f, 0.8623f, 0.87f)]
    [TrackClipType(typeof(BoneBurstFlipClip))]
    [TrackBindingType(typeof(BoneBurstSkeleton))]
#if UNITY_EDITOR
    [DisplayName("BoneBurst/Flip Track")]
#endif
    public sealed class BoneBurstFlipTrack : TrackAsset
    {
        public override Playable CreateTrackMixer(PlayableGraph graph, GameObject go, int inputCount)
        {
            return ScriptPlayable<BoneBurstFlipMixer>.Create(graph, inputCount);
        }

        public override void GatherProperties(PlayableDirector director, IPropertyCollector driver)
        {
#if UNITY_EDITOR
            BoneBurstSkeleton trackBinding = director.GetGenericBinding(this) as BoneBurstSkeleton;
            if (trackBinding == null) return;

            // Every serialized leaf of the binding is registered, so the Timeline window restores what the edit-mode
            // preview changed (the flip fields) when the playhead leaves the track's clips.
            SerializedObject serializedObject = new(trackBinding);
            SerializedProperty iterator = serializedObject.GetIterator();
            while (iterator.NextVisible(true))
            {
                if (iterator.hasVisibleChildren) continue;

                driver.AddFromName<BoneBurstSkeleton>(trackBinding.gameObject, iterator.propertyPath);
            }
#endif
            base.GatherProperties(director, driver);
        }
    }
}