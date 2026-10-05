using System;
using UnityEngine.Playables;

namespace BoneBurst.Timeline
{
    /// <summary>
    ///     The settings of one flip clip: which axes are flipped while the clip has weight.
    /// </summary>
    [Serializable]
    public sealed class BoneBurstFlipBehaviour : PlayableBehaviour
    {
        public bool flipX;
        public bool flipY;
    }
}