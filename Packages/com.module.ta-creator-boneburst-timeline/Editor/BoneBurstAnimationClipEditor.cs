using UnityEditor;
using UnityEditor.Timeline;
using UnityEngine.Playables;
using UnityEngine.Timeline;

namespace BoneBurst.Timeline.Editor
{
    /// <summary>
    ///     Keeps an animation clip's key-table asset filled from the track's bound skeleton, and flags a clip whose
    ///     asset disagrees with the binding.
    /// </summary>
    /// <remarks>
    ///     The fill happens on clip creation, when a clip or its track changes, and when the track's binding changes
    ///     (every empty clip of the track is filled), so a clip's key popup and drawn duration are right without
    ///     assigning anything. An asset that disagrees with the binding is kept — the author may have pointed the
    ///     clip at a variant with the same keys — and the clip shows the mismatch as its error text. Playback always
    ///     resolves keys against the bound skeleton, never the clip's asset.
    /// </remarks>
    [CustomTimelineEditor(typeof(BoneBurstAnimationClip))]
    public sealed class BoneBurstAnimationClipEditor : ClipEditor
    {
        public override void OnCreate(TimelineClip clip, TrackAsset track, TimelineClip clonedFrom)
        {
            SyncAssetToBinding(clip, TimelineEditor.inspectedDirector);
        }

        public override void OnClipChanged(TimelineClip clip)
        {
            SyncAssetToBinding(clip, TimelineEditor.inspectedDirector);
        }

        public override ClipDrawOptions GetClipOptions(TimelineClip clip)
        {
            ClipDrawOptions options = base.GetClipOptions(clip);
            BoneBurstAnimationClip asset = clip.asset as BoneBurstAnimationClip;
            BoneBurstSkeleton skeleton = BoundSkeleton(clip, TimelineEditor.inspectedDirector);
            if (asset != null && skeleton != null && skeleton.Asset != null &&
                asset.template.Asset != null && asset.template.Asset != skeleton.Asset)
                options.errorText =
                    $"This clip's keys come from '{asset.template.Asset.name}', but the bound skeleton " +
                    $"'{skeleton.name}' plays '{skeleton.Asset.name}'. Playback resolves keys against the bound skeleton.";

            return options;
        }

        /// <summary>
        ///     The skeleton this clip's track is bound to on <paramref name="director" />, or null.
        /// </summary>
        internal static BoneBurstSkeleton BoundSkeleton(TimelineClip clip, PlayableDirector director)
        {
            if (director == null) return null;
            BoneBurstAnimationTrack track = clip.GetParentTrack() as BoneBurstAnimationTrack;
            return track == null ? null : director.GetGenericBinding(track) as BoneBurstSkeleton;
        }

        /// <summary>
        ///     Gives a clip with no asset the bound skeleton's asset.
        /// </summary>
        internal static void SyncAssetToBinding(TimelineClip clip, PlayableDirector director)
        {
            BoneBurstAnimationClip asset = clip.asset as BoneBurstAnimationClip;
            if (asset == null || asset.template.Asset != null) return;
            BoneBurstSkeleton skeleton = BoundSkeleton(clip, director);
            if (skeleton == null || skeleton.Asset == null) return;
            asset.template.Asset = skeleton.Asset;
            EditorUtility.SetDirty(asset);
        }

        /// <summary>
        ///     Fills every empty clip of the track — the binding-changed hook, called by the track's editor.
        /// </summary>
        internal static void SyncTrackToBinding(TrackAsset track, PlayableDirector director)
        {
            foreach (TimelineClip clip in track.GetClips()) SyncAssetToBinding(clip, director);
        }
    }
}