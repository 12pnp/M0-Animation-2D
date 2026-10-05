using UnityEditor;
using UnityEditor.Timeline;
using UnityEngine;
using UnityEngine.Timeline;

namespace BoneBurst.Timeline.Editor
{
    /// <summary>
    ///     The flip track's look: spine-unity's flip-track colour.
    /// </summary>
    [CustomTimelineEditor(typeof(BoneBurstFlipTrack))]
    [CanEditMultipleObjects]
    public sealed class BoneBurstFlipTrackEditor : TrackEditor
    {
        public override TrackDrawOptions GetTrackOptions(TrackAsset track, Object binding)
        {
            TrackDrawOptions options = base.GetTrackOptions(track, binding);
            options.trackColor = new Color(0.855f, 0.8623f, 0.87f);
            return options;
        }
    }
}