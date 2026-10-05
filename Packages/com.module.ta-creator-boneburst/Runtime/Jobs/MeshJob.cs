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
    ///     Writes each dirty instance's CPU mesh into its persistent scratch lists (<see cref="InstanceData" />),
    ///     with a topology hash; the main thread uploads it into the existing <c>Mesh</c> buffers.
    /// </summary>
    /// <remarks>
    ///     16-bit indices whenever the skeleton has at most 65535 vertices. When the topology (everything but the
    ///     vertex data) equals last frame's, <see cref="MeshOutput.VerticesOnly" /> tells the main thread to upload
    ///     vertices only, into the buffers the mesh already has. Re-declaring the layout every frame, as a
    ///     <c>Mesh.MeshDataArray</c> apply does, made the render thread replace every mesh's GPU buffers
    ///     (profiled 2026-09-30: +5 ms render thread at 2000 skeletons). <see cref="Build" /> still writes a
    ///     <c>Mesh.MeshData</c> for the GPU path's per-frame CPU fallback.
    /// </remarks>
    [BurstCompile(FloatMode = FloatMode.Strict, FloatPrecision = FloatPrecision.Standard)]
    public unsafe struct MeshJob : IJobParallelFor
    {
        private const MeshUpdateFlags Flags = MeshUpdateFlags.DontRecalculateBounds |
                                              MeshUpdateFlags.DontValidateIndices |
                                              MeshUpdateFlags.DontNotifyMeshUsers | MeshUpdateFlags.DontResetBoneBounds;

        /// <summary>
        ///     Marks a vertex-fetch layout's submesh hash, so switching paths re-assigns the materials.
        /// </summary>
        private const int FetchHash = 0x3F7C_1D25;

        [ReadOnly]
        public NativeArray<InstanceHeader> Headers;

        [ReadOnly]
        public NativeArray<int> Rows;

        public void Execute(int index)
        {
            BuildScratch(Headers[Rows[index]]);
        }

        /// <summary>
        ///     One instance's CPU mesh into its scratch lists, and its <see cref="MeshOutput" /> with the topology.
        /// </summary>
        public static void BuildScratch(in InstanceHeader h)
        {
            MeshCounts counts = MeshBuilder.Measure(h);
            bool wide = counts.Vertices > ushort.MaxValue;
            // Vertex fetch when the instance's shared range fits this frame's vertices; otherwise the scratch, and
            // the main thread uploads into the Mesh (and grows the range for the next frame).
            bool fetched = h.FetchVertices != null && counts.Vertices <= h.FetchCapacity;
            SkeletonVertex* vertices;
            float4* tint = null;
            if (fetched)
            {
                vertices = h.FetchVertices;
                if (h.TintBlack) tint = h.FetchTint;
            }
            else
            {
                h.CpuVertices->Resize(counts.Vertices, NativeArrayOptions.UninitializedMemory);
                vertices = h.CpuVertices->Ptr;
                if (h.TintBlack)
                {
                    h.CpuTint->Resize(counts.Vertices, NativeArrayOptions.UninitializedMemory);
                    tint = h.CpuTint->Ptr;
                }
            }

            if (wide) h.CpuIndices32->Resize(counts.Indices, NativeArrayOptions.UninitializedMemory);
            else h.CpuIndices16->Resize(counts.Indices, NativeArrayOptions.UninitializedMemory);

            ushort* indices16 = wide ? null : h.CpuIndices16->Ptr;
            uint* indices32 = wide ? h.CpuIndices32->Ptr : null;
            MeshBuilder.Fill(h, counts, vertices, indices16, indices32, tint, out float3 min, out float3 max);
            MeshBuilder.Bounds(h, counts.Vertices, min, max, out float3 center, out float3 extents);

            int submeshHash = counts.Submeshes;
            // The fetch flag is part of the topology: the two paths give the Mesh different vertex layouts.
            uint topology = math.hash(new int4(counts.Vertices, counts.Indices, counts.Submeshes,
                (wide ? 1 : 0) | (h.TintBlack ? 2 : 0) | (fetched ? 4 : 0)));
            for (int s = 0; s < counts.Submeshes; s++)
            {
                submeshHash = submeshHash * 31 + h.SubmeshKeys[s];
                topology = math.hash(new uint3(topology, (uint)h.SubmeshIndexEnd[s], (uint)h.SubmeshKeys[s]));
            }

            int indexBytes = counts.Indices * (wide ? sizeof(uint) : sizeof(ushort));
            if (indexBytes > 0)
                topology = math.hash(new uint2(topology, math.hash(wide ? (void*)indices32 : indices16, indexBytes)));

            if (topology == 0) topology = 1;
            uint previous = h.Output->Topology;
            *h.Output = new MeshOutput
            {
                Min = min, Max = max, Center = center, Extents = extents, VertexCount = counts.Vertices,
                IndexCount = counts.Indices,
                SubmeshCount = counts.Submeshes, SubmeshHash = fetched ? submeshHash ^ FetchHash : submeshHash,
                Topology = topology,
                VerticesOnly = topology == previous, WideIndices = wide, TintStream = h.TintBlack, Fetched = fetched
            };
        }

        /// <summary>
        ///     One instance's CPU mesh into <paramref name="mesh" />, and its <see cref="MeshOutput" />.
        /// </summary>
        public static void Build(in InstanceHeader h, Mesh.MeshData mesh)
        {
            MeshCounts counts = MeshBuilder.Measure(h);

            int attributes = h.TintBlack ? 5 : 3;
            NativeArray<VertexAttributeDescriptor> layout = new(attributes, Allocator.Temp,
                NativeArrayOptions.UninitializedMemory);
            layout[0] = new VertexAttributeDescriptor(VertexAttribute.Position, VertexAttributeFormat.Float32, 3);
            layout[1] = new VertexAttributeDescriptor(VertexAttribute.Color, VertexAttributeFormat.UNorm8, 4);
            layout[2] = new VertexAttributeDescriptor(VertexAttribute.TexCoord0, VertexAttributeFormat.Float32, 2);
            if (h.TintBlack)
            {
                // Tint black on a second stream: uv2 (TEXCOORD1) and uv3 (TEXCOORD2), as spine-unity writes them.
                layout[3] = new VertexAttributeDescriptor(VertexAttribute.TexCoord1, VertexAttributeFormat.Float32, 2,
                    1);
                layout[4] = new VertexAttributeDescriptor(VertexAttribute.TexCoord2, VertexAttributeFormat.Float32, 2,
                    1);
            }

            mesh.SetVertexBufferParams(counts.Vertices, layout);
            bool wide = counts.Vertices > ushort.MaxValue;
            mesh.SetIndexBufferParams(counts.Indices, wide ? IndexFormat.UInt32 : IndexFormat.UInt16);

            SkeletonVertex* vertices = (SkeletonVertex*)mesh.GetVertexData<SkeletonVertex>().GetUnsafePtr();
            float4* tint = h.TintBlack ? (float4*)mesh.GetVertexData<float4>(1).GetUnsafePtr() : null;
            ushort* indices16 = wide ? null : (ushort*)mesh.GetIndexData<ushort>().GetUnsafePtr();
            uint* indices32 = wide ? (uint*)mesh.GetIndexData<uint>().GetUnsafePtr() : null;
            MeshBuilder.Fill(h, counts, vertices, indices16, indices32, tint, out float3 min, out float3 max);

            MeshBuilder.Bounds(h, counts.Vertices, min, max, out float3 center, out float3 extents);
            int hash = Submeshes(h, mesh, counts.Submeshes);
            *h.Output = new MeshOutput
            {
                Min = min, Max = max, Center = center, Extents = extents, VertexCount = counts.Vertices,
                IndexCount = counts.Indices,
                SubmeshCount = counts.Submeshes, SubmeshHash = hash
            };
        }

        /// <summary>
        ///     Sets the submeshes from the header's index ends; returns the hash of their material keys.
        /// </summary>
        internal static int Submeshes(in InstanceHeader h, Mesh.MeshData mesh, int count)
        {
            mesh.subMeshCount = count;
            int start = 0, hash = count;
            for (int s = 0; s < count; s++)
            {
                int end = h.SubmeshIndexEnd[s];
                mesh.SetSubMesh(s, new SubMeshDescriptor(start, end - start), Flags);
                start = end;
                hash = hash * 31 + h.SubmeshKeys[s];
            }

            return hash;
        }
    }
}