using BoneBurst.Blob;
using BoneBurst.Data;
using BoneBurst.Instance;
using Unity.Mathematics;

namespace BoneBurst
{
    /// <summary>
    ///     spine-unity's clipping mesh path (<c>BuildMesh</c> → <c>AddSubmesh</c>), taken when any active slot shows a
    ///     clipping attachment: <c>Doc/Format/Clipping.md</c> §1 and §4, operation for operation.
    /// </summary>
    /// <remarks>
    ///     <see cref="Build" /> runs twice per frame: once with null buffers to count, then to write. Clipped output
    ///     cannot be sized without clipping, and the second pass is deterministic, so both agree.
    /// </remarks>
    public static unsafe class ClipMeshBuilder
    {
        /// <summary>
        ///     Instruction walk (§1.3) then render walk (§1.4) per submesh. Writes each submesh's material key and
        ///     index end; returns the submesh count.
        /// </summary>
        public static int Build(in InstanceHeader h, ref Clipper clipper, ref Sink sink, int* submeshKeys,
            int* submeshIndexEnd, int* scratchStart, int* scratchEnd, int* scratchPre, bool tintBlack)
        {
            BlobView blob = h.Blob;
            int submeshes = 0;

            // §1.3: instruction walk.
            int clippingEndSlot = -1, clippingSource = -1, lastPre = -1, currentKey = -1, raw = 0, start = 0;
            bool currentHasClipping = false;
            for (int i = 0; i < blob.SlotCount; i++)
            {
                int slot = h.AppliedDrawOrder[i];
                SlotState state = h.AppliedSlots[slot];
                bool skip = !h.BoneActive[blob.Slots[slot].Bone] || (state.Color.w == 0 && slot != clippingEndSlot);
                if (skip) continue;
                int attachment = state.Attachment;
                if (attachment >= 0)
                {
                    AttachmentBlob a = blob.Attachments[attachment];
                    if (a.Kind == AttachmentKind.Clipping)
                    {
                        clippingEndSlot = a.ClipEndSlot;
                        clippingSource = i;
                        currentHasClipping = true;
                    }
                    else if (IsRendered(a))
                    {
                        int key = MeshBuilder.MaterialKey(MeshBuilder.PageOf(blob, a, state.SequenceIndex),
                            blob.Slots[slot].Blend);
                        if (raw > 0 && key != currentKey)
                        {
                            scratchStart[submeshes] = start;
                            scratchEnd[submeshes] = i;
                            scratchPre[submeshes] = lastPre;
                            submeshKeys[submeshes] = currentHasClipping ? currentKey | int.MinValue : currentKey;
                            submeshes++;
                            lastPre = clippingSource;
                            currentHasClipping = clippingSource >= 0;
                            start = i;
                            raw = 0;
                        }

                        currentKey = key;
                        raw += a.Kind == AttachmentKind.Region ? 4 : a.VertexCount;
                    }
                }

                if (clippingEndSlot >= 0 && slot == clippingEndSlot && i != clippingSource)
                {
                    clippingEndSlot = -1;
                    clippingSource = -1;
                }
            }

            if (raw > 0)
            {
                scratchStart[submeshes] = start;
                scratchEnd[submeshes] = blob.SlotCount;
                scratchPre[submeshes] = lastPre;
                submeshKeys[submeshes] = currentHasClipping ? currentKey | int.MinValue : currentKey;
                submeshes++;
            }

            // §1.4 / §4: render walk per submesh.
            sink.Min = new float3(float.PositiveInfinity, float.PositiveInfinity, 0);
            sink.Max = new float3(float.NegativeInfinity, float.NegativeInfinity, 0);
            clipper.End();
            for (int s = 0; s < submeshes; s++)
            {
                bool useClipping = submeshKeys[s] < 0;
                submeshKeys[s] &= int.MaxValue;
                if (useClipping && scratchPre[s] >= 0)
                {
                    int preSlot = h.AppliedDrawOrder[scratchPre[s]];
                    StartClip(h, ref clipper, preSlot);
                }

                for (int i = scratchStart[s]; i < scratchEnd[s]; i++)
                {
                    int slot = h.AppliedDrawOrder[i];
                    SlotState state = h.AppliedSlots[slot];
                    if (!h.BoneActive[blob.Slots[slot].Bone] || state.Color.w == 0)
                    {
                        clipper.End(slot);
                        continue;
                    }

                    int attachment = state.Attachment;
                    AttachmentBlob a = attachment >= 0 ? blob.Attachments[attachment] : default;
                    if (attachment >= 0 && IsRendered(a))
                    {
                        EmitAttachment(h, ref clipper, ref sink, slot, i, a, state, useClipping, tintBlack);
                        clipper.End(slot);
                        continue;
                    }

                    if (useClipping && attachment >= 0 && a.Kind == AttachmentKind.Clipping)
                    {
                        if (!clipper.IsClipping) StartClip(h, ref clipper, slot);
                        continue;
                    }

                    clipper.End(slot);
                }

                clipper.End();
                submeshIndexEnd[s] = sink.IndexCount;
            }

            if (sink.VertexCount == 0)
            {
                sink.Min = sink.Max = float3.zero;
            }
            else
            {
                float thickness = blob.SlotCount * h.ZSpacing * 0.5f;
                sink.Min.z = -thickness;
                sink.Max.z = thickness;
            }

            return submeshes;
        }

        private static bool IsRendered(in AttachmentBlob a)
        {
            return (a.Kind == AttachmentKind.Region || a.Kind == AttachmentKind.Mesh ||
                    a.Kind == AttachmentKind.LinkedMesh) && a.Page >= 0;
        }

        /// <summary>
        ///     <c>ClipStart</c> on the clipping attachment the slot shows (a no-op while a clip is active, or when the
        ///     slot shows no clip).
        /// </summary>
        private static void StartClip(in InstanceHeader h, ref Clipper clipper, int slot)
        {
            if (clipper.IsClipping) return;
            int attachment = h.AppliedSlots[slot].Attachment;
            if (attachment < 0) return;
            AttachmentBlob a = h.Blob.Attachments[attachment];
            if (a.Kind != AttachmentKind.Clipping) return;
            int n = a.VertexCount * 2;
            VertexWorld.Compute(h, slot, a, 0, n, clipper.Polygon, 0);
            clipper.Start(attachment, n, a.ClipEndSlot, a.ClipConvex, a.ClipInverse);
        }

        private static void EmitAttachment(in InstanceHeader h, ref Clipper clipper, ref Sink sink, int slot,
            int drawIndex,
            in AttachmentBlob a, in SlotState state, bool useClipping, bool tintBlack)
        {
            BlobView blob = h.Blob;
            SlotSetup setup = blob.Slots[slot];
            int frame = MeshBuilder.Frame(a, state.SequenceIndex);
            float* verts = clipper.Verts;
            float* uvs = blob.Uvs + a.UvStart + frame * 2 * a.VertexCount;
            int* triangles;
            int triangleCount, vertexCount;
            int* regionTriangles = stackalloc int[6];
            if (a.Kind == AttachmentKind.Region)
            {
                // W0..W3 = BR, BL, UL, UR, with UV pairs P0..P3 (Pose-and-Mesh §5.4–5.5); indices 0 1 2, 2 3 0.
                BoneWorld bone = h.World[setup.Bone];
                float* o = blob.Offsets + a.OffsetStart + frame * 8;
                Corner(verts, 0, bone, o[6], o[7]);
                Corner(verts, 2, bone, o[0], o[1]);
                Corner(verts, 4, bone, o[2], o[3]);
                Corner(verts, 6, bone, o[4], o[5]);
                regionTriangles[0] = 0;
                regionTriangles[1] = 1;
                regionTriangles[2] = 2;
                regionTriangles[3] = 2;
                regionTriangles[4] = 3;
                regionTriangles[5] = 0;
                triangles = regionTriangles;
                triangleCount = 6;
                vertexCount = 4;
            }
            else
            {
                VertexWorld.Compute(h, slot, a, 0, a.VertexCount * 2, verts, 0);
                triangles = blob.Triangles + a.TriangleStart;
                triangleCount = a.TriangleCount;
                vertexCount = a.VertexCount;
            }

            MeshBuilder.VertexColor(h, state, a, setup.Blend, out byte r, out byte g, out byte b, out byte alpha,
                out float4 tint);
            if (tintBlack) tint.w = 1; // the clipping path writes uv3.y = 1 (Skins-TintBlack-Culling.md §2.2)
            float z = h.ZSpacing * drawIndex;
            if (!(useClipping && clipper.IsClipping))
            {
                EmitOriginal(ref sink, verts, uvs, triangles, triangleCount, vertexCount, z, r, g, b, alpha, tint,
                    tintBlack);
                return;
            }

            if (!clipper.Inverse)
            {
                // Stock's per-triangle polygon loop stops at the first polygon that leaves the triangle whole, so
                // whether anything is clipped is decided by polygon 0 alone (§3.2, §3.4).
                bool anyClipped = false;
                for (int i = 0; i < triangleCount && !anyClipped && clipper.PolygonCount > 0; i += 3)
                {
                    int t1 = triangles[i] * 2, t2 = triangles[i + 1] * 2, t3 = triangles[i + 2] * 2;
                    anyClipped = clipper.Clip(verts[t1], verts[t1 + 1], verts[t2], verts[t2 + 1], verts[t3],
                        verts[t3 + 1], 0, out float* _, out int _);
                }

                if (!anyClipped)
                {
                    EmitOriginal(ref sink, verts, uvs, triangles, triangleCount, vertexCount, z, r, g, b, alpha, tint,
                        tintBlack);
                    return;
                }
            }

            // Clipped: private vertices per piece, fan indices, barycentric UVs (§3.2 / §3.3). A dry run first:
            // stock emits nothing (no vertices, no bounds) when no vertex or no index survives.
            Sink probe = sink;
            probe.Vertices = null;
            if (!EmitClippedAttachment(ref clipper, ref probe, verts, uvs, triangles, triangleCount, z, r, g, b, alpha,
                    tint, tintBlack)) return;
            EmitClippedAttachment(ref clipper, ref sink, verts, uvs, triangles, triangleCount, z, r, g, b, alpha, tint,
                tintBlack);
        }

        private static bool EmitClippedAttachment(ref Clipper clipper, ref Sink sink, float* verts, float* uvs,
            int* triangles,
            int triangleCount, float z, byte r, byte g, byte b, byte alpha, float4 tint, bool tintBlack)
        {
            int baseVertex = sink.VertexCount, index = 0, indices = 0;
            for (int i = 0; i < triangleCount; i += 3)
            {
                int t = triangles[i] * 2;
                float x1 = verts[t], y1 = verts[t + 1], u1 = uvs[t], v1 = uvs[t + 1];
                t = triangles[i + 1] * 2;
                float x2 = verts[t], y2 = verts[t + 1], u2 = uvs[t], v2 = uvs[t + 1];
                t = triangles[i + 2] * 2;
                float x3 = verts[t], y3 = verts[t + 1], u3 = uvs[t], v3 = uvs[t + 1];
                if (clipper.Inverse)
                {
                    int fragFloats = clipper.ClipInverse(x1, y1, x2, y2, x3, y3);
                    if (fragFloats == 0) continue;
                    float d0 = y2 - y3, d1 = x3 - x2, d2 = x1 - x3;
                    float d = 1 / (d0 * d2 + d1 * (y1 - y3));
                    float d4 = y3 - y1;
                    for (int off = 0; off < fragFloats;)
                    {
                        int size = (int)clipper.Frags[off++], k = size / 2;
                        for (int j = 0; j < size; j += 2)
                            EmitClipped(ref sink, baseVertex + index + j / 2, clipper.Frags[off + j],
                                clipper.Frags[off + j + 1], x3, y3, d0, d1, d2, d4, d, u1, v1, u2, v2, u3, v3, z, r, g,
                                b, alpha, tint, tintBlack);

                        for (int ii = 1; ii < k - 1; ii++) Fan(ref sink, ref indices, baseVertex + index, ii);

                        index += k;
                        off += size;
                    }

                    continue;
                }

                float e0 = 0, e1 = 0, e2 = 0, e4 = 0, e = 0;
                for (int p = 0; p < clipper.PolygonCount; p++)
                {
                    bool clipped = clipper.Clip(x1, y1, x2, y2, x3, y3, p, out float* piece, out int pieceFloats);
                    if (clipped)
                    {
                        if (pieceFloats == 0) continue;
                        int k = pieceFloats / 2;
                        if (e == 0)
                        {
                            e0 = y2 - y3;
                            e1 = x3 - x2;
                            e2 = x1 - x3;
                            e4 = y3 - y1;
                            e = 1 / (e0 * e2 - e1 * e4);
                        }

                        for (int j = 0; j < k; j++)
                            EmitClipped(ref sink, baseVertex + index + j, piece[2 * j], piece[2 * j + 1], x3, y3, e0,
                                e1, e2, e4, e, u1, v1, u2, v2, u3, v3, z, r, g, b, alpha, tint, tintBlack);

                        for (int ii = 1; ii < k - 1; ii++) Fan(ref sink, ref indices, baseVertex + index, ii);

                        index += k;
                    }
                    else
                    {
                        int at = baseVertex + index;
                        Emit(ref sink, at, x1, y1, u1, v1, z, r, g, b, alpha, tint, tintBlack);
                        Emit(ref sink, at + 1, x2, y2, u2, v2, z, r, g, b, alpha, tint, tintBlack);
                        Emit(ref sink, at + 2, x3, y3, u3, v3, z, r, g, b, alpha, tint, tintBlack);
                        Fan(ref sink, ref indices, at, 1);
                        index += 3;
                        break;
                    }
                }
            }

            if (index == 0 || indices == 0)
            {
                sink.IndexCount -= indices;
                return false;
            }

            sink.VertexCount += index;
            return true;
        }

        private static void EmitOriginal(ref Sink sink, float* verts, float* uvs, int* triangles, int triangleCount,
            int vertexCount, float z, byte r, byte g, byte b, byte a, float4 tint, bool tintBlack)
        {
            if (vertexCount == 0 || triangleCount == 0) return;
            int baseVertex = sink.VertexCount;
            for (int j = 0; j < vertexCount; j++)
                Emit(ref sink, baseVertex + j, verts[2 * j], verts[2 * j + 1], uvs[2 * j], uvs[2 * j + 1], z, r, g, b,
                    a, tint, tintBlack);

            for (int k = 0; k < triangleCount; k++) Index(ref sink, sink.IndexCount + k, baseVertex + triangles[k]);

            sink.IndexCount += triangleCount;
            sink.VertexCount += vertexCount;
        }

        private static void EmitClipped(ref Sink sink, int at, float x, float y, float x3, float y3, float d0, float d1,
            float d2, float d4, float d, float u1, float v1, float u2, float v2, float u3, float v3, float z, byte r,
            byte g, byte b, byte a, float4 tint, bool tintBlack)
        {
            float c0 = x - x3, c1 = y - y3;
            float ba = (d0 * c0 + d1 * c1) * d;
            float bb = (d4 * c0 + d2 * c1) * d;
            float bc = 1 - ba - bb;
            Emit(ref sink, at, x, y, u1 * ba + u2 * bb + u3 * bc, v1 * ba + v2 * bb + v3 * bc, z, r, g, b, a, tint,
                tintBlack);
        }

        private static void Fan(ref Sink sink, ref int indices, int first, int ii)
        {
            Index(ref sink, sink.IndexCount, first);
            Index(ref sink, sink.IndexCount + 1, first + ii);
            Index(ref sink, sink.IndexCount + 2, first + ii + 1);
            sink.IndexCount += 3;
            indices += 3;
        }

        private static void Corner(float* verts, int at, in BoneWorld bone, float ox, float oy)
        {
            verts[at] = ox * bone.A + oy * bone.B + bone.X;
            verts[at + 1] = ox * bone.C + oy * bone.D + bone.Y;
        }

        private static void Emit(ref Sink sink, int at, float x, float y, float u, float v, float z, byte r, byte g,
            byte b,
            byte a, float4 tint, bool tintBlack)
        {
            if (sink.Vertices != null)
            {
                SkeletonVertex* vertex = sink.Vertices + at;
                vertex->Position = new float3(x, y, z);
                vertex->R = r;
                vertex->G = g;
                vertex->B = b;
                vertex->A = a;
                vertex->Uv = new float2(u, v);
                if (tintBlack) sink.Tint[at] = tint;
            }

            // §4.4: NaN never updates the bounds.
            if (x < sink.Min.x) sink.Min.x = x;
            if (x > sink.Max.x) sink.Max.x = x;
            if (y < sink.Min.y) sink.Min.y = y;
            if (y > sink.Max.y) sink.Max.y = y;
        }

        private static void Index(ref Sink sink, int at, int value)
        {
            if (sink.Vertices == null) return;
            if (sink.Indices16 != null) sink.Indices16[at] = (ushort)value;
            else sink.Indices32[at] = (uint)value;
        }

        /// <summary>
        ///     Where the output goes. Null <see cref="Vertices" /> means count only.
        /// </summary>
        public struct Sink
        {
            public SkeletonVertex* Vertices;

            /// <summary>
            ///     Tint black (<c>uv2.xy</c>, <c>uv3.xy</c>) per vertex, or null.
            /// </summary>
            public float4* Tint;

            public ushort* Indices16;
            public uint* Indices32;
            public int VertexCount, IndexCount;
            public float3 Min, Max;
        }
    }
}