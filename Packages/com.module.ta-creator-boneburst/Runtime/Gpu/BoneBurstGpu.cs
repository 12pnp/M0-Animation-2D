using System;
using System.Collections.Generic;
using BoneBurst.Blob;
using BoneBurst.Instance;
using Unity.Collections;
using Unity.Collections.LowLevel.Unsafe;
using Unity.Mathematics;
using UnityEngine;

namespace BoneBurst
{
    /// <summary>
    ///     The two global buffers GPU skinning reads (<c>Doc/Format/GpuSkinning.md</c> §2): <c>_BoneBurstPose</c>,
    ///     one pose record per GPU-skinned instance, uploaded once a frame over the range written; and
    ///     <c>_BoneBurstInfluences</c>, each blob's weighted influences, uploaded once when its first instance
    ///     goes GPU.
    /// </summary>
    /// <remarks>
    ///     Ranges are stable for an instance's life (a free list, first fit), so the renderer's shader user value
    ///     (its record base) changes only when the instance is re-added. Growing a buffer recreates it and
    ///     uploads everything.
    /// </remarks>
    public static unsafe class BoneBurstGpu
    {
        private static readonly int s_PoseId = Shader.PropertyToID("_BoneBurstPose");
        private static readonly int s_InfluencesId = Shader.PropertyToID("_BoneBurstInfluences");

        private static GraphicsBuffer s_Pose, s_Influences;
        private static NativeList<float4> s_PoseData, s_InfluenceData;
        private static readonly RangeAllocator s_PoseRanges = new(), s_InfluenceRanges = new();
        private static readonly Dictionary<SkeletonBlob, BlobEntry> s_Blobs = new();
        private static int s_DirtyMin = int.MaxValue, s_DirtyMax = -1;

        // Bumped by Dispose: ranges handed out before it are void.
        private static int s_Generation = 1;

        /// <summary>
        ///     The platform can read structured buffers in vertex shaders (shader model 4.5). Without it every
        ///     instance stays on the CPU path.
        /// </summary>
        public static bool IsSupported =>
            SystemInfo.supportsComputeShaders && SystemInfo.maxComputeBufferInputsVertex >= 2;

        /// <summary>
        ///     Float4s in use in the pose buffer. Diagnostic.
        /// </summary>
        public static int PoseCapacity => s_PoseData.IsCreated ? s_PoseData.Length : 0;

        /// <summary>
        ///     The CPU copy of the pose buffer; jobs write records into it.
        /// </summary>
        internal static NativeArray<float4> PoseData => s_PoseData.AsArray();

        /// <summary>
        ///     The CPU copy of the influence buffer. Tests read it.
        /// </summary>
        internal static NativeArray<float4> InfluenceData => s_InfluenceData.AsArray();

        /// <summary>
        ///     The pose buffer the shaders read (null before the first upload). Tests read it back.
        /// </summary>
        internal static GraphicsBuffer PoseBuffer => s_Pose;

        /// <summary>
        ///     Float4s uploaded by the last <see cref="Upload" />. Diagnostic.
        /// </summary>
        public static int LastUploadCount { get; private set; }

        /// <summary>
        ///     Gives the instance a pose record range (kept while its size fits) and its blob's influences. Main
        ///     thread, before the frame's jobs are scheduled.
        /// </summary>
        internal static void Attach(InstanceData data, bool tintBlack)
        {
            data.EnsureGpu();
            int size = GpuSkin.RecordSize(data.Blob.BoneCount, data.Blob.SlotCount, tintBlack);
            if (data.GpuBase >= 0 && data.GpuSize == size && data.GpuGeneration == s_Generation) return;
            Release(data);
            if (!s_PoseData.IsCreated) s_PoseData = new NativeList<float4>(1024, Allocator.Persistent);
            data.GpuBase = s_PoseRanges.Allocate(size);
            data.GpuSize = size;
            data.GpuGeneration = s_Generation;
            data.InvalidateGpuMesh();
            if (s_PoseRanges.Capacity > s_PoseData.Length)
                s_PoseData.Resize(s_PoseRanges.Capacity, NativeArrayOptions.ClearMemory);

            data.GpuInfluenceStart = Influences(data.Blob);
        }

        /// <summary>
        ///     Frees the instance's pose record range.
        /// </summary>
        internal static void Release(InstanceData data)
        {
            if (data.GpuBase < 0) return;
            if (data.GpuGeneration == s_Generation) s_PoseRanges.Free(data.GpuBase, data.GpuSize);
            data.GpuBase = -1;
            data.GpuSize = 0;
            data.InvalidateGpuMesh();
        }

        /// <summary>
        ///     The blob's per-attachment influence starts (absolute), uploading its influences on first use.
        /// </summary>
        internal static int* Influences(SkeletonBlob blob)
        {
            if (!s_Blobs.TryGetValue(blob, out BlobEntry entry))
            {
                int[] starts = new int[Math.Max(blob.Content.Attachments.Length, 1)];
                float4[] influences = GpuSkin.Influences(blob.Content, starts);
                entry = new BlobEntry { Count = influences.Length };
                if (!s_InfluenceData.IsCreated) s_InfluenceData = new NativeList<float4>(1024, Allocator.Persistent);
                entry.Base = influences.Length > 0 ? s_InfluenceRanges.Allocate(influences.Length) : 0;
                for (int i = 0; i < starts.Length; i++)
                    if (starts[i] >= 0)
                        starts[i] += entry.Base;

                entry.Starts = new NativeArray<int>(starts, Allocator.Persistent);
                if (s_InfluenceRanges.Capacity > s_InfluenceData.Length)
                    s_InfluenceData.Resize(s_InfluenceRanges.Capacity, NativeArrayOptions.ClearMemory);

                for (int i = 0; i < influences.Length; i++) s_InfluenceData[entry.Base + i] = influences[i];
                s_Blobs.Add(blob, entry);
                UploadInfluences(entry.Base, influences.Length);
            }

            return (int*)entry.Starts.GetUnsafeReadOnlyPtr();
        }

        /// <summary>
        ///     Frees a blob's influences, after every instance using it is gone.
        /// </summary>
        internal static void ReleaseBlob(SkeletonBlob blob)
        {
            if (!s_Blobs.TryGetValue(blob, out BlobEntry entry)) return;
            if (entry.Count > 0) s_InfluenceRanges.Free(entry.Base, entry.Count);
            entry.Starts.Dispose();
            s_Blobs.Remove(blob);
        }

        /// <summary>
        ///     Widens this frame's upload range to cover a record.
        /// </summary>
        internal static void MarkWritten(int start, int size)
        {
            s_DirtyMin = math.min(s_DirtyMin, start);
            s_DirtyMax = math.max(s_DirtyMax, start + size);
        }

        /// <summary>
        ///     Uploads the records written this frame (one <c>SetData</c> over their range).
        /// </summary>
        internal static void Upload()
        {
            if (s_DirtyMax < 0) return;
            int start = s_DirtyMin, count = s_DirtyMax - s_DirtyMin;
            s_DirtyMin = int.MaxValue;
            s_DirtyMax = -1;
            if (s_Pose == null || s_Pose.count < s_PoseData.Length)
            {
                s_Pose?.Release();
                s_Pose = new GraphicsBuffer(GraphicsBuffer.Target.Structured, math.max(s_PoseData.Capacity, 1),
                    sizeof(float4)) { name = "BoneBurst pose records" };
                Shader.SetGlobalBuffer(s_PoseId, s_Pose);
                start = 0;
                count = s_PoseData.Length;
            }

            s_Pose.SetData(s_PoseData.AsArray(), start, start, count);
            LastUploadCount = count;
        }

        private static void UploadInfluences(int start, int count)
        {
            if (s_Influences == null || s_Influences.count < s_InfluenceData.Length)
            {
                s_Influences?.Release();
                s_Influences = new GraphicsBuffer(GraphicsBuffer.Target.Structured,
                    math.max(s_InfluenceData.Capacity, 1), sizeof(float4)) { name = "BoneBurst influences" };
                Shader.SetGlobalBuffer(s_InfluencesId, s_Influences);
                start = 0;
                count = s_InfluenceData.Length;
            }

            if (count > 0) s_Influences.SetData(s_InfluenceData.AsArray(), start, start, count);
        }

        /// <summary>
        ///     Frees both buffers and every range. Instances still attached re-attach at their next GPU frame.
        /// </summary>
        internal static void Dispose()
        {
            s_Generation++;
            s_Pose?.Release();
            s_Influences?.Release();
            s_Pose = s_Influences = null;
            if (s_PoseData.IsCreated) s_PoseData.Dispose();
            if (s_InfluenceData.IsCreated) s_InfluenceData.Dispose();
            foreach (BlobEntry entry in s_Blobs.Values) entry.Starts.Dispose();
            s_Blobs.Clear();
            s_PoseRanges.Clear();
            s_InfluenceRanges.Clear();
            s_DirtyMin = int.MaxValue;
            s_DirtyMax = -1;
        }

        private sealed class BlobEntry
        {
            public int Base, Count;
            public NativeArray<int> Starts;
        }
    }

    /// <summary>
    ///     First-fit ranges over a growing array: freed ranges merge with their neighbours and are reused.
    /// </summary>
    public sealed class RangeAllocator
    {
        private readonly List<(int start, int size)> m_Free = new();

        /// <summary>
        ///     The array length every allocation fits in.
        /// </summary>
        public int Capacity { get; private set; }

        public int Allocate(int size)
        {
            for (int i = 0; i < m_Free.Count; i++)
            {
                (int start, int free) = m_Free[i];
                if (free < size) continue;
                if (free == size) m_Free.RemoveAt(i);
                else m_Free[i] = (start + size, free - size);
                return start;
            }

            int end = Capacity;
            Capacity += size;
            return end;
        }

        public void Free(int start, int size)
        {
            int at = 0;
            while (at < m_Free.Count && m_Free[at].start < start) at++;
            m_Free.Insert(at, (start, size));
            if (at + 1 < m_Free.Count && start + size == m_Free[at + 1].start)
            {
                m_Free[at] = (start, size + m_Free[at + 1].size);
                m_Free.RemoveAt(at + 1);
            }

            if (at > 0 && m_Free[at - 1].start + m_Free[at - 1].size == start)
            {
                m_Free[at - 1] = (m_Free[at - 1].start, m_Free[at - 1].size + m_Free[at].size);
                m_Free.RemoveAt(at);
            }
        }

        public void Clear()
        {
            m_Free.Clear();
            Capacity = 0;
        }
    }
}