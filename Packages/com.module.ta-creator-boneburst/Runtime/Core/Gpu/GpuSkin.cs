using System.Collections.Generic;
using BoneBurst.Blob;
using BoneBurst.Data;
using BoneBurst.Instance;
using Unity.Mathematics;

namespace BoneBurst
{
    /// <summary>
    ///     What happened to a GPU-skinned instance's mesh this frame (<c>Doc/Format/GpuSkinning.md</c> §3).
    /// </summary>
    public enum GpuMeshState : byte
    {
        /// <summary>
        ///     CPU mesh (the instance is not GPU-skinned, or fell back this frame).
        /// </summary>
        Cpu = 0,

        /// <summary>
        ///     The static GPU mesh was rebuilt this frame.
        /// </summary>
        Built = 1,

        /// <summary>
        ///     The static GPU mesh still fits: only the pose record was written.
        /// </summary>
        Reused = 2,

        /// <summary>
        ///     Topology changed: rebuild the static mesh.
        /// </summary>
        NeedsBuild = 3,

        /// <summary>
        ///     Not GPU-eligible this frame (active clipping, or deform on a rendered slot): build a CPU mesh.
        /// </summary>
        NeedsCpu = 4
    }

    /// <summary>
    ///     GPU skinning (<c>Doc/Format/GpuSkinning.md</c>): the static mesh, the per-frame pose record and the
    ///     conservative bounds. The vertex shader (<c>BoneBurstCommon.hlsl</c>, <c>BoneBurstSkin</c>) evaluates
    ///     each vertex with the same arithmetic as <see cref="MeshBuilder.Write" />.
    /// </summary>
    /// <remarks>
    ///     A pose record, in float4s from the instance's base: bone <c>b</c> at <c>2b</c> = <c>(a, b, c, d)</c> and
    ///     <c>2b + 1</c> = <c>(x, y, 0, 0)</c>; then per slot its vertex colour (the PMA bytes / 255) and, with
    ///     tint black, its <c>(uv2.xy, uv3.xy)</c>. The static mesh carries per vertex, in <c>TEXCOORD3</c>:
    ///     <c>(first influence, influence count, bone, slot record)</c>. A count of 0 means the vertex is local to
    ///     the bone (region, unweighted mesh) with its local position in <c>POSITION.xy</c>; otherwise the
    ///     influences (<c>x, y, weight, bone</c>) are read from the global influence buffer.
    /// </remarks>
    public static unsafe class GpuSkin
    {
        /// <summary>
        ///     Header ints in a topology key: built flag, z spacing bits, tint black.
        /// </summary>
        public const int TopologyHeader = 3;

        /// <summary>
        ///     Floats per bone in the reach array: the box of the local positions the static mesh binds to it
        ///     (min x, min y, max x, max y; min &gt; max when none).
        /// </summary>
        public const int ReachStride = 4;

        /// <summary>
        ///     Floats after the per-bone boxes: weight-sum min, weight-sum max, largest |weight| sum, any negative
        ///     weight (1 or 0).
        /// </summary>
        public const int ReachStats = 4;

        public static int ReachSize(int bones)
        {
            return bones * ReachStride + ReachStats;
        }

        public static int RecordSize(int bones, int slots, bool tintBlack)
        {
            return 2 * bones + slots * (tintBlack ? 2 : 1);
        }

        public static int TopologySize(int slots)
        {
            return TopologyHeader + 3 * slots;
        }

        /// <summary>
        ///     The influence buffer for a blob: every weighted attachment's influences as
        ///     <c>(x, y, weight, bone)</c>, and per attachment its first influence (-1 when unweighted).
        /// </summary>
        public static float4[] Influences(BlobContent content, int[] starts)
        {
            List<float4> data = new();
            for (int i = 0; i < content.Attachments.Length; i++)
            {
                AttachmentBlob a = content.Attachments[i];
                bool vertex = a.Kind == AttachmentKind.Mesh || a.Kind == AttachmentKind.LinkedMesh;
                if (!vertex || a.BonesStart < 0)
                {
                    starts[i] = -1;
                    continue;
                }

                starts[i] = data.Count;
                int bi = a.BonesStart, wi = a.VerticesStart;
                for (int k = 0; k < a.VertexCount; k++)
                {
                    int count = content.Bones[bi++];
                    for (int end = bi + count; bi < end; bi++, wi += 3)
                        data.Add(new float4(content.Vertices[wi], content.Vertices[wi + 1], content.Vertices[wi + 2],
                            content.Bones[bi]));
                }
            }

            return data.ToArray();
        }

        /// <summary>
        ///     Decides this frame's path: <see cref="GpuMeshState.NeedsCpu" /> when the CPU mesh would clip or a
        ///     rendered slot has deform, <see cref="GpuMeshState.Reused" /> when the draw-order walk (slot,
        ///     attachment, sequence frame per position, plus z spacing and tint black) equals the one the static mesh
        ///     was built from, else <see cref="GpuMeshState.NeedsBuild" />.
        /// </summary>
        public static GpuMeshState Classify(in InstanceHeader h)
        {
            int* key = h.GpuTopology;
            bool same = key[0] == 1 && key[1] == math.asint(h.ZSpacing) && key[2] == (h.TintBlack ? 1 : 0);
            bool clipping = false;
            BlobView blob = h.Blob;
            for (int i = 0, k = TopologyHeader; i < blob.SlotCount; i++, k += 3)
            {
                int slot = h.AppliedDrawOrder[i];
                int attachment = -1, frame = 0;
                if (MeshBuilder.Renders(h, slot, out AttachmentBlob a, ref clipping))
                {
                    SlotState state = h.AppliedSlots[slot];
                    if (state.DeformCount > 0) return GpuMeshState.NeedsCpu;
                    attachment = state.Attachment;
                    frame = MeshBuilder.Frame(a, state.SequenceIndex);
                }

                same &= key[k] == slot && key[k + 1] == attachment && key[k + 2] == frame;
            }

            // The CPU mesh takes the clipping path only when the skeleton has clipping scratch (MeshBuilder.Measure).
            if (clipping && h.ClipFloats != null) return GpuMeshState.NeedsCpu;
            return same ? GpuMeshState.Reused : GpuMeshState.NeedsBuild;
        }

        /// <summary>
        ///     Writes the pose record at <paramref name="record" />: every bone's world transform and every slot's
        ///     vertex colour (and tint black), exactly as <see cref="MeshBuilder.Write" /> computes them.
        /// </summary>
        public static void WriteRecord(in InstanceHeader h, float4* record)
        {
            BlobView blob = h.Blob;
            for (int b = 0; b < blob.BoneCount; b++)
            {
                BoneWorld w = h.World[b];
                record[2 * b] = new float4(w.A, w.B, w.C, w.D);
                record[2 * b + 1] = new float4(w.X, w.Y, 0, 0);
            }

            int stride = h.TintBlack ? 2 : 1;
            float4* slots = record + 2 * blob.BoneCount;
            bool clipping = false;
            for (int s = 0; s < blob.SlotCount; s++)
            {
                float4* slotRecord = slots + s * stride;
                if (!MeshBuilder.Renders(h, s, out AttachmentBlob a, ref clipping))
                {
                    slotRecord[0] = float4.zero;
                    if (h.TintBlack) slotRecord[1] = float4.zero;
                    continue;
                }

                MeshBuilder.VertexColor(h, h.AppliedSlots[s], a, blob.Slots[s].Blend, out byte r, out byte g,
                    out byte bl, out byte alpha, out float4 tint);
                // A UNorm8 vertex attribute reads as byte / 255; the record carries the same value.
                slotRecord[0] = new float4(r / 255f, g / 255f, bl / 255f, alpha / 255f);
                if (h.TintBlack) slotRecord[1] = tint;
            }
        }

        /// <summary>
        ///     Builds the static mesh for the current topology (the caller sized the buffers with
        ///     <see cref="MeshBuilder.Count" />; <see cref="Classify" /> ruled out clipping and deform). Records the
        ///     topology key and each bone's reach for <see cref="Bounds" />. Colours are written as the CPU mesh
        ///     would (the shader reads the record instead).
        /// </summary>
        public static void Build(in InstanceHeader h, SkeletonVertex* vertices, float4* skin, ushort* indices16,
            uint* indices32)
        {
            BlobView blob = h.Blob;
            float* reach = h.GpuReach;
            for (int b = 0; b < blob.BoneCount; b++)
            {
                float* box = reach + b * ReachStride;
                box[0] = box[1] = float.PositiveInfinity;
                box[2] = box[3] = float.NegativeInfinity;
            }

            float sumMin = float.PositiveInfinity, sumMax = float.NegativeInfinity, absMax = 0, negative = 0;
            int* key = h.GpuTopology;
            key[0] = 1;
            key[1] = math.asint(h.ZSpacing);
            key[2] = h.TintBlack ? 1 : 0;

            int stride = h.TintBlack ? 2 : 1;
            int v = 0, n = 0;
            bool clipping = false;
            for (int i = 0, k = TopologyHeader; i < blob.SlotCount; i++, k += 3)
            {
                int slot = h.AppliedDrawOrder[i];
                key[k] = slot;
                key[k + 1] = -1;
                key[k + 2] = 0;
                if (!MeshBuilder.Renders(h, slot, out AttachmentBlob a, ref clipping)) continue;

                SlotState state = h.AppliedSlots[slot];
                SlotSetup setup = blob.Slots[slot];
                int frame = MeshBuilder.Frame(a, state.SequenceIndex);
                key[k + 1] = state.Attachment;
                key[k + 2] = frame;
                float slotRecord = 2 * blob.BoneCount + slot * stride;
                float z = h.ZSpacing * i;
                MeshBuilder.VertexColor(h, state, a, setup.Blend, out byte r, out byte g, out byte bl, out byte alpha,
                    out float4 _);

                if (a.Kind == AttachmentKind.Region)
                {
                    float* o = blob.Offsets + a.OffsetStart + frame * 8;
                    float* uv = blob.Uvs + a.UvStart + frame * 8;
                    float4 local = new(0, 0, setup.Bone, slotRecord);
                    // The CPU mesh's corner order (MeshBuilder.Write): W0, W3, W1, W2.
                    Local(vertices + v, skin + v, local, o[6], o[7], uv[0], uv[1], z, r, g, bl, alpha);
                    Local(vertices + v + 1, skin + v + 1, local, o[4], o[5], uv[6], uv[7], z, r, g, bl, alpha);
                    Local(vertices + v + 2, skin + v + 2, local, o[0], o[1], uv[2], uv[3], z, r, g, bl, alpha);
                    Local(vertices + v + 3, skin + v + 3, local, o[2], o[3], uv[4], uv[5], z, r, g, bl, alpha);
                    for (int c = 0; c < 8; c += 2) Reach(reach, setup.Bone, o[c], o[c + 1]);
                    sumMin = math.min(sumMin, 1);
                    sumMax = math.max(sumMax, 1);
                    absMax = math.max(absMax, 1);
                    Index(indices16, indices32, n, v + 0);
                    Index(indices16, indices32, n + 1, v + 2);
                    Index(indices16, indices32, n + 2, v + 1);
                    Index(indices16, indices32, n + 3, v + 2);
                    Index(indices16, indices32, n + 4, v + 3);
                    Index(indices16, indices32, n + 5, v + 1);
                    v += 4;
                    n += 6;
                    continue;
                }

                float* uvs = blob.Uvs + a.UvStart + frame * 2 * a.VertexCount;
                float* source = blob.Vertices + a.VerticesStart;
                if (a.BonesStart < 0)
                {
                    float4 local = new(0, 0, setup.Bone, slotRecord);
                    for (int j = 0; j < a.VertexCount; j++)
                    {
                        float vx = source[2 * j], vy = source[2 * j + 1];
                        Local(vertices + v + j, skin + v + j, local, vx, vy, uvs[2 * j], uvs[2 * j + 1], z, r, g, bl,
                            alpha);
                        Reach(reach, setup.Bone, vx, vy);
                    }

                    sumMin = math.min(sumMin, 1);
                    sumMax = math.max(sumMax, 1);
                    absMax = math.max(absMax, 1);
                }
                else
                {
                    int first = h.GpuInfluenceStart[state.Attachment];
                    int* bones = blob.BoneIndices + a.BonesStart;
                    int bi = 0, wi = 0, influence = 0;
                    for (int j = 0; j < a.VertexCount; j++)
                    {
                        int count = bones[bi++];
                        skin[v + j] = new float4(first + influence, count, 0, slotRecord);
                        float sum = 0, abs = 0;
                        for (int end = bi + count; bi < end; bi++, wi += 3, influence++)
                        {
                            float weight = source[wi + 2];
                            Reach(reach, bones[bi], source[wi], source[wi + 1]);
                            sum += weight;
                            abs += math.abs(weight);
                            if (weight < 0) negative = 1;
                        }

                        sumMin = math.min(sumMin, sum);
                        sumMax = math.max(sumMax, sum);
                        absMax = math.max(absMax, abs);
                        SkeletonVertex* vertex = vertices + v + j;
                        vertex->Position = new float3(0, 0, z);
                        vertex->R = r;
                        vertex->G = g;
                        vertex->B = bl;
                        vertex->A = alpha;
                        vertex->Uv = new float2(uvs[2 * j], uvs[2 * j + 1]);
                    }
                }

                int* triangles = blob.Triangles + a.TriangleStart;
                for (int t = 0; t < a.TriangleCount; t++) Index(indices16, indices32, n + t, v + triangles[t]);

                v += a.VertexCount;
                n += a.TriangleCount;
            }

            float* stats = reach + blob.BoneCount * ReachStride;
            stats[0] = sumMin;
            stats[1] = sumMax;
            stats[2] = absMax;
            stats[3] = negative;
        }

        /// <summary>
        ///     Bounds that contain every skinned vertex, from the bones alone: each bone maps the box of its local
        ///     positions to a world box (centre through the bone, half extents <c>|a|·hx + |b|·hy</c>,
        ///     <c>|c|·hx + |d|·hy</c>); a weighted vertex lies in the union scaled by its weight sum. Larger than
        ///     stock's exact vertex bounds, never smaller. Z as <see cref="MeshBuilder.Bounds" />.
        /// </summary>
        public static void Bounds(in InstanceHeader h, out float3 center, out float3 extents)
        {
            BlobView blob = h.Blob;
            float* reach = h.GpuReach;
            float2 lo = new(float.PositiveInfinity), hi = new(float.NegativeInfinity);
            for (int b = 0; b < blob.BoneCount; b++)
            {
                float* box = reach + b * ReachStride;
                if (box[0] > box[2]) continue;
                BoneWorld w = h.World[b];
                float mx = (box[0] + box[2]) * 0.5f, my = (box[1] + box[3]) * 0.5f;
                float hx = (box[2] - box[0]) * 0.5f, hy = (box[3] - box[1]) * 0.5f;
                float2 origin = new(mx * w.A + my * w.B + w.X, mx * w.C + my * w.D + w.Y);
                float2 extent = new(math.abs(w.A) * hx + math.abs(w.B) * hy, math.abs(w.C) * hx + math.abs(w.D) * hy);
                lo = math.min(lo, origin - extent);
                hi = math.max(hi, origin + extent);
            }

            if (lo.x > hi.x)
            {
                center = extents = float3.zero;
                return;
            }

            float* stats = reach + blob.BoneCount * ReachStride;
            float sumMin = stats[0], sumMax = stats[1];
            if (stats[3] != 0)
            {
                // A negative weight leaves the convex hull: |Σ w p| ≤ Σ|w| · max|p|.
                float2 m = math.max(math.abs(lo), math.abs(hi)) * stats[2];
                lo = -m;
                hi = m;
            }
            else
            {
                float2 l = math.min(lo * sumMin, lo * sumMax), u = math.max(hi * sumMin, hi * sumMax);
                lo = l;
                hi = u;
            }

            // Room for the GPU's rounding (fused multiply-adds, reordered sums).
            float2 pad = (math.abs(lo) + math.abs(hi)) * 1e-5f + 1e-6f;
            lo -= pad;
            hi += pad;
            float2 half = (hi - lo) * 0.5f;
            center = new float3(lo + half, 0);
            extents = new float3(half, blob.SlotCount * h.ZSpacing * 0.5f);
        }

        private static void Reach(float* reach, int bone, float x, float y)
        {
            float* box = reach + bone * ReachStride;
            box[0] = math.min(box[0], x);
            box[1] = math.min(box[1], y);
            box[2] = math.max(box[2], x);
            box[3] = math.max(box[3], y);
        }

        private static void Local(SkeletonVertex* vertex, float4* skin, float4 local, float x, float y, float u,
            float v,
            float z, byte r, byte g, byte b, byte a)
        {
            vertex->Position = new float3(x, y, z);
            vertex->R = r;
            vertex->G = g;
            vertex->B = b;
            vertex->A = a;
            vertex->Uv = new float2(u, v);
            *skin = local;
        }

        private static void Index(ushort* indices16, uint* indices32, int at, int value)
        {
            if (indices16 != null)
                indices16[at] = (ushort)value;
            else
                indices32[at] = (uint)value;
        }
    }
}