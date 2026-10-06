using BoneBurst.Blob;
using BoneBurst.Instance;

namespace BoneBurst
{
    /// <summary>
    ///     World positions of a vertex attachment (paths, clipping polygons) from the applied pose, with the
    ///     slot's applied deform.
    /// </summary>
    public static unsafe class VertexWorld
    {
        /// <summary>
        ///     World positions of a window of a vertex attachment's vertices (Constraints-Path-Physics.md §2.5,
        ///     Pose-and-Mesh.md §6.2) (<paramref name="start" />,
        ///     <paramref name="count" /> in floats of the unweighted layout), stride 2.
        /// </summary>
        public static void Compute(in InstanceHeader h, int slot, in AttachmentBlob a, int start, int count,
            float* output, int offset)
        {
            SlotState state = h.AppliedSlots[slot];
            float* deform = state.DeformCount > 0 ? h.AppliedDeform + h.Blob.SlotDeformStart[slot] : null;
            float* vertices = h.Blob.Vertices + a.VerticesStart;
            if (a.BonesStart < 0)
            {
                BoneWorld bone = h.World[h.Blob.Slots[slot].Bone];
                float* source = deform != null ? deform : vertices;
                for (int v = start, w = offset, end = start + count; v < end; v += 2, w += 2)
                {
                    float vx = source[v], vy = source[v + 1];
                    output[w] = vx * bone.A + vy * bone.B + bone.X;
                    output[w + 1] = vx * bone.C + vy * bone.D + bone.Y;
                }

                return;
            }

            int* bones = h.Blob.BoneIndices + a.BonesStart;
            int vi = 0, skip = 0;
            for (int i = 0; i < start; i += 2)
            {
                int n = bones[vi];
                vi += n + 1;
                skip += n;
            }

            int b = skip * 3, f = skip << 1;
            for (int w = offset, end = offset + count; w < end; w += 2)
            {
                float wx = 0, wy = 0;
                int n = bones[vi++];
                n += vi;
                for (; vi < n; vi++, b += 3, f += 2)
                {
                    BoneWorld bone = h.World[bones[vi]];
                    float vx = vertices[b], vy = vertices[b + 1], weight = vertices[b + 2];
                    if (deform != null)
                    {
                        vx += deform[f];
                        vy += deform[f + 1];
                    }

                    wx += (vx * bone.A + vy * bone.B + bone.X) * weight;
                    wy += (vx * bone.C + vy * bone.D + bone.Y) * weight;
                }

                output[w] = wx;
                output[w + 1] = wy;
            }
        }
    }
}