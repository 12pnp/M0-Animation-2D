using System;
using UnityEngine;
using UnityEngine.Playables;
using UnityEngine.Timeline;

namespace BoneBurst.Timeline
{
    /// <summary>
    ///     One animation on an <see cref="BoneBurstAnimationTrack" />: which baked animation key to play, and the
    ///     mix settings applied when the clip starts.
    /// </summary>
    [Serializable]
    public sealed class BoneBurstAnimationClip : PlayableAsset, ITimelineClipAsset
    {
        /// <summary>
        ///     The clip's settings, cloned into the clip's playable. The <c>Asset</c> field name is what
        ///     <c>BoneBurstKeyDrawer</c> reads the key popup's asset from.
        /// </summary>
        public BoneBurstAnimationBehaviour template = new();

        [NonSerialized]
        public TimelineClip timelineClip;

        /// <summary>
        ///     The animation's duration, so a new clip is drawn at the animation's length; 0 when the clip's asset or
        ///     key does not resolve.
        /// </summary>
        public override double duration =>
            BoneBurstAnimationLookup.TryGet(template.Asset, template.animation, out int _,
                out float duration)
                ? duration
                : 0;

        public ClipCaps clipCaps =>
            ClipCaps.Blending | ClipCaps.ClipIn | ClipCaps.SpeedMultiplier |
            (template.loop ? ClipCaps.Looping : 0);

        public override Playable CreatePlayable(PlayableGraph graph, GameObject owner)
        {
            template.timelineClip = timelineClip;
            return ScriptPlayable<BoneBurstAnimationBehaviour>.Create(graph, template);
        }
    }
}