using BoneBurst.Instance;
using Unity.Burst;
using Unity.Collections;
using Unity.Jobs;

namespace BoneBurst.Jobs
{
    /// <summary>
    ///     Poses and CPU-meshes each instance in one work item: <see cref="PoseJob.Pose" /> then
    ///     <see cref="MeshJob.BuildScratch" />, the same code as the two separate jobs. One stage instead of two, so no
    ///     barrier between them, and the mesh reads a pose that is still in cache (Perf2 plan P1). Copying each
    ///     fetched mesh into the locked GPU ring buffer here as well (plan P1b) measured no gain and was reverted.
    /// </summary>
    [BurstCompile(FloatMode = FloatMode.Strict, FloatPrecision = FloatPrecision.Standard)]
    public struct PoseMeshJob : IJobParallelFor
    {
        [ReadOnly]
        public NativeArray<InstanceHeader> Headers;

        [ReadOnly]
        public NativeArray<int> Rows;

        public void Execute(int index)
        {
            InstanceHeader h = Headers[Rows[index]];
            PoseJob.Pose(h);
            MeshJob.BuildScratch(h);
        }
    }
}