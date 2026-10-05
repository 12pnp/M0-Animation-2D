using System;
using UnityEngine;
using UnityEngine.Playables;
using UnityEngine.Timeline;

namespace BoneBurst.Timeline
{
    /// <summary>
    ///     The settings of one timeline clip: what to play on the bound skeleton's animation state when the clip
    ///     starts, and how to mix into it and out of it. Serialized as the clip asset's
    ///     <see cref="BoneBurstAnimationClip.template" />.
    /// </summary>
    [Serializable]
    public sealed class BoneBurstAnimationBehaviour : PlayableBehaviour
    {
        [Tooltip("The baked asset the key below is read from and whose mix durations apply. Only the clip's drawn " +
                 "length comes from it; playback resolves against the bound skeleton's own asset. The clip editor " +
                 "keeps it in sync with the track's binding.")]
        public BoneBurstAsset Asset;

        [Tooltip("The animation to play, by its baked key. Empty: the empty animation (a mix out to the setup pose).")]
        [BoneBurstKeyOf(BoneBurstKeyKind.Animation)]
        public BoneBurstKey animation = new();

        [Tooltip("Loop the animation while the clip lasts.")]
        public bool loop;

        [Header("Mixing")]
        [Tooltip("Use a mix duration of your own instead of the asset's mix for this animation pair.")]
        public bool customDuration = false;

        [Tooltip("Take the mix duration from the timeline clip's blend-in duration, so dragging clips into each " +
                 "other sets the crossfade length.")]
        public bool useBlendDuration = true;

        [Tooltip("Mix duration used when Use Blend Duration is off.")]
        public float mixDuration = 0.1f;

        [Header("End of clip")]
        [Tooltip("Keep playing when the director pauses, instead of freezing with it.")]
        public bool dontPauseWithDirector = false;

        [Tooltip("Keep playing after the clip ends, instead of mixing out to the empty animation.")]
        public bool dontEndWithClip = false;

        [Tooltip("Mix duration of the empty animation set at the clip's end. Below 0: pause the animation instead.")]
        public float endMixOutDuration = 0.1f;

        [Header("Track entry settings")]
        [Tooltip("See TrackEntry.MixAttachmentThreshold: attachments mix when the mix is below this.")]
        [Range(0, 1f)]
        public float attachmentThreshold = 0.5f;

        [Tooltip("See TrackEntry.EventThreshold: events fire while mixing out when the mix is below this.")]
        [Range(0, 1f)]
        public float eventThreshold = 0.5f;

        [Tooltip("See TrackEntry.MixDrawOrderThreshold: draw order mixes when the mix is below this.")]
        [Range(0, 1f)]
        public float drawOrderThreshold = 0.5f;

        [Tooltip("See TrackEntry.Alpha: the animation's opacity on its track.")]
        [Range(0, 1f)]
        public float alpha = 1.0f;

        [NonSerialized]
        public TimelineClip timelineClip;
    }
}