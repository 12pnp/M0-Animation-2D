using BoneBurst.Anim;
using BoneBurst.Constraints;

namespace BoneBurst.Instance
{
    /// <summary>
    ///     The pose step of one instance: setup pose when asked, then the applied animations, then the world
    ///     transforms. Both runtimes (the MonoBehaviour front's <c>PoseJob</c> and the ECS pose job) call it, so the
    ///     order lives in one place.
    /// </summary>
    public static unsafe class PoseStep
    {
        public static void Run(in InstanceHeader h)
        {
            if ((h.Flags & InstanceFlags.NeedsSetupPose) != 0)
                PoseMath.SetupPose(h.Blob.Bones, h.Local, h.Blob.BoneCount);

            *h.EventCount = 0;
            TimelineApply.ApplyAll(h);
            SkeletonUpdate.UpdateWorldTransform(h, h.Physics);
        }
    }
}
