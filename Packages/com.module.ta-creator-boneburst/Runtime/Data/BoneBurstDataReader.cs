using System;
using System.Collections.Generic;
using Unity.Mathematics;

namespace BoneBurst.Data
{
    /// <summary>
    ///     Reads baked BoneBurst data (<see cref="BoneBurstDataWriter" />) back into the same
    ///     <see cref="SkeletonDef" /> and <see cref="AtlasDef" /> the JSON reader produced, value for value.
    ///     Layout: <c>Doc/Format/BakedData.md</c>.
    /// </summary>
    /// <remarks>
    ///     Refuses loudly, as the other readers do: a wrong magic, another format version, a checksum mismatch, a
    ///     truncated file or an index out of range is a <see cref="SkeletonFormatException" />.
    /// </remarks>
    public sealed class BoneBurstDataReader
    {
        private readonly ByteReader m_In;
        private AttachmentDef[] m_Attachments;
        private float[][] m_Floats;
        private int[][] m_Ints;
        private string[] m_Strings;

        private BoneBurstDataReader(ByteReader input)
        {
            m_In = input;
        }

        /// <exception cref="SkeletonFormatException">The bytes are not readable baked data of this version.</exception>
        public static BoneBurstData Read(byte[] bytes)
        {
            if (bytes == null) throw new ArgumentNullException(nameof(bytes));
            if (!BitConverter.IsLittleEndian) throw new PlatformNotSupportedException("baked data is little-endian.");
            if (bytes.Length < BoneBurstData.HeaderSize)
                throw new SkeletonFormatException($"baked data is {bytes.Length} bytes, shorter than its header.");

            for (int i = 0; i < BoneBurstData.Magic.Length; i++)
                if (bytes[i] != BoneBurstData.Magic[i])
                    throw new SkeletonFormatException("not BoneBurst baked data (wrong magic).");

            ByteReader header = new(bytes, BoneBurstData.Magic.Length);
            int version = header.U16();
            if (version != BoneBurstData.FormatVersion)
                throw new SkeletonFormatException(
                    $"baked data is format version {version}; this runtime reads version {BoneBurstData.FormatVersion}. Rebake it.");

            float scale = header.F32();
            ulong checksum = header.U64();
            if (BoneBurstData.Checksum(bytes, BoneBurstData.HeaderSize) != checksum)
                throw new SkeletonFormatException("baked data is damaged (checksum mismatch). Rebake it.");

            BoneBurstDataReader reader = new(new ByteReader(bytes, BoneBurstData.HeaderSize));
            BoneBurstData data = new() { Scale = scale, SourceDigest = reader.m_In.Bytes() };
            reader.ReadPools();
            data.Skeleton = reader.ReadSkeleton();
            data.Atlas = reader.ReadAtlas();
            reader.ReadKeys(data);
            if (!reader.m_In.AtEnd) throw new SkeletonFormatException("baked data has bytes after its last section.");

            return data;
        }

        /// <summary>
        ///     A timeline's <see cref="TimelineDef.Curves" /> from its control points, one type per segment
        ///     (0 linear, 1 stepped, 2 Bézier) and the curved channels per Bézier segment: the same
        ///     <see cref="CurveBaker" /> calls, with the same values, as the reader that first built them.
        /// </summary>
        internal static float[] RebuildCurves(TimelineKind kind, int frameCount, float[] frames, float[] beziers,
            byte[] types, int channels)
        {
            int entries = TimelineDef.EntriesOf(kind);
            float[] curves = CurveBaker.Create(frameCount, beziers.Length / 4);
            for (int frame = 0, bezier = 0; frame < types.Length; frame++)
            {
                if (types[frame] == 1)
                {
                    CurveBaker.SetStepped(curves, frame);
                    continue;
                }

                if (types[frame] != 2) continue;
                int at = frame * entries, next = at + entries;
                if (kind == TimelineKind.Deform)
                {
                    int i = bezier * 4;
                    CurveBaker.DeformBezier(curves, frameCount, bezier++, frame, frames[at], beziers[i],
                        beziers[i + 1], beziers[i + 2], beziers[i + 3], frames[next]);
                    continue;
                }

                for (int c = 0; c < channels; c++)
                {
                    int i = bezier * 4;
                    CurveBaker.Bezier(curves, frameCount, bezier++, frame, c, frames[at], frames[at + 1 + c],
                        beziers[i], beziers[i + 1], beziers[i + 2], beziers[i + 3], frames[next], frames[next + 1 + c]);
                }
            }

            return curves;
        }

        // ---- Pools --------------------------------------------------------------------------------------------

        private void ReadPools()
        {
            m_Strings = new string[m_In.Count()];
            for (int i = 0; i < m_Strings.Length; i++) m_Strings[i] = m_In.Utf8();

            m_Floats = new float[m_In.Count(2)][];
            for (int i = 0; i < m_Floats.Length; i++) m_Floats[i] = ReadFloatEntry(i);

            m_Ints = new int[m_In.Count()][];
            for (int i = 0; i < m_Ints.Length; i++)
            {
                int[] values = new int[m_In.Count()];
                for (int v = 0; v < values.Length; v++) values[v] = m_In.VarInt();
                m_Ints[i] = values;
            }
        }

        private float[] ReadFloatEntry(int index)
        {
            byte encoding = m_In.U8();
            if (encoding == 0)
            {
                float[] dense = new float[m_In.Count(4)];
                m_In.F32s(dense, 0, dense.Length);
                return dense;
            }

            if (encoding != 1)
                throw new SkeletonFormatException($"float array {index} has unknown encoding {encoding}.");

            // Sparse: the base (an earlier array, or zeros) with one range overwritten.
            int length = (int)m_In.VarUInt();
            int baseRef = (int)m_In.VarUInt();
            int start = (int)m_In.VarUInt();
            int count = m_In.Count(4);
            if (length < 0 || start < 0 || start + count > length || baseRef > index)
                throw new SkeletonFormatException($"float array {index} has an invalid sparse range.");

            float[] values = new float[length];
            if (baseRef > 0)
            {
                float[] baseValues = m_Floats[baseRef - 1];
                if (baseValues.Length < length)
                    throw new SkeletonFormatException($"float array {index}: base too short.");
                Array.Copy(baseValues, values, length);
            }

            m_In.F32s(values, start, count);
            return values;
        }

        private string Str()
        {
            uint index = m_In.VarUInt();
            if (index == 0) return null;
            if (index > m_Strings.Length) throw new SkeletonFormatException($"string {index - 1} is out of range.");
            return m_Strings[index - 1];
        }

        private float[] Floats()
        {
            uint index = m_In.VarUInt();
            if (index == 0) return null;
            if (index > m_Floats.Length) throw new SkeletonFormatException($"float array {index - 1} is out of range.");
            return m_Floats[index - 1];
        }

        private int[] Ints()
        {
            uint index = m_In.VarUInt();
            if (index == 0) return null;
            if (index > m_Ints.Length) throw new SkeletonFormatException($"int array {index - 1} is out of range.");
            return m_Ints[index - 1];
        }

        /// <summary>
        ///     A nullable list's length: stored as length + 1, 0 for null.
        /// </summary>
        private int NullableCount(out bool isNull)
        {
            int stored = m_In.Count();
            isNull = stored == 0;
            return isNull ? 0 : stored - 1;
        }

        private float4 Color()
        {
            if (m_In.Bool()) return new float4(m_In.U8() / 255f, m_In.U8() / 255f, m_In.U8() / 255f, m_In.U8() / 255f);

            return new float4(m_In.F32(), m_In.F32(), m_In.F32(), m_In.F32());
        }

        // ---- Skeleton -----------------------------------------------------------------------------------------

        private SkeletonDef ReadSkeleton()
        {
            ByteReader b = m_In;
            SkeletonDef s = new()
            {
                Hash = Str(), Version = Str(), X = b.F32(), Y = b.F32(), Width = b.F32(), Height = b.F32(),
                ReferenceScale = b.F32(), Fps = b.F32()
            };

            s.Bones = new BoneDef[b.Count()];
            for (int i = 0; i < s.Bones.Length; i++)
                s.Bones[i] = new BoneDef
                {
                    Name = Str(), Parent = b.VarInt(), Rotation = b.F32(), X = b.F32(), Y = b.F32(),
                    ScaleX = b.F32(), ScaleY = b.F32(), ShearX = b.F32(), ShearY = b.F32(), Inherit = (Inherit)b.U8(),
                    Length = b.F32(), SkinRequired = b.Bool()
                };

            s.Slots = new SlotDef[b.Count()];
            for (int i = 0; i < s.Slots.Length; i++)
            {
                SlotDef slot = new() { Name = Str(), Bone = b.VarInt(), Color = Color(), HasDarkColor = b.Bool() };
                slot.DarkColor = Color().xyz;
                slot.AttachmentName = Str();
                slot.Blend = (BlendMode)b.U8();
                s.Slots[i] = slot;
            }

            s.Events = new EventDef[b.Count()];
            for (int i = 0; i < s.Events.Length; i++)
                s.Events[i] = new EventDef
                {
                    Name = Str(), Int = b.VarInt(), Float = b.F32(), String = Str(), AudioPath = Str(),
                    Volume = b.F32(), Balance = b.F32()
                };

            s.Constraints = new ConstraintDef[b.Count()];
            for (int i = 0; i < s.Constraints.Length; i++) s.Constraints[i] = ReadConstraint();

            ReadSkins(s);

            s.Animations = new AnimationDef[b.Count()];
            for (int i = 0; i < s.Animations.Length; i++)
            {
                AnimationDef animation = new() { Name = Str(), Duration = b.F32() };
                int timelines = b.Count();
                for (int t = 0; t < timelines; t++) animation.Timelines.Add(ReadTimeline());
                s.Animations[i] = animation;
            }

            return s;
        }

        private ConstraintDef ReadConstraint()
        {
            ByteReader b = m_In;
            ConstraintKind kind = (ConstraintKind)b.U8();
            string name = Str();
            bool skinRequired = b.Bool();
            switch (kind)
            {
                case ConstraintKind.Ik:
                    return new IkDef
                    {
                        Name = name, SkinRequired = skinRequired, Bones = Ints(), Target = b.VarInt(),
                        ScaleYMode = (ScaleYMode)b.U8(), BendDirection = b.VarInt(), Compress = b.Bool(),
                        Stretch = b.Bool(), Mix = b.F32(), Softness = b.F32()
                    };
                case ConstraintKind.Transform:
                {
                    TransformDef t = new()
                    {
                        Name = name, SkinRequired = skinRequired, Bones = Ints(), Source = b.VarInt(),
                        LocalSource = b.Bool(), LocalTarget = b.Bool(), Additive = b.Bool(), Clamp = b.Bool()
                    };
                    t.From = new TransformFromDef[b.Count()];
                    for (int i = 0; i < t.From.Length; i++)
                    {
                        TransformFromDef from = new() { Property = (TransformProperty)b.U8(), Offset = b.F32() };
                        from.To = new TransformToDef[b.Count()];
                        for (int j = 0; j < from.To.Length; j++)
                            from.To[j] = new TransformToDef
                            {
                                Property = (TransformProperty)b.U8(), Offset = b.F32(), Max = b.F32(), Scale = b.F32()
                            };

                        t.From[i] = from;
                    }

                    t.OffsetRotation = b.F32();
                    t.OffsetX = b.F32();
                    t.OffsetY = b.F32();
                    t.OffsetScaleX = b.F32();
                    t.OffsetScaleY = b.F32();
                    t.OffsetShearY = b.F32();
                    t.MixRotate = b.F32();
                    t.MixX = b.F32();
                    t.MixY = b.F32();
                    t.MixScaleX = b.F32();
                    t.MixScaleY = b.F32();
                    t.MixShearY = b.F32();
                    return t;
                }
                case ConstraintKind.Path:
                    return new PathConstraintDef
                    {
                        Name = name, SkinRequired = skinRequired, Bones = Ints(), Slot = b.VarInt(),
                        PositionMode = (PositionMode)b.U8(), SpacingMode = (SpacingMode)b.U8(),
                        RotateMode = (RotateMode)b.U8(), OffsetRotation = b.F32(), Position = b.F32(),
                        Spacing = b.F32(), MixRotate = b.F32(), MixX = b.F32(), MixY = b.F32()
                    };
                case ConstraintKind.Physics:
                    return new PhysicsDef
                    {
                        Name = name, SkinRequired = skinRequired, Bone = b.VarInt(), X = b.F32(), Y = b.F32(),
                        Rotate = b.F32(), ScaleX = b.F32(), ShearX = b.F32(), ScaleYMode = (ScaleYMode)b.U8(),
                        Limit = b.F32(), Step = b.F32(), Inertia = b.F32(), Strength = b.F32(), Damping = b.F32(),
                        MassInverse = b.F32(), Wind = b.F32(), Gravity = b.F32(), Mix = b.F32(),
                        InertiaGlobal = b.Bool(), StrengthGlobal = b.Bool(), DampingGlobal = b.Bool(),
                        MassGlobal = b.Bool(), WindGlobal = b.Bool(), GravityGlobal = b.Bool(), MixGlobal = b.Bool()
                    };
                case ConstraintKind.Slider:
                    return new SliderDef
                    {
                        Name = name, SkinRequired = skinRequired, Loop = b.Bool(), Additive = b.Bool(),
                        Time = b.F32(), Mix = b.F32(), Animation = b.VarInt(), Bone = b.VarInt(),
                        Property = (TransformProperty)b.U8(), PropertyOffset = b.F32(), Offset = b.F32(),
                        Scale = b.F32(), Local = b.Bool()
                    };
                default:
                    throw new SkeletonFormatException($"constraint '{name}' has unknown kind {(int)kind}.");
            }
        }

        // ---- Skins and attachments ----------------------------------------------------------------------------

        private void ReadSkins(SkeletonDef s)
        {
            ByteReader b = m_In;

            // Every attachment object first, so references (linked meshes, timeline attachments) can point forward.
            m_Attachments = new AttachmentDef[b.Count()];
            for (int i = 0; i < m_Attachments.Length; i++)
            {
                AttachmentKind kind = (AttachmentKind)b.U8();
                m_Attachments[i] = kind switch
                {
                    AttachmentKind.Region => new RegionDef(),
                    AttachmentKind.Mesh or AttachmentKind.LinkedMesh => new MeshDef(),
                    AttachmentKind.Path => new PathAttachmentDef(),
                    AttachmentKind.Clipping => new ClippingDef(),
                    AttachmentKind.BoundingBox => new BoundingBoxDef(),
                    AttachmentKind.Point => new PointDef(),
                    _ => throw new SkeletonFormatException($"attachment {i} has unknown kind {(int)kind}.")
                };
            }

            foreach (AttachmentDef attachment in m_Attachments) ReadAttachment(attachment);

            s.Skins = new SkinDef[b.Count()];
            for (int i = 0; i < s.Skins.Length; i++)
            {
                SkinDef skin = new() { Name = Str(), Bones = Ints(), Constraints = Ints() };
                int entries = b.Count();
                for (int e = 0; e < entries; e++)
                {
                    int slot = b.VarInt();
                    string placeholder = Str();
                    skin.Add(slot, placeholder, AttachmentAt(b.VarUInt()));
                }

                s.Skins[i] = skin;
            }

            int defaultSkin = b.VarInt();
            if (defaultSkin >= s.Skins.Length)
                throw new SkeletonFormatException($"default skin {defaultSkin} is out of range.");
            s.DefaultSkin = defaultSkin < 0 ? null : s.Skins[defaultSkin];
        }

        private AttachmentDef AttachmentAt(uint index)
        {
            if (index >= m_Attachments.Length)
                throw new SkeletonFormatException($"attachment {index} is out of range.");
            return m_Attachments[index];
        }

        /// <summary>
        ///     An attachment reference: index + 1, 0 for null.
        /// </summary>
        private AttachmentDef AttachmentRef()
        {
            uint stored = m_In.VarUInt();
            return stored == 0 ? null : AttachmentAt(stored - 1);
        }

        private void ReadAttachment(AttachmentDef attachment)
        {
            ByteReader b = m_In;
            attachment.Name = Str();
            switch (attachment)
            {
                case RegionDef r:
                    r.Path = Str();
                    r.Color = Color();
                    r.Sequence = ReadSequence();
                    r.X = b.F32();
                    r.Y = b.F32();
                    r.Rotation = b.F32();
                    r.ScaleX = b.F32();
                    r.ScaleY = b.F32();
                    r.Width = b.F32();
                    r.Height = b.F32();
                    break;
                case MeshDef m:
                    ReadVertices(m);
                    m.Path = Str();
                    m.Color = Color();
                    m.Sequence = ReadSequence();
                    m.HullLength = b.VarInt();
                    m.RegionUVs = Floats();
                    m.Triangles = Ints();
                    m.TimelineSlots = Ints();
                    m.Width = b.F32();
                    m.Height = b.F32();
                    m.SourceMesh = AttachmentRef() switch
                    {
                        null => null,
                        MeshDef source => source,
                        AttachmentDef other => throw new SkeletonFormatException(
                            $"linked mesh '{m.Name}' links to '{other.Name}', which is not a mesh.")
                    };
                    break;
                case PathAttachmentDef p:
                    ReadVertices(p);
                    p.Closed = b.Bool();
                    p.ConstantSpeed = b.Bool();
                    p.Lengths = Floats();
                    break;
                case ClippingDef c:
                    ReadVertices(c);
                    c.EndSlot = b.VarInt();
                    c.Convex = b.Bool();
                    c.Inverse = b.Bool();
                    break;
                case BoundingBoxDef bb:
                    ReadVertices(bb);
                    break;
                case PointDef p:
                    p.X = b.F32();
                    p.Y = b.F32();
                    p.Rotation = b.F32();
                    break;
            }
        }

        private void ReadVertices(VertexAttachmentDef v)
        {
            v.Bones = Ints();
            v.Vertices = Floats();
            v.WorldVerticesLength = m_In.VarInt();
            v.TimelineAttachment = AttachmentRef() switch
            {
                null => null,
                VertexAttachmentDef vertices => vertices,
                AttachmentDef other => throw new SkeletonFormatException(
                    $"'{v.Name}' takes its timelines from '{other.Name}', which has no vertices.")
            };
        }

        private SequenceDef ReadSequence()
        {
            ByteReader b = m_In;
            if (!b.Bool()) return null;
            return new SequenceDef
            {
                Count = b.VarInt(), Start = b.VarInt(), Digits = b.VarInt(), SetupIndex = b.VarInt(),
                HasPathSuffix = b.Bool()
            };
        }

        // ---- Timelines ----------------------------------------------------------------------------------------

        private TimelineDef ReadTimeline()
        {
            ByteReader b = m_In;
            TimelineDef t = new() { Kind = (TimelineKind)b.U8(), Target = b.VarInt(), FrameCount = b.VarInt() };
            t.Frames = Floats();
            if (t.FrameCount < 0 || (t.Frames?.Length ?? 0) < t.FrameCount * t.FrameEntries)
                throw new SkeletonFormatException($"{t.Kind} timeline has {t.FrameCount} frames but too few values.");

            if (b.Bool())
            {
                t.Beziers = Floats() ??
                            throw new SkeletonFormatException($"{t.Kind} timeline has curves but no control points.");
                int channels = b.Count();
                byte[] types = new byte[Math.Max(t.FrameCount - 1, 0)];
                for (int i = 0; i < types.Length; i++) types[i] = b.U8();
                CheckCurveCounts(t, types, channels);
                t.Curves = RebuildCurves(t.Kind, t.FrameCount, t.Frames, t.Beziers, types, channels);
            }

            int names = NullableCount(out bool noNames);
            if (!noNames)
            {
                t.AttachmentNames = new string[names];
                for (int i = 0; i < names; i++) t.AttachmentNames[i] = Str();
            }

            t.Skin = b.VarInt();
            t.Attachment = AttachmentRef();

            int deform = NullableCount(out bool noDeform);
            if (!noDeform)
            {
                t.Deform = new float[deform][];
                for (int i = 0; i < deform; i++) t.Deform[i] = Floats();
            }

            int orders = NullableCount(out bool noOrders);
            if (!noOrders)
            {
                t.DrawOrders = new int[orders][];
                for (int i = 0; i < orders; i++) t.DrawOrders[i] = Ints();
            }

            t.FolderSlots = Ints();

            int events = NullableCount(out bool noEvents);
            if (!noEvents)
            {
                t.Events = new EventFrame[events];
                for (int i = 0; i < events; i++)
                    t.Events[i] = new EventFrame
                    {
                        Time = b.F32(), Event = b.VarInt(), Int = b.VarInt(), Float = b.F32(), String = Str(),
                        Volume = b.F32(), Balance = b.F32()
                    };
            }

            return t;
        }

        /// <summary>
        ///     The Bézier segments must use exactly the control points stored: a damaged count would otherwise read
        ///     past them or leave blocks unbaked.
        /// </summary>
        private static void CheckCurveCounts(TimelineDef t, byte[] types, int channels)
        {
            int used = 0;
            foreach (byte type in types)
            {
                if (type > 2) throw new SkeletonFormatException($"{t.Kind} timeline has unknown curve type {type}.");
                if (type == 2) used += t.Kind == TimelineKind.Deform ? 1 : channels;
            }

            if (used * 4 > t.Beziers.Length || (t.Kind != TimelineKind.Deform && channels >= t.FrameEntries))
                throw new SkeletonFormatException($"{t.Kind} timeline: its curves do not match its control points.");
        }

        // ---- Atlas and keys -----------------------------------------------------------------------------------

        private AtlasDef ReadAtlas()
        {
            ByteReader b = m_In;
            AtlasDef atlas = new();
            int pages = b.Count();
            for (int i = 0; i < pages; i++)
                atlas.Pages.Add(new AtlasPageDef
                {
                    Name = Str(), Width = b.VarInt(), Height = b.VarInt(), Format = Str(), MinFilter = Str(),
                    MagFilter = Str(), RepeatU = b.Bool(), RepeatV = b.Bool(), Pma = b.Bool()
                });

            int regions = b.Count();
            for (int i = 0; i < regions; i++)
            {
                AtlasRegionDef region = new()
                {
                    Name = Str(), Page = b.VarInt(), X = b.VarInt(), Y = b.VarInt(), Width = b.VarInt(),
                    Height = b.VarInt(), OffsetX = b.F32(), OffsetY = b.F32(), OriginalWidth = b.VarInt(),
                    OriginalHeight = b.VarInt(), Degrees = b.VarInt(), Index = b.VarInt(), U = b.F32(), V = b.F32(),
                    U2 = b.F32(), V2 = b.F32(), PackedWidth = b.VarInt(), PackedHeight = b.VarInt()
                };
                int extra = NullableCount(out bool noExtra);
                if (!noExtra)
                {
                    region.Extra = new List<(string name, int[] values)>(extra);
                    for (int e = 0; e < extra; e++) region.Extra.Add((Str(), Ints()));
                }

                atlas.Regions.Add(region);
            }

            return atlas;
        }

        private void ReadKeys(BoneBurstData data)
        {
            ByteReader b = m_In;
            SkeletonDef s = data.Skeleton;
            int count = b.Count();
            data.Keys = new BoneBurstKeyTable.Entry[count];
            data.KeyIds = new int[count];
            for (int i = 0; i < count; i++)
            {
                BoneBurstKeyKind kind = (BoneBurstKeyKind)b.U8();
                int index = b.VarInt();
                data.KeyIds[i] = b.I32();
                string name = NameOf(s, kind, index) ?? string.Empty;
                string key = b.Bool() ? Str() : name;
                data.Keys[i] = new BoneBurstKeyTable.Entry
                    { Key = new BoneBurstKey(key), Kind = kind, Name = name, Index = index };
            }
        }

        private static string NameOf(SkeletonDef s, BoneBurstKeyKind kind, int index)
        {
            string Pick<T>(T[] items, Func<T, string> name)
            {
                if (items == null || index < 0 || index >= items.Length)
                    throw new SkeletonFormatException($"{kind} key {index} is out of range.");

                return name(items[index]);
            }

            return kind switch
            {
                BoneBurstKeyKind.Animation => Pick(s.Animations, a => a.Name),
                BoneBurstKeyKind.Skin => Pick(s.Skins, k => k.Name),
                BoneBurstKeyKind.Event => Pick(s.Events, e => e.Name),
                BoneBurstKeyKind.Slot => Pick(s.Slots, k => k.Name),
                BoneBurstKeyKind.Bone => Pick(s.Bones, k => k.Name),
                _ => throw new SkeletonFormatException($"key kind {(int)kind} is unknown.")
            };
        }
    }
}