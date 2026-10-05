using System;
using UnityEngine;
using UnityEngine.Playables;
using UnityEngine.Timeline;

namespace BoneBurst.Timeline
{
    /// <summary>
    ///     One flip on a <see cref="BoneBurstFlipTrack" />: the flip flags held for the clip's extent.
    /// </summary>
    [Serializable]
    public sealed class BoneBurstFlipClip : PlayableAsset, ITimelineClipAsset
    {
        public BoneBurstFlipBehaviour template = new();

        public ClipCaps clipCaps => ClipCaps.None;

        public override Playable CreatePlayable(PlayableGraph graph, GameObject owner)
        {
            return ScriptPlayable<BoneBurstFlipBehaviour>.Create(graph, template);
        }
    }
}