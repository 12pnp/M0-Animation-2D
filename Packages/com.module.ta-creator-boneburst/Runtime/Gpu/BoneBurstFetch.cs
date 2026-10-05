using System.Collections.Generic;
using BoneBurst.Instance;
using Unity.Burst;
using Unity.Collections;
using Unity.Collections.LowLevel.Unsafe;
using Unity.Jobs;
using Unity.Mathematics;
using Unity.Profiling;
using UnityEngine;

namespace BoneBurst
{
    /// <summary>
    ///     CPU skinning, GPU vertex fetch (<c>Doc/Format/CpuVertexFetch.md</c>): CPU-meshed instances write their
    ///     final vertices into one shared CPU list, which a parallel Burst job streams each frame into a GPU buffer
    ///     locked for writing (<c>_BoneBurstFetchVertices</c>, and <c>_BoneBurstFetchTint</c> for tint black). Each
    ///     renderer's <c>Mesh</c> keeps only its topology (indices, submeshes); the <c>BONE_BURST_FETCH</c> vertex
    ///     shader reads vertex <c>unity_RendererUserValue + SV_VertexID</c>.
    /// </summary>
    /// <remarks>
    ///     <para>
    ///         Vertex fetch replaces one <c>Mesh.SetVertexBufferData</c> per instance and the render thread's
    ///         per-mesh dynamic-buffer update (profiled 2026-09-30: 3.5 ms main thread and most of the render thread
    ///         at 2000 skeletons). Ranges are stable while an instance's vertex count fits; an instance that outgrows
    ///         its range takes the per-mesh upload path for that frame and gets a larger range at the next schedule.
    ///         Needs structured buffers in vertex shaders, as GPU skinning.
    ///     </para>
    ///     <para>
    ///         Upload: a <c>SetData</c> of the whole list cost 0.9 ms of main thread at 2000 skeletons (13 MB). Now
    ///         <see cref="BeginFrame" /> locks the next of <see cref="RingSize" /> GPU buffers
    ///         (<c>LockBufferForWrite</c>) and schedules <see cref="CopyJob" /> after the mesh job,
    ///         <see cref="ScheduleLate" /> copies the ranges written later (GPU fallbacks) in a job, and
    ///         <see cref="EndFrame" /> unlocks and binds it. A ring,
    ///         because a locked buffer may be GPU memory the previous frames are still drawing from; every used
    ///         vertex is copied each frame, because the buffer coming round again is <see cref="RingSize" /> frames
    ///         old.
    ///     </para>
    /// </remarks>
    public static unsafe class BoneBurstFetch
    {
        /// <summary>
        ///     GPU buffers in rotation: one written per frame while the GPU may still read the previous ones.
        /// </summary>
        public const int RingSize = 3;

        private const int CopyChunkBytes = 64 * 1024;
        private static readonly ProfilerMarker s_UploadMarker = new(ProfilerCategory.Scripts, "BoneBurst.FetchUpload");
        private static readonly int s_VerticesId = Shader.PropertyToID("_BoneBurstFetchVertices");
        private static readonly int s_TintId = Shader.PropertyToID("_BoneBurstFetchTint");

        private static readonly GraphicsBuffer[] s_VertexRing = new GraphicsBuffer[RingSize],
            s_TintRing = new GraphicsBuffer[RingSize];

        private static int s_RingCapacity, s_Slot = -1, s_LockedCount;
        private static bool s_Locked, s_TintSeen;
        private static NativeArray<SkeletonVertex> s_LockedVertices;
        private static NativeArray<float4> s_LockedTint;
        private static NativeList<SkeletonVertex> s_VertexData;
        private static NativeList<float4> s_TintData;

        private static readonly RangeAllocator s_Ranges = new();

        // Tint-black flags seen this frame (MarkTint); a first one uploads the tint list into every ring buffer.
        private static readonly List<(int start, int count, bool tint)> s_Late = new();

        // Bumped by Dispose: ranges handed out before it are void.
        private static int s_Generation = 1;

        /// <summary>
        ///     CPU-meshed instances use vertex fetch when the platform supports it. Off: every CPU mesh is uploaded
        ///     per instance (<see cref="BoneBurstSkeleton" />'s mesh then holds its vertices, as tests expect).
        /// </summary>
        public static bool Enabled { get; set; } = true;

        /// <summary>
        ///     Vertex fetch is on and the platform can read structured buffers in vertex shaders.
        /// </summary>
        public static bool Active => Enabled && BoneBurstGpu.IsSupported;

        /// <summary>
        ///     The CPU copy of the shared vertex list; tests read it.
        /// </summary>
        internal static NativeArray<SkeletonVertex> VertexData => s_VertexData.AsArray();

        /// <summary>
        ///     The CPU copy of the shared tint list (uv2.xy, uv3.xy per vertex); tests read it.
        /// </summary>
        internal static NativeArray<float4> TintData => s_TintData.AsArray();

        /// <summary>
        ///     The ring buffer bound by the last <see cref="EndFrame" /> (null before the first). Tests read it back.
        /// </summary>
        internal static GraphicsBuffer BoundVertexBuffer => s_Slot >= 0 ? s_VertexRing[s_Slot] : null;

        /// <summary>
        ///     Vertices streamed to the GPU by the last frame. Diagnostic.
        /// </summary>
        public static int LastUploadCount { get; private set; }

        /// <summary>
        ///     Gives the instance a range that fits the vertex count it last needed (with headroom), keeping the
        ///     current one while it fits. Main thread, before the frame's headers are built.
        /// </summary>
        internal static void Attach(InstanceData data)
        {
            int needed = data.FetchNeeded;
            if (needed <= 0) return; // first frame: the upload path measures it
            if (data.FetchBase >= 0 && data.FetchGeneration == s_Generation && data.FetchSize >= needed) return;
            Release(data);
            int size = needed + needed / 4 + 16;
            data.FetchBase = s_Ranges.Allocate(size);
            data.FetchSize = size;
            data.FetchGeneration = s_Generation;
            if (!s_VertexData.IsCreated)
            {
                s_VertexData = new NativeList<SkeletonVertex>(1024, Allocator.Persistent);
                s_TintData = new NativeList<float4>(1024, Allocator.Persistent);
            }

            if (s_Ranges.Capacity > s_VertexData.Length)
            {
                s_VertexData.Resize(s_Ranges.Capacity, NativeArrayOptions.ClearMemory);
                s_TintData.Resize(s_Ranges.Capacity, NativeArrayOptions.ClearMemory);
            }
        }

        internal static void Release(InstanceData data)
        {
            if (data.FetchBase < 0) return;
            if (data.FetchGeneration == s_Generation) s_Ranges.Free(data.FetchBase, data.FetchSize);
            data.FetchBase = -1;
            data.FetchSize = 0;
        }

        /// <summary>
        ///     Points the header at the instance's range. After every <see cref="Attach" /> of the frame, since an
        ///     attach may grow (move) the shared lists.
        /// </summary>
        internal static void Point(ref InstanceHeader header, InstanceData data)
        {
            if (data.FetchBase < 0 || data.FetchGeneration != s_Generation || !s_VertexData.IsCreated)
            {
                header.FetchVertices = null;
                header.FetchTint = null;
                header.FetchCapacity = 0;
                return;
            }

            header.FetchVertices = s_VertexData.GetUnsafePtr() + data.FetchBase;
            header.FetchTint = s_TintData.GetUnsafePtr() + data.FetchBase;
            header.FetchCapacity = data.FetchSize;
        }

        /// <summary>
        ///     Locks the next ring buffer and schedules the copy of every used vertex (and tint, once any instance
        ///     has used tint black) after <paramref name="writes" />, the frame's mesh job. Main thread, in
        ///     <see cref="BoneBurstSystem" />'s schedule, after every <see cref="Attach" />.
        /// </summary>
        internal static JobHandle BeginFrame(JobHandle writes)
        {
            int used = s_Ranges.Capacity;
            if (s_Locked || !s_VertexData.IsCreated || used == 0) return writes;
            if (s_RingCapacity < used) CreateRing();
            s_Slot = (s_Slot + 1) % RingSize;
            s_LockedCount = used;
            s_LockedVertices = s_VertexRing[s_Slot].LockBufferForWrite<SkeletonVertex>(0, used);
            s_LockedTint = s_TintSeen ? s_TintRing[s_Slot].LockBufferForWrite<float4>(0, used) : default;
            s_Locked = true;
            JobHandle copy = Schedule((byte*)s_VertexData.GetUnsafePtr(), (byte*)s_LockedVertices.GetUnsafePtr(),
                used * UnsafeUtility.SizeOf<SkeletonVertex>(), writes);
            if (!s_TintSeen) return copy;
            JobHandle tint = Schedule((byte*)s_TintData.GetUnsafePtr(), (byte*)s_LockedTint.GetUnsafePtr(),
                used * sizeof(float4), writes);
            return JobHandle.CombineDependencies(copy, tint);
        }

        /// <summary>
        ///     Schedules the copy of ranges written after the frame's copy job (GPU instances' CPU fallbacks, built
        ///     at complete) into the locked ring buffer, after <paramref name="writes" />. Each range is the
        ///     instance's whole fetch range: its vertex count is known only after the job, and copying an unused
        ///     range is harmless. The caller completes the handle and disposes <paramref name="ranges" />.
        /// </summary>
        internal static JobHandle ScheduleLate(NativeArray<int2> ranges, JobHandle writes)
        {
            if (!s_Locked || ranges.Length == 0) return writes;
            JobHandle vertices = new RangeCopyJob
            {
                Source = (byte*)s_VertexData.GetUnsafePtr(), Destination = (byte*)s_LockedVertices.GetUnsafePtr(),
                Stride = UnsafeUtility.SizeOf<SkeletonVertex>(), Ranges = ranges
            }.Schedule(ranges.Length, 8, writes);
            if (!s_TintSeen) return vertices;
            JobHandle tint = new RangeCopyJob
            {
                Source = (byte*)s_TintData.GetUnsafePtr(), Destination = (byte*)s_LockedTint.GetUnsafePtr(),
                Stride = sizeof(float4), Ranges = ranges
            }.Schedule(ranges.Length, 8, writes);
            return JobHandle.CombineDependencies(vertices, tint);
        }

        /// <summary>
        ///     The fetch range of an attached instance as (start, count), or count 0.
        /// </summary>
        internal static int2 RangeOf(InstanceData data)
        {
            return data.FetchBase >= 0 && data.FetchGeneration == s_Generation
                ? new int2(data.FetchBase, data.FetchSize)
                : int2.zero;
        }

        /// <summary>
        ///     After the frame's jobs (including <see cref="ScheduleLate" />): unlocks the ring buffer and binds it. A
        ///     frame that used tint black for the first time uploads the whole tint list once, into every ring buffer.
        /// </summary>
        internal static void EndFrame()
        {
            using ProfilerMarker.AutoScope scope = s_UploadMarker.Auto();
            bool firstTint = false;
            foreach ((int _, int _, bool tint) in s_Late) firstTint |= tint && !s_TintSeen;
            if (s_Locked)
            {
                s_VertexRing[s_Slot].UnlockBufferAfterWrite<SkeletonVertex>(s_LockedCount);
                if (s_TintSeen) s_TintRing[s_Slot].UnlockBufferAfterWrite<float4>(s_LockedCount);
                s_Locked = false;
                Shader.SetGlobalBuffer(s_VerticesId, s_VertexRing[s_Slot]);
                Shader.SetGlobalBuffer(s_TintId, s_TintRing[s_Slot]);
                LastUploadCount = s_LockedCount;
            }

            s_Late.Clear();
            if (!firstTint) return;
            // The first tint-black frame: every ring buffer gets the tint list, so the next frames' copies find it.
            s_TintSeen = true;
            foreach (GraphicsBuffer buffer in s_TintRing)
                buffer?.SetData(s_TintData.AsArray(), 0, 0, math.min(buffer.count, s_TintData.Length));
        }

        /// <summary>
        ///     Marks tint black in use from the mesh output of a frame's CPU-meshed instances, so the copy includes
        ///     tint from the next frame on.
        /// </summary>
        internal static void MarkTint(bool tint)
        {
            if (tint && !s_TintSeen) s_Late.Add((0, 0, true));
        }

        private static JobHandle Schedule(byte* source, byte* destination, int bytes, JobHandle dependency)
        {
            int chunks = (bytes + CopyChunkBytes - 1) / CopyChunkBytes;
            return new CopyJob { Source = source, Destination = destination, Bytes = bytes }.Schedule(chunks, 1,
                dependency);
        }

        private static void CreateRing()
        {
            int capacity = math.max(s_VertexData.Capacity, 1);
            for (int i = 0; i < RingSize; i++)
            {
                s_VertexRing[i]?.Release();
                s_TintRing[i]?.Release();
                s_VertexRing[i] = new GraphicsBuffer(GraphicsBuffer.Target.Structured,
                    GraphicsBuffer.UsageFlags.LockBufferForWrite, capacity, UnsafeUtility.SizeOf<SkeletonVertex>())
                {
                    name = $"BoneBurst fetch vertices {i}"
                };
                s_TintRing[i] = new GraphicsBuffer(GraphicsBuffer.Target.Structured,
                    GraphicsBuffer.UsageFlags.LockBufferForWrite, capacity, sizeof(float4))
                {
                    name = $"BoneBurst fetch tint {i}"
                };
            }

            s_RingCapacity = capacity;
            // New buffers hold nothing: the tint list goes into all of them at the next EndFrame.
            if (s_TintSeen)
            {
                s_TintSeen = false;
                s_Late.Add((0, 0, true));
            }
        }

        /// <summary>
        ///     Frees both buffers and every range. Instances re-attach at their next CPU-meshed frame.
        /// </summary>
        internal static void Dispose()
        {
            s_Generation++;
            if (s_Locked)
            {
                s_VertexRing[s_Slot].UnlockBufferAfterWrite<SkeletonVertex>(0);
                if (s_TintSeen) s_TintRing[s_Slot].UnlockBufferAfterWrite<float4>(0);
                s_Locked = false;
            }

            for (int i = 0; i < RingSize; i++)
            {
                s_VertexRing[i]?.Release();
                s_TintRing[i]?.Release();
                s_VertexRing[i] = s_TintRing[i] = null;
            }

            s_RingCapacity = 0;
            s_Slot = -1;
            s_TintSeen = false;
            s_Late.Clear();
            if (s_VertexData.IsCreated) s_VertexData.Dispose();
            if (s_TintData.IsCreated) s_TintData.Dispose();
            s_Ranges.Clear();
        }

        /// <summary>
        ///     Copies (start, count) element ranges of the shared list into the locked ring buffer, one per work item.
        /// </summary>
        [BurstCompile]
        private struct RangeCopyJob : IJobParallelFor
        {
            [NativeDisableUnsafePtrRestriction]
            public byte* Source;

            [NativeDisableUnsafePtrRestriction]
            public byte* Destination;

            public int Stride;

            [ReadOnly]
            public NativeArray<int2> Ranges;

            public void Execute(int index)
            {
                int2 range = Ranges[index];
                long offset = (long)range.x * Stride;
                UnsafeUtility.MemCpy(Destination + offset, Source + offset, (long)range.y * Stride);
            }
        }

        /// <summary>
        ///     Copies the shared list into the locked ring buffer, 64 KB per work item.
        /// </summary>
        [BurstCompile]
        private struct CopyJob : IJobParallelFor
        {
            [NativeDisableUnsafePtrRestriction]
            public byte* Source;

            [NativeDisableUnsafePtrRestriction]
            public byte* Destination;

            public int Bytes;

            public void Execute(int chunk)
            {
                long start = (long)chunk * CopyChunkBytes;
                long count = math.min(CopyChunkBytes, Bytes - start);
                UnsafeUtility.MemCpy(Destination + start, Source + start, count);
            }
        }
    }
}