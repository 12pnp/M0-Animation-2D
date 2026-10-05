using BoneBurst.Instance;
using Unity.Burst;
using Unity.Collections;
using Unity.Collections.LowLevel.Unsafe;
using Unity.Jobs;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace BoneBurst.Jobs
{
    /// <summary>
    ///     Per GPU-skinned instance, after the pose job: decides this frame's path (<see cref="GpuSkin.Classify" />),
    ///     writes the pose record, and when the static mesh still fits, its bounds. A rebuild or a CPU fallback is
    ///     left to <see cref="LateMeshJob" />, which runs once the main thread has allocated those meshes.
    /// </summary>
    [BurstCompile(FloatMode = FloatMode.Strict, FloatPrecision = FloatPrecision.Standard)]
    public unsafe struct GpuJob : IJobParallelFor
    {
        [ReadOnly]
        public NativeArray<InstanceHeader> Headers;

        [ReadOnly]
        public NativeArray<int> Rows;

        /// <summary>
        ///     The pose buffer's CPU copy; each instance writes only its own range.
        /// </summary>
        [NativeDisableParallelForRestriction]
        public NativeArray<float4> Pose;

        public void Execute(int index)
        {
            InstanceHeader h = Headers[Rows[index]];
            GpuMeshState state = GpuSkin.Classify(h);
            h.Output->Gpu = state;
            // A CPU fallback keeps the CPU topology (consecutive fallbacks upload vertices only); a GPU frame owns
            // the Mesh, so the next CPU frame must re-declare its buffers.
            if (state == GpuMeshState.NeedsCpu) return;
            h.Output->Topology = 0;
            GpuSkin.WriteRecord(h, (float4*)Pose.GetUnsafePtr() + h.GpuBase);
            if (state != GpuMeshState.Reused) return;
            GpuSkin.Bounds(h, out float3 center, out float3 extents);
            h.Output->Center = center;
            h.Output->Extents = extents;
        }
    }

    /// <summary>
    ///     The static GPU mesh rebuilds <see cref="GpuJob" /> asked for. A frame that is not GPU-eligible
    ///     (<see cref="GpuMeshState.NeedsCpu" />) takes <see cref="MeshJob" /> and the in-place upload instead.
    /// </summary>
    [BurstCompile(FloatMode = FloatMode.Strict, FloatPrecision = FloatPrecision.Standard)]
    public unsafe struct LateMeshJob : IJobParallelFor
    {
        [ReadOnly]
        public NativeArray<InstanceHeader> Headers;

        [ReadOnly]
        public NativeArray<int> Rows;

        public Mesh.MeshDataArray Meshes;

        public void Execute(int index)
        {
            BuildGpu(Headers[Rows[index]], Meshes[index]);
        }

        /// <summary>
        ///     The static GPU mesh: stream 0 as the CPU mesh (local positions), stream 1 the skinning references
        ///     (<c>TEXCOORD3</c>). No clipping here, so <see cref="MeshBuilder.Count" /> sizes it.
        /// </summary>
        private static void BuildGpu(in InstanceHeader h, Mesh.MeshData mesh)
        {
            MeshCounts counts = MeshBuilder.Count(h, h.SubmeshKeys, h.SubmeshIndexEnd);
            NativeArray<VertexAttributeDescriptor> layout = new(4, Allocator.Temp,
                NativeArrayOptions.UninitializedMemory);
            layout[0] = new VertexAttributeDescriptor(VertexAttribute.Position, VertexAttributeFormat.Float32, 3);
            layout[1] = new VertexAttributeDescriptor(VertexAttribute.Color, VertexAttributeFormat.UNorm8, 4);
            layout[2] = new VertexAttributeDescriptor(VertexAttribute.TexCoord0, VertexAttributeFormat.Float32, 2);
            layout[3] = new VertexAttributeDescriptor(VertexAttribute.TexCoord3, VertexAttributeFormat.Float32, 4, 1);
            mesh.SetVertexBufferParams(counts.Vertices, layout);
            bool wide = counts.Vertices > ushort.MaxValue;
            mesh.SetIndexBufferParams(counts.Indices, wide ? IndexFormat.UInt32 : IndexFormat.UInt16);

            SkeletonVertex* vertices = (SkeletonVertex*)mesh.GetVertexData<SkeletonVertex>().GetUnsafePtr();
            float4* skin = (float4*)mesh.GetVertexData<float4>(1).GetUnsafePtr();
            ushort* indices16 = wide ? null : (ushort*)mesh.GetIndexData<ushort>().GetUnsafePtr();
            uint* indices32 = wide ? (uint*)mesh.GetIndexData<uint>().GetUnsafePtr() : null;
            GpuSkin.Build(h, vertices, skin, indices16, indices32);
            GpuSkin.Bounds(h, out float3 center, out float3 extents);
            if (counts.Vertices == 0) center = extents = float3.zero;
            int hash = MeshJob.Submeshes(h, mesh, counts.Submeshes);
            *h.Output = new MeshOutput
            {
                Center = center, Extents = extents, VertexCount = counts.Vertices, IndexCount = counts.Indices,
                SubmeshCount = counts.Submeshes, SubmeshHash = hash ^ GpuHash, Gpu = GpuMeshState.Built
            };
        }

        /// <summary>
        ///     Marks a GPU layout's submesh hash, so switching paths re-assigns the materials.
        /// </summary>
        private const int GpuHash = 0x5B0A_61C3;
    }
}