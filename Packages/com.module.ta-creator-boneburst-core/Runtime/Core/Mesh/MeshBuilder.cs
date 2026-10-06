using System.Runtime.InteropServices;
using BoneBurst.Blob;
using BoneBurst.Data;
using BoneBurst.Instance;
using Unity.Mathematics;

namespace BoneBurst
{
    /// <summary>
    ///     One interleaved vertex: position, 8-bit RGBA colour, UV. Matches the vertex layout
    ///     <c>MeshJob</c> declares.
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct SkeletonVertex
    {
        public float3 Position;
        public byte R, G, B, A;
        public float2 Uv;
    }

    /// <summary>
    ///     Result of <see cref="MeshBuilder.Count" />.
    /// </summary>
    public struct MeshCounts
    {
        public int Vertices, Indices, Submeshes;

        /// <summary>
        ///     The draw-order walk found a clipping attachment on an active slot: the mesh takes spine-unity's
        ///     clipping path (<see cref="ClipMeshBuilder" />), for every submesh.
        /// </summary>
        public bool HasClipping;
    }

    /// <summary>
    ///     Builds a skeleton's vertex and index buffers from its posed state: <c>Doc/Format/Pose-and-Mesh.md</c>
    ///     §5–7 (spine-unity's default <c>BuildMeshWithArrays</c> path, PMA vertex colours).
    /// </summary>
    /// <remarks>
    ///     Two passes over the draw order: <see cref="Count" /> sizes the buffers and decides the submeshes,
    ///     <see cref="Write" /> fills them. Pointer-based, so the mesh job writes straight into
    ///     <c>Mesh.MeshData</c> and tests run it outside Unity.
    /// </remarks>
    public static unsafe class MeshBuilder
    {
        /// <summary>
        ///     Submesh material key: <c>page × 4 + blend</c>. Additive shares the Normal material (its effect comes
        ///     from vertex alpha 0), so it never starts a submesh; Multiply and Screen have their own (§8.2).
        /// </summary>
        public static int MaterialKey(int page, BlendMode blend)
        {
            int material = blend == BlendMode.Additive ? (int)BlendMode.Normal : (int)blend;
            return page * 4 + material;
        }

        /// <summary>
        ///     §7.7 <c>GetMeshBounds</c>: centre <c>min + half</c>, extents <c>half</c> with z extents
        ///     <c>slots × zSpacing × 0.5</c>; zero when nothing was emitted.
        /// </summary>
        public static void Bounds(in InstanceHeader h, int vertexCount, float3 min, float3 max, out float3 center,
            out float3 extents)
        {
            if (vertexCount == 0)
            {
                center = extents = float3.zero;
                return;
            }

            float hw = (max.x - min.x) * 0.5f, hh = (max.y - min.y) * 0.5f;
            float thickness = h.Blob.SlotCount * h.ZSpacing;
            center = new float3(min.x + hw, min.y + hh, 0);
            extents = new float3(hw, hh, thickness * 0.5f);
        }

        /// <summary>
        ///     Sizes the mesh on whichever path applies: <see cref="Count" />, or the clipping path's counting pass.
        ///     Submesh keys and index ends land in the header's arrays.
        /// </summary>
        public static MeshCounts Measure(in InstanceHeader h)
        {
            MeshCounts counts = Count(h, h.SubmeshKeys, h.SubmeshIndexEnd);
            if (!counts.HasClipping || h.ClipFloats == null) return counts;
            Clipper clipper = Clipper.Create(h.ClipFloats, h.ClipInts, h.Blob.ClipPolygonMax, h.Blob.RenderVerticesMax);
            ClipMeshBuilder.Sink sink = default;
            counts.Submeshes = BuildClipped(h, ref clipper, ref sink);
            counts.Vertices = sink.VertexCount;
            counts.Indices = sink.IndexCount;
            return counts;
        }

        /// <summary>
        ///     Fills the buffers <see cref="Measure" /> sized, on the same path. <paramref name="tint" /> receives
        ///     <c>uv2.xy, uv3.xy</c> per vertex when the header asks for tint black; otherwise pass null.
        /// </summary>
        public static void Fill(in InstanceHeader h, in MeshCounts counts, SkeletonVertex* vertices, ushort* indices16,
            uint* indices32, float4* tint, out float3 min, out float3 max)
        {
            if (!counts.HasClipping || h.ClipFloats == null)
            {
                Write(h, vertices, indices16, indices32, out min, out max, tint);
                return;
            }

            Clipper clipper = Clipper.Create(h.ClipFloats, h.ClipInts, h.Blob.ClipPolygonMax, h.Blob.RenderVerticesMax);
            ClipMeshBuilder.Sink sink = new()
            {
                Vertices = vertices, Tint = tint, Indices16 = indices16, Indices32 = indices32
            };
            BuildClipped(h, ref clipper, ref sink);
            min = sink.Min;
            max = sink.Max;
        }

        private static int BuildClipped(in InstanceHeader h, ref Clipper clipper, ref ClipMeshBuilder.Sink sink)
        {
            int n = h.Blob.SlotCount + 1;
            int* submeshes = h.ClipSubmeshes;
            return ClipMeshBuilder.Build(h, ref clipper, ref sink, h.SubmeshKeys, h.SubmeshIndexEnd, submeshes,
                submeshes + n, submeshes + 2 * n, h.TintBlack && sink.Tint != null);
        }

        /// <summary>
        ///     Walks the draw order: counts vertices and indices, and writes each submesh's material key and the
        ///     index count that ends it.
        /// </summary>
        public static MeshCounts Count(in InstanceHeader h, int* submeshKeys, int* submeshIndexEnd)
        {
            MeshCounts counts = default;
            int currentKey = -1;
            bool open = false;
            BlobView blob = h.Blob;
            for (int i = 0; i < blob.SlotCount; i++)
            {
                int slot = h.AppliedDrawOrder[i];
                if (!Renders(h, slot, out AttachmentBlob attachment, ref counts.HasClipping)) continue;

                int key = MaterialKey(PageOf(blob, attachment, h.AppliedSlots[slot].SequenceIndex),
                    blob.Slots[slot].Blend);
                if (!open || key != currentKey)
                {
                    if (open) submeshIndexEnd[counts.Submeshes - 1] = counts.Indices;

                    submeshKeys[counts.Submeshes++] = key;
                    currentKey = key;
                    open = true;
                }

                if (attachment.Kind == AttachmentKind.Region)
                {
                    counts.Vertices += 4;
                    counts.Indices += 6;
                }
                else
                {
                    counts.Vertices += attachment.VertexCount;
                    counts.Indices += attachment.TriangleCount;
                }
            }

            if (open) submeshIndexEnd[counts.Submeshes - 1] = counts.Indices;

            return counts;
        }

        /// <summary>
        ///     Fills the buffers <see cref="Count" /> sized. Exactly one of <paramref name="indices16" /> and
        ///     <paramref name="indices32" /> is non-null. Returns the bounds of every emitted vertex.
        /// </summary>
        public static void Write(in InstanceHeader h, SkeletonVertex* vertices, ushort* indices16, uint* indices32,
            out float3 min, out float3 max, float4* tint = null)
        {
            BlobView blob = h.Blob;
            min = new float3(float.PositiveInfinity, float.PositiveInfinity, 0);
            max = new float3(float.NegativeInfinity, float.NegativeInfinity, 0);
            int v = 0, n = 0;
            bool clipping = false;
            for (int i = 0; i < blob.SlotCount; i++)
            {
                int slot = h.AppliedDrawOrder[i];
                if (!Renders(h, slot, out AttachmentBlob a, ref clipping)) continue;

                SlotState state = h.AppliedSlots[slot];
                SlotSetup setup = blob.Slots[slot];
                BoneWorld bone = h.World[setup.Bone];
                float z = h.ZSpacing * i;
                VertexColor(h, state, a, setup.Blend, out byte r, out byte g, out byte b, out byte alpha,
                    out float4 tintValue);
                if (tint != null)
                {
                    int emitted = a.Kind == AttachmentKind.Region ? 4 : a.VertexCount;
                    for (int k = 0; k < emitted; k++) tint[v + k] = tintValue;
                }

                int frame = Frame(a, state.SequenceIndex);

                if (a.Kind == AttachmentKind.Region)
                {
                    float* o = blob.Offsets + a.OffsetStart + frame * 8;
                    float* uv = blob.Uvs + a.UvStart + frame * 8;
                    // World outputs W0..W3 use offset corners BR, BL, UL, UR (§5.5) and UV pairs P0..P3 (§5.4);
                    // BuildMeshWithArrays emits them as W0, W3, W1, W2 (§7.6).
                    Corner(vertices + v, bone, o[6], o[7], uv[0], uv[1], z, r, g, b, alpha, ref min, ref max);
                    Corner(vertices + v + 1, bone, o[4], o[5], uv[6], uv[7], z, r, g, b, alpha, ref min, ref max);
                    Corner(vertices + v + 2, bone, o[0], o[1], uv[2], uv[3], z, r, g, b, alpha, ref min, ref max);
                    Corner(vertices + v + 3, bone, o[2], o[3], uv[4], uv[5], z, r, g, b, alpha, ref min, ref max);
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
                // Deform (Pose-and-Mesh.md §6.2): replaces unweighted vertices, offsets each weighted influence.
                float* deform = state.DeformCount > 0 ? h.AppliedDeform + blob.SlotDeformStart[slot] : null;
                if (a.BonesStart < 0)
                {
                    if (deform != null) source = deform;
                    for (int k = 0; k < a.VertexCount; k++)
                    {
                        float vx = source[2 * k], vy = source[2 * k + 1];
                        Emit(vertices + v + k, vx * bone.A + vy * bone.B + bone.X, vx * bone.C + vy * bone.D + bone.Y,
                            uvs[2 * k], uvs[2 * k + 1], z, r, g, b, alpha, ref min, ref max);
                    }
                }
                else
                {
                    int* bones = blob.BoneIndices + a.BonesStart;
                    int bi = 0, wi = 0;
                    for (int k = 0; k < a.VertexCount; k++)
                    {
                        float wx = 0, wy = 0;
                        int count = bones[bi++];
                        for (int end = bi + count; bi < end; bi++, wi += 3)
                        {
                            BoneWorld w = h.World[bones[bi]];
                            float px = source[wi], py = source[wi + 1], weight = source[wi + 2];
                            if (deform != null)
                            {
                                int influence = wi / 3 * 2;
                                px += deform[influence];
                                py += deform[influence + 1];
                            }

                            wx += (px * w.A + py * w.B + w.X) * weight;
                            wy += (px * w.C + py * w.D + w.Y) * weight;
                        }

                        Emit(vertices + v + k, wx, wy, uvs[2 * k], uvs[2 * k + 1], z, r, g, b, alpha, ref min,
                            ref max);
                    }
                }

                int* triangles = blob.Triangles + a.TriangleStart;
                for (int k = 0; k < a.TriangleCount; k++) Index(indices16, indices32, n + k, v + triangles[k]);

                v += a.VertexCount;
                n += a.TriangleCount;
            }

            if (v == 0)
            {
                min = max = float3.zero;
                return;
            }

            // §7.7: z extent is half the draw-order depth on each side.
            float thickness = blob.SlotCount * h.ZSpacing * 0.5f;
            min.z = -thickness;
            max.z = thickness;
        }

        /// <summary>
        ///     §7.2: the slot renders a region or mesh. Inactive bones, zero slot alpha, and non-rendering
        ///     attachments are skipped without breaking the submesh.
        /// </summary>
        internal static bool Renders(in InstanceHeader h, int slot, out AttachmentBlob attachment, ref bool clipping)
        {
            attachment = default;
            SlotState state = h.AppliedSlots[slot];
            if (!h.BoneActive[h.Blob.Slots[slot].Bone] || state.Color.w == 0 || state.Attachment < 0) return false;

            attachment = h.Blob.Attachments[state.Attachment];
            if (attachment.Kind == AttachmentKind.Clipping)
            {
                clipping = true;
                return false;
            }

            return (attachment.Kind == AttachmentKind.Region || attachment.Kind == AttachmentKind.Mesh ||
                    attachment.Kind == AttachmentKind.LinkedMesh) && attachment.Page >= 0;
        }

        /// <summary>
        ///     The atlas page of the sequence frame shown (a sequence can span pages).
        /// </summary>
        internal static int PageOf(in BlobView blob, in AttachmentBlob a, int sequenceIndex)
        {
            return blob.FramePages[a.PageStart + Frame(a, sequenceIndex)];
        }

        /// <summary>
        ///     §5.1: -1 means the setup frame; clamped to the last frame, with no lower clamp.
        /// </summary>
        internal static int Frame(in AttachmentBlob a, int sequenceIndex)
        {
            int index = sequenceIndex == -1 ? a.SetupFrame : sequenceIndex;
            return index >= a.FrameCount ? a.FrameCount - 1 : index;
        }

        /// <summary>
        ///     One attachment's vertex colour (§7.5) and its tint-black values (Skins-TintBlack-Culling.md §2.2,
        ///     PMA): <c>(dark.r·α, dark.g·α, dark.b·α, additive ? 0 : α)</c> for <c>uv2.xy, uv3.xy</c>.
        /// </summary>
        internal static void VertexColor(in InstanceHeader h, in SlotState state, in AttachmentBlob a, BlendMode blend,
            out byte r, out byte g, out byte b, out byte alpha, out float4 tint)
        {
            Color(h.Color, state.Color, a.Color, blend, h.LinearColorSpace, out r, out g, out b, out alpha,
                out float tintAlpha);
            float3 dark = state.HasDarkColor ? state.DarkColor : float3.zero;
            tint = new float4(dark.x * tintAlpha, dark.y * tintAlpha, dark.z * tintAlpha,
                blend == BlendMode.Additive ? 0 : tintAlpha);
        }

        /// <summary>
        ///     §7.5, PMA vertex colours: truncated byte alpha, RGB × that byte. Additive slots emit alpha 0, with
        ///     their RGB premultiplied by the gamma-space alpha when rendering in linear space.
        /// </summary>
        private static void Color(float4 skeleton, float4 slot, float4 attachment, BlendMode blend, bool linear,
            out byte r, out byte g,
            out byte b, out byte a, out float alphaUsed)
        {
            float4 c = skeleton * slot * attachment;
            float alpha = c.w;
            bool additive = blend == BlendMode.Additive;
            if (additive && linear) alpha = LinearToGamma(alpha);

            alphaUsed = alpha;
            byte alphaByte = (byte)(alpha * 255);
            r = (byte)(c.x * alphaByte);
            g = (byte)(c.y * alphaByte);
            b = (byte)(c.z * alphaByte);
            a = additive ? (byte)0 : alphaByte;
        }

        /// <summary>
        ///     The sRGB transfer curve. Only additive slots use it (Pose-and-Mesh.md §9 item 3).
        /// </summary>
        private static float LinearToGamma(float value)
        {
            return value <= 0.0031308f ? value * 12.92f : 1.055f * math.pow(value, 1 / 2.4f) - 0.055f;
        }

        private static void Corner(SkeletonVertex* vertex, in BoneWorld bone, float ox, float oy, float u, float v,
            float z,
            byte r, byte g, byte b, byte a, ref float3 min, ref float3 max)
        {
            Emit(vertex, ox * bone.A + oy * bone.B + bone.X, ox * bone.C + oy * bone.D + bone.Y, u, v, z, r, g, b, a,
                ref min, ref max);
        }

        private static void Emit(SkeletonVertex* vertex, float x, float y, float u, float v, float z, byte r, byte g,
            byte b,
            byte a, ref float3 min, ref float3 max)
        {
            vertex->Position = new float3(x, y, z);
            vertex->R = r;
            vertex->G = g;
            vertex->B = b;
            vertex->A = a;
            vertex->Uv = new float2(u, v);
            min.x = math.min(min.x, x);
            min.y = math.min(min.y, y);
            max.x = math.max(max.x, x);
            max.y = math.max(max.y, y);
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