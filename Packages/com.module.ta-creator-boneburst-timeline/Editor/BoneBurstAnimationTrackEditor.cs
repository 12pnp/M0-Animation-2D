using UnityEditor;
using UnityEditor.Timeline;
using UnityEngine;
using UnityEngine.Timeline;

namespace BoneBurst.Timeline.Editor
{
    /// <summary>
    ///     The animation track's look: spine-unity's animation-track colour. No custom icon for v1 — none exists to
    ///     reuse and the default glyph reads fine.
    /// </summary>
    [CustomTimelineEditor(typeof(BoneBurstAnimationTrack))]
    [CanEditMultipleObjects]
    public sealed class BoneBurstAnimationTrackEditor : TrackEditor
    {
        public override TrackDrawOptions GetTrackOptions(TrackAsset track, Object binding)
        {
            TrackDrawOptions options = base.GetTrackOptions(track, binding);
            options.trackColor = new Color(255f / 255f, 64f / 255f, 1f / 255f);
            return options;
        }

        public override void OnTrackChanged(TrackAsset track)
        {
            BoneBurstAnimationClipEditor.SyncTrackToBinding(track, TimelineEditor.inspectedDirector);
            base.OnTrackChanged(track);
        }
    }
}