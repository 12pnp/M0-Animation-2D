using System;
using System.Collections.Generic;
using Unity.Mathematics;

namespace BoneBurst.Data
{
    /// <summary>
    ///     Writes a <see cref="SkeletonDef" /> and its <see cref="AtlasDef" /> as baked BoneBurst data: every value
    ///     exactly as the reader produced it, each string once, arrays shared as the model shares them, and Bézier
    ///     curves as their control points. Layout: <c>Doc/Format/BakedData.md</c>.
    /// </summary>
    /// <remarks>
    ///     Exact by construction, and checked while writing: every timeline's curves are rebuilt from what is written
    ///     and compared bit for bit with the model's, and anything that cannot be written exactly is a
    ///     <see cref="SkeletonFormatException" />, never a silent approximation. Not written: <c>MeshDef.Edges</c>
    ///     and the skeleton's <c>ImagesPath</c> / <c>AudioPath</c> (editor-only data the runtime never reads; the
    ///     paths are folders on the exporting machine).
    /// </remarks>
    public sealed class BoneBurstDataWriter
    {
        private readonly Dictionary<AttachmentDef, int> m_AttachmentIndex = new();
        private readonly List<AttachmentDef> m_Attachments = new();
        private readonly ByteWriter m_Body = new();
        private readonly Dictionary<float[], int> m_FloatIndex = new();
        private readonly List<FloatEntry> m_Floats = new();
        private readonly Dictionary<int[], int> m_IntIndex = new();
        private readonly List<int[]> m_Ints = new();
        private readonly Dictionary<string, int> m_StringIndex = new();
        private readonly List<string> m_Strings = new();

        private BoneBurstDataWriter()
        {
        }

        /// <summary>
        ///     The baked bytes for a skeleton read at <paramref name="scale" /> and its atlas.
        ///     <paramref name="sourceDigest" /> is stored as given (for example a hash of the source export).
        /// </summary>
        /// <exception cref="SkeletonFormatException">Something in the model cannot be written exactly.</exception>
        public static byte[] Write(SkeletonDef skeleton, AtlasDef atlas, float scale, byte[] sourceDigest = null)
        {
            if (skeleton == null) throw new ArgumentNullException(nameof(skeleton));
            if (atlas == null) throw new ArgumentNullException(nameof(atlas));
            if (!BitConverter.IsLittleEndian) throw new PlatformNotSupportedException("baked data is little-endian.");

            BoneBurstDataWriter writer = new();
            writer.WriteSkeleton(skeleton);
            writer.WriteAtlas(atlas);
            writer.WriteKeys(BoneBurstKeyTable.BuildEntries(skeleton));

            ByteWriter payload = new();
            payload.Bytes(sourceDigest ?? Array.Empty<byte>());
            writer.WritePools(payload);
            payload.Raw(writer.m_Body.ToArray());
            byte[] payloadBytes = payload.ToArray();

            ByteWriter file = new();
            file.Raw(BoneBurstData.Magic);
            file.U16(BoneBurstData.FormatVersion);
            file.F32(scale);
            file.U64(BoneBurstData.Checksum(payloadBytes, 0));
            file.Raw(payloadBytes);
            return file.ToArray();
        }

        // ---- Pools --------------------------------------------------------------------------------------------

        private void Str(string value)
        {
            if (value == null)
            {
                m_Body.VarUInt(0);
                return;
            }

            if (!m_StringIndex.TryGetValue(value, out int index))
            {
                index = m_Strings.Count;
                m_Strings.Add(value);
                m_StringIndex.Add(value, index);
            }

            m_Body.VarUInt((uint)index + 1);
        }

        /// <summary>
        ///     A float array by reference: the same array object is stored once, so sharing (a linked mesh's
        ///     vertices, a deform key that is the setup pose) survives the round trip. <paramref name="baseArray" />
        ///     (or zeros, with <paramref name="zeroBase" />): store only the range that differs from it, when smaller.
        /// </summary>
        private void Floats(float[] values, float[] baseArray = null, bool zeroBase = false)
        {
            m_Body.VarUInt(values == null ? 0 : (uint)FloatIndex(values, baseArray, zeroBase) + 1);
        }

        private int FloatIndex(float[] values, float[] baseArray, bool zeroBase)
        {
            if (m_FloatIndex.TryGetValue(values, out int index)) return index;

            // The base goes first, so a reader always meets it before the arrays built on it.
            int baseIndex = baseArray != null ? FloatIndex(baseArray, null, false) : -1;
            bool sparse = (baseArray != null && baseArray.Length >= values.Length) || zeroBase;
            index = m_Floats.Count;
            m_Floats.Add(new FloatEntry
                { Values = values, Base = baseArray != null ? baseIndex : -1, Sparse = sparse });
            m_FloatIndex.Add(values, index);
            return index;
        }

        private void Ints(int[] values)
        {
            if (values == null)
            {
                m_Body.VarUInt(0);
                return;
            }

            if (!m_IntIndex.TryGetValue(values, out int index))
            {
                index = m_Ints.Count;
                m_Ints.Add(values);
                m_IntIndex.Add(values, index);
            }

            m_Body.VarUInt((uint)index + 1);
        }

        private void WritePools(ByteWriter output)
        {
            output.VarUInt((uint)m_Strings.Count);
            foreach (string value in m_Strings) output.Utf8(value);

            output.VarUInt((uint)m_Floats.Count);
            foreach (FloatEntry entry in m_Floats) WriteFloatEntry(output, entry);

            output.VarUInt((uint)m_Ints.Count);
            foreach (int[] values in m_Ints)
            {
                output.VarUInt((uint)values.Length);
                foreach (int value in values) output.VarInt(value);
            }
        }

        private void WriteFloatEntry(ByteWriter output, FloatEntry entry)
        {
            float[] values = entry.Values;
            if (entry.Sparse)
            {
                // The smallest range whose bits differ from the base; everything outside it is the base, bit for bit.
                float[] baseValues = entry.Base >= 0 ? m_Floats[entry.Base].Values : null;
                int first = -1, last = -1;
                for (int i = 0; i < values.Length; i++)
                {
                    int bits = BitConverter.SingleToInt32Bits(values[i]);
                    int baseBits = baseValues != null ? BitConverter.SingleToInt32Bits(baseValues[i]) : 0;
                    if (bits == baseBits) continue;
                    if (first < 0) first = i;
                    last = i;
                }

                int count = first < 0 ? 0 : last - first + 1;
                if (count < values.Length)
                {
                    output.U8(1);
                    output.VarUInt((uint)values.Length);
                    output.VarUInt((uint)(entry.Base + 1));
                    output.VarUInt((uint)Math.Max(first, 0));
                    output.VarUInt((uint)count);
                    output.F32s(values, Math.Max(first, 0), count);
                    return;
                }
            }

            output.U8(0);
            output.VarUInt((uint)values.Length);
            output.F32s(values, 0, values.Length);
        }

        // ---- Skeleton -----------------------------------------------------------------------------------------

        private void WriteSkeleton(SkeletonDef s)
        {
            ByteWriter b = m_Body;
            Str(s.Hash);
            Str(s.Version);
            b.F32(s.X);
            b.F32(s.Y);
            b.F32(s.Width);
            b.F32(s.Height);
            b.F32(s.ReferenceScale);
            b.F32(s.Fps);

            BoneDef[] bones = s.Bones ?? Array.Empty<BoneDef>();
            b.VarUInt((uint)bones.Length);
            foreach (BoneDef bone in bones)
            {
                Str(bone.Name);
                b.VarInt(bone.Parent);
                b.F32(bone.Rotation);
                b.F32(bone.X);
                b.F32(bone.Y);
                b.F32(bone.ScaleX);
                b.F32(bone.ScaleY);
                b.F32(bone.ShearX);
                b.F32(bone.ShearY);
                b.U8((byte)bone.Inherit);
                b.F32(bone.Length);
                b.Bool(bone.SkinRequired);
            }

            SlotDef[] slots = s.Slots ?? Array.Empty<SlotDef>();
            b.VarUInt((uint)slots.Length);
            foreach (SlotDef slot in slots)
            {
                Str(slot.Name);
                b.VarInt(slot.Bone);
                Color(slot.Color);
                b.Bool(slot.HasDarkColor);
                Color(new float4(slot.DarkColor, 1));
                Str(slot.AttachmentName);
                b.U8((byte)slot.Blend);
            }

            EventDef[] events = s.Events ?? Array.Empty<EventDef>();
            b.VarUInt((uint)events.Length);
            foreach (EventDef e in events)
            {
                Str(e.Name);
                b.VarInt(e.Int);
                b.F32(e.Float);
                Str(e.String);
                Str(e.AudioPath);
                b.F32(e.Volume);
                b.F32(e.Balance);
            }

            ConstraintDef[] constraints = s.Constraints ?? Array.Empty<ConstraintDef>();
            b.VarUInt((uint)constraints.Length);
            foreach (ConstraintDef constraint in constraints) WriteConstraint(constraint);

            WriteSkins(s);

            AnimationDef[] animations = s.Animations ?? Array.Empty<AnimationDef>();
            b.VarUInt((uint)animations.Length);
            foreach (AnimationDef animation in animations)
            {
                Str(animation.Name);
                b.F32(animation.Duration);
                b.VarUInt((uint)animation.Timelines.Count);
                foreach (TimelineDef timeline in animation.Timelines) WriteTimeline(animation, timeline);
            }
        }

        /// <summary>
        ///     An RGBA colour: 4 bytes when every channel is exactly <c>byte / 255f</c> (what both readers produce),
        ///     else 16 bytes of floats.
        /// </summary>
        private void Color(float4 color)
        {
            byte[] channels = new byte[4];
            bool exact = true;
            for (int i = 0; i < 4 && exact; i++)
            {
                float value = color[i];
                int b = (int)Math.Round(value * 255.0);
                exact = b >= 0 && b <= 255 &&
                        BitConverter.SingleToInt32Bits(b / 255f) == BitConverter.SingleToInt32Bits(value);
                channels[i] = (byte)b;
            }

            m_Body.Bool(exact);
            if (exact)
            {
                m_Body.Raw(channels);
                return;
            }

            for (int i = 0; i < 4; i++) m_Body.F32(color[i]);
        }

        private void WriteConstraint(ConstraintDef constraint)
        {
            ByteWriter b = m_Body;
            b.U8((byte)constraint.Kind);
            Str(constraint.Name);
            b.Bool(constraint.SkinRequired);
            switch (constraint)
            {
                case IkDef ik:
                    Ints(ik.Bones);
                    b.VarInt(ik.Target);
                    b.U8((byte)ik.ScaleYMode);
                    b.VarInt(ik.BendDirection);
                    b.Bool(ik.Compress);
                    b.Bool(ik.Stretch);
                    b.F32(ik.Mix);
                    b.F32(ik.Softness);
                    break;
                case TransformDef t:
                    Ints(t.Bones);
                    b.VarInt(t.Source);
                    b.Bool(t.LocalSource);
                    b.Bool(t.LocalTarget);
                    b.Bool(t.Additive);
                    b.Bool(t.Clamp);
                    TransformFromDef[] from = t.From ?? Array.Empty<TransformFromDef>();
                    b.VarUInt((uint)from.Length);
                    foreach (TransformFromDef f in from)
                    {
                        b.U8((byte)f.Property);
                        b.F32(f.Offset);
                        TransformToDef[] to = f.To ?? Array.Empty<TransformToDef>();
                        b.VarUInt((uint)to.Length);
                        foreach (TransformToDef x in to)
                        {
                            b.U8((byte)x.Property);
                            b.F32(x.Offset);
                            b.F32(x.Max);
                            b.F32(x.Scale);
                        }
                    }

                    b.F32(t.OffsetRotation);
                    b.F32(t.OffsetX);
                    b.F32(t.OffsetY);
                    b.F32(t.OffsetScaleX);
                    b.F32(t.OffsetScaleY);
                    b.F32(t.OffsetShearY);
                    b.F32(t.MixRotate);
                    b.F32(t.MixX);
                    b.F32(t.MixY);
                    b.F32(t.MixScaleX);
                    b.F32(t.MixScaleY);
                    b.F32(t.MixShearY);
                    break;
                case PathConstraintDef p:
                    Ints(p.Bones);
                    b.VarInt(p.Slot);
                    b.U8((byte)p.PositionMode);
                    b.U8((byte)p.SpacingMode);
                    b.U8((byte)p.RotateMode);
                    b.F32(p.OffsetRotation);
                    b.F32(p.Position);
                    b.F32(p.Spacing);
                    b.F32(p.MixRotate);
                    b.F32(p.MixX);
                    b.F32(p.MixY);
                    break;
                case PhysicsDef p:
                    b.VarInt(p.Bone);
                    b.F32(p.X);
                    b.F32(p.Y);
                    b.F32(p.Rotate);
                    b.F32(p.ScaleX);
                    b.F32(p.ShearX);
                    b.U8((byte)p.ScaleYMode);
                    b.F32(p.Limit);
                    b.F32(p.Step);
                    b.F32(p.Inertia);
                    b.F32(p.Strength);
                    b.F32(p.Damping);
                    b.F32(p.MassInverse);
                    b.F32(p.Wind);
                    b.F32(p.Gravity);
                    b.F32(p.Mix);
                    b.Bool(p.InertiaGlobal);
                    b.Bool(p.StrengthGlobal);
                    b.Bool(p.DampingGlobal);
                    b.Bool(p.MassGlobal);
                    b.Bool(p.WindGlobal);
                    b.Bool(p.GravityGlobal);
                    b.Bool(p.MixGlobal);
                    break;
                case SliderDef sl:
                    b.Bool(sl.Loop);
                    b.Bool(sl.Additive);
                    b.F32(sl.Time);
                    b.F32(sl.Mix);
                    b.VarInt(sl.Animation);
                    b.VarInt(sl.Bone);
                    b.U8((byte)sl.Property);
                    b.F32(sl.PropertyOffset);
                    b.F32(sl.Offset);
                    b.F32(sl.Scale);
                    b.Bool(sl.Local);
                    break;
                default:
                    throw new SkeletonFormatException(
                        $"constraint '{constraint.Name}': {constraint.GetType().Name} cannot be baked.");
            }
        }

        // ---- Skins and attachments ----------------------------------------------------------------------------

        private void WriteSkins(SkeletonDef s)
        {
            SkinDef[] skins = s.Skins ?? Array.Empty<SkinDef>();

            // Every attachment once, in skin entry order; references to it are indices.
            foreach (SkinDef skin in skins)
            foreach (SkinEntry entry in skin.Entries)
                AddAttachment(entry.Attachment);

            ByteWriter b = m_Body;
            b.VarUInt((uint)m_Attachments.Count);
            foreach (AttachmentDef attachment in m_Attachments) b.U8((byte)attachment.Kind);
            foreach (AttachmentDef attachment in m_Attachments) WriteAttachment(attachment);

            b.VarUInt((uint)skins.Length);
            foreach (SkinDef skin in skins)
            {
                Str(skin.Name);
                Ints(skin.Bones);
                Ints(skin.Constraints);
                b.VarUInt((uint)skin.Entries.Count);
                foreach (SkinEntry entry in skin.Entries)
                {
                    b.VarInt(entry.Slot);
                    Str(entry.Placeholder);
                    b.VarUInt((uint)AttachmentIndex(entry.Attachment, "a skin entry"));
                }
            }

            int defaultSkin = s.DefaultSkin == null ? -1 : Array.IndexOf(skins, s.DefaultSkin);
            if (s.DefaultSkin != null && defaultSkin < 0)
                throw new SkeletonFormatException($"the default skin '{s.DefaultSkin.Name}' is not in the skin list.");

            b.VarInt(defaultSkin);
        }

        private void AddAttachment(AttachmentDef attachment)
        {
            if (attachment == null) throw new SkeletonFormatException("a skin entry has no attachment.");

            if (m_AttachmentIndex.ContainsKey(attachment)) return;
            m_AttachmentIndex.Add(attachment, m_Attachments.Count);
            m_Attachments.Add(attachment);
        }

        private int AttachmentIndex(AttachmentDef attachment, string what)
        {
            if (!m_AttachmentIndex.TryGetValue(attachment, out int index))
                throw new SkeletonFormatException(
                    $"{what} refers to attachment '{attachment.Name}', which is in no skin.");

            return index;
        }

        /// <summary>
        ///     An attachment reference: index + 1, 0 for null.
        /// </summary>
        private void AttachmentRef(AttachmentDef attachment, string what)
        {
            m_Body.VarUInt(attachment == null ? 0 : (uint)AttachmentIndex(attachment, what) + 1);
        }

        private void WriteAttachment(AttachmentDef attachment)
        {
            ByteWriter b = m_Body;
            Str(attachment.Name);
            switch (attachment)
            {
                case RegionDef r:
                    Str(r.Path);
                    Color(r.Color);
                    WriteSequence(r.Sequence);
                    b.F32(r.X);
                    b.F32(r.Y);
                    b.F32(r.Rotation);
                    b.F32(r.ScaleX);
                    b.F32(r.ScaleY);
                    b.F32(r.Width);
                    b.F32(r.Height);
                    break;
                case MeshDef m:
                    WriteVertices(m);
                    Str(m.Path);
                    Color(m.Color);
                    WriteSequence(m.Sequence);
                    b.VarInt(m.HullLength);
                    Floats(m.RegionUVs);
                    Ints(m.Triangles);
                    Ints(m.TimelineSlots);
                    b.F32(m.Width);
                    b.F32(m.Height);
                    AttachmentRef(m.SourceMesh, $"linked mesh '{m.Name}'");
                    break;
                case PathAttachmentDef p:
                    WriteVertices(p);
                    b.Bool(p.Closed);
                    b.Bool(p.ConstantSpeed);
                    Floats(p.Lengths);
                    break;
                case ClippingDef c:
                    WriteVertices(c);
                    b.VarInt(c.EndSlot);
                    b.Bool(c.Convex);
                    b.Bool(c.Inverse);
                    break;
                case BoundingBoxDef bb:
                    WriteVertices(bb);
                    break;
                case PointDef p:
                    b.F32(p.X);
                    b.F32(p.Y);
                    b.F32(p.Rotation);
                    break;
                default:
                    throw new SkeletonFormatException(
                        $"attachment '{attachment.Name}': {attachment.GetType().Name} cannot be baked.");
            }
        }

        private void WriteVertices(VertexAttachmentDef v)
        {
            Ints(v.Bones);
            Floats(v.Vertices);
            m_Body.VarInt(v.WorldVerticesLength);
            AttachmentRef(v.TimelineAttachment, $"'{v.Name}' (timeline attachment)");
        }

        private void WriteSequence(SequenceDef sequence)
        {
            ByteWriter b = m_Body;
            b.Bool(sequence != null);
            if (sequence == null) return;
            b.VarInt(sequence.Count);
            b.VarInt(sequence.Start);
            b.VarInt(sequence.Digits);
            b.VarInt(sequence.SetupIndex);
            b.Bool(sequence.HasPathSuffix);
        }

        // ---- Timelines ----------------------------------------------------------------------------------------

        private void WriteTimeline(AnimationDef animation, TimelineDef t)
        {
            ByteWriter b = m_Body;
            b.U8((byte)t.Kind);
            b.VarInt(t.Target);
            b.VarInt(t.FrameCount);
            Floats(t.Frames);
            WriteCurves(animation, t);

            b.VarUInt(t.AttachmentNames == null ? 0 : (uint)t.AttachmentNames.Length + 1);
            if (t.AttachmentNames != null)
                foreach (string name in t.AttachmentNames)
                    Str(name);

            b.VarInt(t.Skin);
            AttachmentRef(t.Attachment, $"a {t.Kind} timeline in '{animation.Name}'");

            // Deform keys are stored as the range that differs from the setup vertices (unweighted) or zeros.
            b.VarUInt(t.Deform == null ? 0 : (uint)t.Deform.Length + 1);
            if (t.Deform != null)
            {
                VertexAttachmentDef vertices = t.Attachment as VertexAttachmentDef;
                bool weighted = vertices == null || vertices.IsWeighted;
                foreach (float[] key in t.Deform)
                    if (weighted) Floats(key, null, true);
                    else Floats(key, vertices.Vertices);
            }

            b.VarUInt(t.DrawOrders == null ? 0 : (uint)t.DrawOrders.Length + 1);
            if (t.DrawOrders != null)
                foreach (int[] order in t.DrawOrders)
                    Ints(order);

            Ints(t.FolderSlots);

            b.VarUInt(t.Events == null ? 0 : (uint)t.Events.Length + 1);
            if (t.Events != null)
                foreach (EventFrame e in t.Events)
                {
                    b.F32(e.Time);
                    b.VarInt(e.Event);
                    b.VarInt(e.Int);
                    b.F32(e.Float);
                    Str(e.String);
                    b.F32(e.Volume);
                    b.F32(e.Balance);
                }
        }

        /// <summary>
        ///     Curves as the control points plus one type byte per segment; the baked blocks are rebuilt by
        ///     <see cref="BoneBurstDataReader.RebuildCurves" />, and checked here to rebuild bit for bit.
        /// </summary>
        private void WriteCurves(AnimationDef animation, TimelineDef t)
        {
            ByteWriter b = m_Body;
            b.Bool(t.Curves != null);
            if (t.Curves == null) return;

            string where = $"{t.Kind} timeline (target {t.Target}) in '{animation.Name}'";
            if (t.Beziers == null || t.Beziers.Length % 4 != 0)
                throw new SkeletonFormatException(
                    $"{where} has curves but no control points; read it with this version's reader.");

            int segments = Math.Max(t.FrameCount - 1, 0);
            byte[] types = new byte[segments];
            int bezierFrames = 0;
            for (int frame = 0; frame < segments; frame++)
            {
                float type = t.Curves[frame];
                types[frame] = type == CurveType.Linear ? (byte)0 : type == CurveType.Stepped ? (byte)1 : (byte)2;
                if (types[frame] == 2) bezierFrames++;
            }

            int blocks = t.Beziers.Length / 4;
            int channels = bezierFrames == 0 ? 0 : blocks / bezierFrames;
            float[] rebuilt =
                BoneBurstDataReader.RebuildCurves(t.Kind, t.FrameCount, t.Frames, t.Beziers, types, channels);
            if (!SameBits(rebuilt, t.Curves))
                throw new SkeletonFormatException(
                    $"{where}: its curves cannot be rebuilt exactly from the control points.");

            Floats(t.Beziers);
            b.VarUInt((uint)channels);
            b.Raw(types);
        }

        private static bool SameBits(float[] a, float[] b)
        {
            if (a.Length != b.Length) return false;
            for (int i = 0; i < a.Length; i++)
                if (BitConverter.SingleToInt32Bits(a[i]) != BitConverter.SingleToInt32Bits(b[i]))
                    return false;

            return true;
        }

        // ---- Atlas and keys -----------------------------------------------------------------------------------

        private void WriteAtlas(AtlasDef atlas)
        {
            ByteWriter b = m_Body;
            b.VarUInt((uint)atlas.Pages.Count);
            foreach (AtlasPageDef page in atlas.Pages)
            {
                Str(page.Name);
                b.VarInt(page.Width);
                b.VarInt(page.Height);
                Str(page.Format);
                Str(page.MinFilter);
                Str(page.MagFilter);
                b.Bool(page.RepeatU);
                b.Bool(page.RepeatV);
                b.Bool(page.Pma);
            }

            b.VarUInt((uint)atlas.Regions.Count);
            foreach (AtlasRegionDef region in atlas.Regions)
            {
                Str(region.Name);
                b.VarInt(region.Page);
                b.VarInt(region.X);
                b.VarInt(region.Y);
                b.VarInt(region.Width);
                b.VarInt(region.Height);
                b.F32(region.OffsetX);
                b.F32(region.OffsetY);
                b.VarInt(region.OriginalWidth);
                b.VarInt(region.OriginalHeight);
                b.VarInt(region.Degrees);
                b.VarInt(region.Index);
                b.F32(region.U);
                b.F32(region.V);
                b.F32(region.U2);
                b.F32(region.V2);
                b.VarInt(region.PackedWidth);
                b.VarInt(region.PackedHeight);
                b.VarUInt(region.Extra == null ? 0 : (uint)region.Extra.Count + 1);
                if (region.Extra != null)
                    foreach ((string name, int[] values) in region.Extra)
                    {
                        Str(name);
                        Ints(values);
                    }
            }
        }

        private void WriteKeys(BoneBurstKeyTable.Entry[] entries)
        {
            ByteWriter b = m_Body;
            b.VarUInt((uint)entries.Length);
            foreach (BoneBurstKeyTable.Entry entry in entries)
            {
                b.U8((byte)entry.Kind);
                b.VarInt(entry.Index);
                b.I32(entry.Key.Id);

                // The key is the name, unless a suffix made it unique; then both are stored.
                string key = entry.Key.String;
                b.Bool(key != entry.Name);
                if (key != entry.Name) Str(key);
            }
        }

        private struct FloatEntry
        {
            public float[] Values;

            /// <summary>
            ///     Pool index of the array this one is stored as a difference to, or -1: a difference to zeros.
            ///     Only used when <see cref="Sparse" />.
            /// </summary>
            public int Base;

            public bool Sparse;
        }
    }
}