using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Playables;
using UnityEngine.Timeline;
#if UNITY_EDITOR
using System.ComponentModel;
#endif

namespace BoneBurst.Timeline
{
    /// <summary>
    ///     Plays and mixes the track's clips on one track index of the bound <see cref="BoneBurstSkeleton" />'s
    ///     animation state, as spine-unity's SkeletonAnimation timeline track does for <c>SkeletonAnimation</c>.
    /// </summary>
    /// <remarks>
    ///     Order tracks base (track 0) at the top and overlay tracks below, as the spine-unity extension requires,
    ///     so later tracks' <c>SetAnimation</c> calls land after the base track's.
    /// </remarks>
    [TrackColor(255f / 255f, 64f / 255f, 1f / 255f)]
    [TrackClipType(typeof(BoneBurstAnimationClip))]
    [TrackBindingType(typeof(BoneBurstSkeleton))]
#if UNITY_EDITOR
    [DisplayName("BoneBurst/Animation Track")]
#endif
    public sealed class BoneBurstAnimationTrack : TrackAsset
    {
        [Tooltip("The animation-state track index the clips play on. When using several tracks, order them base " +
                 "track at the top and overlay tracks below.")]
        public int trackIndex = 0;

        [Tooltip("Whenever starting a clip of this track, BoneBurstSkeleton.UnscaledTime is set to this value, so " +
                 "clips play in normal or unscaled game time. PlayableDirector.UpdateMethod is ignored in favour of " +
                 "this, for control per track.")]
        public bool unscaledTime = false;

        public override Playable CreateTrackMixer(PlayableGraph graph, GameObject go, int inputCount)
        {
            IEnumerable<TimelineClip> clips = GetClips();
            foreach (TimelineClip clip in clips)
            {
                BoneBurstAnimationClip animationClip = clip.asset as BoneBurstAnimationClip;
                if (animationClip != null) animationClip.timelineClip = clip;
            }

            ScriptPlayable<BoneBurstAnimationMixer> scriptPlayable =
                ScriptPlayable<BoneBurstAnimationMixer>.Create(graph, inputCount);
            BoneBurstAnimationMixer mixer = scriptPlayable.GetBehaviour();
            mixer.trackIndex = trackIndex;
            mixer.unscaledTime = unscaledTime;
            return scriptPlayable;
        }
    }
}