using BoneBurst.Anim;
using BoneBurst.Constraints;
using BoneBurst.Instance;
using Unity.Burst;
using Unity.Collections;
using Unity.Jobs;

namespace BoneBurst.Jobs
{
    /// <summary>
    ///     Poses each dirty instance: optional reset to the setup pose, this frame's animation commands, then the
    ///     world update (bone world transforms and constraints, in update-cache order).
    /// </summary>
    /// <remarks>
    ///     One instance per work item: a skeleton's bones depend on their parents and its timelines on each other,
    ///     so the unit of parallelism is the skeleton. <c>FloatMode.Strict</c> keeps float results equal to the
    ///     stock runtime's (no FMA contraction, <c>Doc/Format/Pose-and-Mesh.md</c> §9).
    /// </remarks>
    [BurstCompile(FloatMode = FloatMode.Strict, FloatPrecision = FloatPrecision.Standard)]
    public unsafe struct PoseJob : IJobParallelFor
    {
        [ReadOnly]
        public NativeArray<InstanceHeader> Headers;

        [ReadOnly]
        public NativeArray<int> Rows;

        public void Execute(int index)
        {
            Pose(Headers[Rows[index]]);
        }

        /// <summary>
        ///     One instance's pose; <see cref="PoseMeshJob" /> runs it with the mesh in the same work item.
        /// </summary>
        public static void Pose(in InstanceHeader h)
        {
            if ((h.Flags & InstanceFlags.NeedsSetupPose) != 0)
                PoseMath.SetupPose(h.Blob.Bones, h.Local, h.Blob.BoneCount);

            *h.EventCount = 0;
            TimelineApply.ApplyAll(h);
            SkeletonUpdate.UpdateWorldTransform(h, h.Physics);
        }
    }
}