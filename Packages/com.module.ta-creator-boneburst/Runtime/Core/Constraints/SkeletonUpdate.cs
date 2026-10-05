using BoneBurst.Data;
using BoneBurst.Instance;

namespace BoneBurst.Constraints
{
    /// <summary>
    ///     <c>Skeleton.UpdateWorldTransform(physics)</c>: <c>Doc/Format/Constraints.md</c> §4.1. Copies the pose into
    ///     the applied pose, then walks the update cache: bones compute their world transform, constraints solve.
    /// </summary>
    /// <remarks>
    ///     The pose job and <see cref="ManagedPose" /> both call it. Every bone and constraint is copied, not only
    ///     the constrained ones; an unconstrained object's applied pose is its pose in the stock runtime, so the
    ///     values are the same.
    /// </remarks>
    public static unsafe class SkeletonUpdate
    {
        public static void UpdateWorldTransform(in InstanceHeader h, PhysicsMode physics)
        {
            h.Skeleton->Update++;
            int bones = h.Blob.BoneCount;
            for (int i = 0; i < bones; i++) h.Applied[i] = h.Local[i];
            for (int i = 0; i < h.Blob.ConstraintCount; i++) h.AppliedConstraints[i] = h.Constraints[i];
            if (h.AppliedSlots != h.Slots)
            {
                for (int i = 0; i < h.Blob.SlotCount; i++)
                {
                    h.AppliedSlots[i] = h.Slots[i];
                    h.AppliedDrawOrder[i] = h.DrawOrder[i];
                }

                for (int i = 0; i < h.Blob.DeformTotal; i++) h.AppliedDeform[i] = h.Deform[i];
            }

            for (int e = 0; e < h.CacheCount; e++)
            {
                int entry = h.Cache[e];
                if (entry >= 0)
                {
                    BoneSolve.Update(h, entry);
                    continue;
                }

                int c = ~entry;
                switch (h.Blob.ConstraintInfos[c].Kind)
                {
                    case ConstraintKind.Ik:
                        IkSolver.Update(h, c);
                        break;
                    case ConstraintKind.Transform:
                        TransformSolver.Update(h, c);
                        break;
                    case ConstraintKind.Path:
                        PathSolver.Update(h, c);
                        break;
                    case ConstraintKind.Physics:
                        PhysicsSolver.Update(h, c, physics);
                        break;
                    case ConstraintKind.Slider:
                        SliderSolver.Update(h, c);
                        break;
                }
            }
        }
    }
}