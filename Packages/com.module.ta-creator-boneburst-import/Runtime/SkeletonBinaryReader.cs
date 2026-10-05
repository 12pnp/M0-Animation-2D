using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using Unity.Mathematics;

namespace BoneBurst.Data
{
    /// <summary>
    ///     Reads a Spine 4.3 binary skeleton (<c>.skel</c> / <c>.skel.bytes</c>) into a <see cref="SkeletonDef" />.
    /// </summary>
    /// <remarks>
    ///     Written from <c>Doc/Format/Format-Binary.md</c>; section numbers below refer to it. The file is one
    ///     forward-only stream, so every unknown tag or out-of-range read is a hard
    ///     <see cref="SkeletonFormatException" />: continuing would read garbage.
    /// </remarks>
    public sealed class SkeletonBinaryReader
    {
        private const int PhysicsAll = -1;

        private readonly byte[] m_Data;
        private readonly List<PendingLink> m_Links = new();
        private readonly float m_Scale;
        private readonly List<string> m_Strings = new();
        private bool m_Nonessential;
        private int m_Position;
        private SkeletonDef m_Skeleton;

        private SkeletonBinaryReader(byte[] data, float scale)
        {
            m_Data = data;
            m_Scale = scale;
        }

        /// <summary>
        ///     Reads a whole file. <paramref name="scale" /> multiplies every positional value (§10).
        /// </summary>
        /// <exception cref="SkeletonFormatException">The data is not a readable Spine 4.3 binary skeleton.</exception>
        public static SkeletonDef Read(byte[] data, float scale = 1)
        {
            if (data == null) throw new ArgumentNullException(nameof(data));

            if (scale == 0) throw new ArgumentOutOfRangeException(nameof(scale), "scale cannot be 0.");

            SkeletonBinaryReader reader = new(data, scale);
            try
            {
                return reader.ReadSkeleton();
            }
            catch (SkeletonFormatException)
            {
                throw;
            }
            catch (Exception e) when (e is IndexOutOfRangeException || e is ArgumentOutOfRangeException ||
                                      e is InvalidCastException || e is OverflowException)
            {
                throw new SkeletonFormatException(
                    $"Malformed skeleton data near byte {reader.m_Position} (version {reader.m_Skeleton?.Version}).",
                    e);
            }
        }

        private SkeletonDef ReadSkeleton()
        {
            SkeletonDef s = m_Skeleton = new SkeletonDef();

            // §2 Header.
            long hash = I64();
            s.Hash = hash == 0 ? null : hash.ToString(CultureInfo.InvariantCulture);
            s.Version = Str();
            CheckVersion(s.Version);
            s.X = F32();
            s.Y = F32();
            s.Width = F32();
            s.Height = F32();
            s.ReferenceScale = F32() * m_Scale;
            m_Nonessential = Bool();
            if (m_Nonessential)
            {
                s.Fps = F32();
                s.ImagesPath = NullIfEmpty(Str());
                s.AudioPath = NullIfEmpty(Str());
            }

            // §3 Strings.
            int stringCount = VarInt();
            for (int i = 0; i < stringCount; i++) m_Strings.Add(Str());

            s.Bones = ReadBones();
            s.Slots = ReadSlots();
            s.Constraints = ReadConstraints();
            s.Skins = ReadSkins();
            ResolveLinkedMeshes();
            s.Events = ReadEvents();

            int animationCount = VarInt();
            s.Animations = new AnimationDef[animationCount];
            for (int i = 0; i < animationCount; i++) s.Animations[i] = ReadAnimation(Str());

            // §8.16 Slider animation links, last in the file.
            foreach (ConstraintDef constraint in s.Constraints)
                if (constraint is SliderDef slider)
                    slider.Animation = Index(VarInt(), animationCount, "slider animation");

            return s;
        }

        private static void CheckVersion(string version)
        {
            if (string.IsNullOrEmpty(version))
                throw new SkeletonFormatException("Skeleton file has no version string.");

            if (version.Length > 13)
                throw new SkeletonFormatException(
                    "Skeleton file is a pre-4.0 binary format; export it from Spine 4.3.");

            if (!version.StartsWith("4.3", StringComparison.Ordinal))
                throw new SkeletonFormatException(
                    $"Skeleton file is version {version}; this reader supports Spine 4.3 only. Re-export it from Spine 4.3.");
        }

        // §4.1
        private BoneDef[] ReadBones()
        {
            BoneDef[] bones = new BoneDef[VarInt()];
            for (int i = 0; i < bones.Length; i++)
            {
                BoneDef b = new() { Name = Str() };
                b.Parent = i == 0 ? -1 : Index(VarInt(), i, "bone parent");
                b.Rotation = F32();
                b.X = F32() * m_Scale;
                b.Y = F32() * m_Scale;
                b.ScaleX = F32();
                b.ScaleY = F32();
                b.ShearX = F32();
                b.ShearY = F32();
                b.Inherit = InheritOf(S8());
                b.Length = F32() * m_Scale;
                b.SkinRequired = Bool();
                if (m_Nonessential)
                {
                    I32(); // colour
                    Str(); // icon
                    F32(); // icon size
                    F32(); // icon rotation
                    Bool(); // visible
                }

                bones[i] = b;
            }

            return bones;
        }

        // §4.2
        private SlotDef[] ReadSlots()
        {
            SlotDef[] slots = new SlotDef[VarInt()];
            for (int i = 0; i < slots.Length; i++)
            {
                SlotDef slot = new() { Name = Str() };
                slot.Bone = Index(VarInt(), m_Skeleton.Bones.Length, "slot bone");
                slot.Color = Rgba(I32());
                int dark = I32();
                if (dark != -1)
                {
                    slot.HasDarkColor = true;
                    slot.DarkColor = new float3(((dark >> 16) & 0xFF) / 255f, ((dark >> 8) & 0xFF) / 255f,
                        (dark & 0xFF) / 255f);
                }

                slot.AttachmentName = SRef();
                slot.Blend = BlendOf(VarInt());
                if (m_Nonessential) Bool(); // visible

                slots[i] = slot;
            }

            return slots;
        }

        // §4.3
        private ConstraintDef[] ReadConstraints()
        {
            ConstraintDef[] constraints = new ConstraintDef[VarInt()];
            for (int i = 0; i < constraints.Length; i++)
            {
                string name = Str();
                int type = U8();
                ConstraintDef c = type switch
                {
                    0 => ReadIk(),
                    1 => ReadPathConstraint(),
                    2 => ReadTransform(),
                    3 => ReadPhysics(),
                    4 => ReadSlider(),
                    _ => throw Error($"unknown constraint type {type}")
                };
                c.Name = name;
                constraints[i] = c;
            }

            return constraints;
        }

        // §4.3.1
        private IkDef ReadIk()
        {
            IkDef ik = new() { Bones = BoneList() };
            ik.Target = BoneIndex();
            int flags = U8();
            ik.SkinRequired = (flags & 1) != 0;
            if ((flags & 2) != 0) ik.ScaleYMode = ScaleYModeOf(U8());

            ik.BendDirection = (flags & 4) != 0 ? -1 : 1;
            ik.Compress = (flags & 8) != 0;
            ik.Stretch = (flags & 16) != 0;
            ik.Mix = (flags & 32) != 0 ? (flags & 64) != 0 ? F32() : 1 : 0;
            ik.Softness = (flags & 128) != 0 ? F32() * m_Scale : 0;
            return ik;
        }

        // §4.3.2
        private TransformDef ReadTransform()
        {
            TransformDef t = new() { Bones = BoneList() };
            t.Source = BoneIndex();
            int flags = U8();
            t.SkinRequired = (flags & 1) != 0;
            t.LocalSource = (flags & 2) != 0;
            t.LocalTarget = (flags & 4) != 0;
            t.Additive = (flags & 8) != 0;
            t.Clamp = (flags & 16) != 0;

            t.From = new TransformFromDef[flags >> 5];
            for (int i = 0; i < t.From.Length; i++)
            {
                TransformFromDef from = new() { Property = PropertyOf(U8()) };
                float fromScale = PropertyScale(from.Property);
                from.Offset = F32() * fromScale;
                from.To = new TransformToDef[Math.Max(0, (int)S8())];
                for (int j = 0; j < from.To.Length; j++)
                {
                    TransformToDef to = new() { Property = PropertyOf(U8()) };
                    float toScale = PropertyScale(to.Property);
                    to.Offset = F32() * toScale;
                    to.Max = F32() * toScale;
                    to.Scale = F32() * toScale / fromScale;
                    from.To[j] = to;
                }

                t.From[i] = from;
            }

            flags = U8();
            if ((flags & 1) != 0) t.OffsetRotation = F32();
            if ((flags & 2) != 0) t.OffsetX = F32() * m_Scale;
            if ((flags & 4) != 0) t.OffsetY = F32() * m_Scale;
            if ((flags & 8) != 0) t.OffsetScaleX = F32();
            if ((flags & 16) != 0) t.OffsetScaleY = F32();
            if ((flags & 32) != 0) t.OffsetShearY = F32();

            flags = U8();
            if ((flags & 1) != 0) t.MixRotate = F32();
            if ((flags & 2) != 0) t.MixX = F32();
            if ((flags & 4) != 0) t.MixY = F32();
            if ((flags & 8) != 0) t.MixScaleX = F32();
            if ((flags & 16) != 0) t.MixScaleY = F32();
            if ((flags & 32) != 0) t.MixShearY = F32();
            return t;
        }

        // §4.3.3
        private PathConstraintDef ReadPathConstraint()
        {
            PathConstraintDef p = new() { Bones = BoneList() };
            p.Slot = Index(VarInt(), m_Skeleton.Slots.Length, "path slot");
            int flags = U8();
            p.SkinRequired = (flags & 1) != 0;
            p.PositionMode = (PositionMode)((flags >> 1) & 1);
            p.SpacingMode = (SpacingMode)((flags >> 2) & 3);
            int rotate = (flags >> 4) & 3;
            if (rotate > 2) throw Error($"invalid path rotate mode {rotate}");

            p.RotateMode = (RotateMode)rotate;
            if ((flags & 128) != 0) p.OffsetRotation = F32();

            p.Position = F32() * PositionScale(p);
            p.Spacing = F32() * SpacingScale(p);
            p.MixRotate = F32();
            p.MixX = F32();
            p.MixY = F32();
            return p;
        }

        // §4.3.4
        private PhysicsDef ReadPhysics()
        {
            PhysicsDef p = new() { Bone = BoneIndex() };
            int flags = U8();
            p.SkinRequired = (flags & 1) != 0;
            if ((flags & 2) != 0) p.X = F32();
            if ((flags & 4) != 0) p.Y = F32();
            if ((flags & 8) != 0) p.Rotate = F32();
            if ((flags & 16) != 0)
            {
                float v = F32();
                if (v < -2)
                {
                    p.ScaleYMode = ScaleYMode.Volume;
                    p.ScaleX = -2 - v;
                }
                else if (v < 0)
                {
                    p.ScaleYMode = ScaleYMode.Uniform;
                    p.ScaleX = -1 - v;
                }
                else
                {
                    p.ScaleX = v;
                }
            }

            if ((flags & 32) != 0) p.ShearX = F32();
            p.Limit = ((flags & 64) != 0 ? F32() : 5000) * m_Scale;
            p.Step = 1f / U8();
            p.Inertia = F32();
            p.Strength = F32();
            p.Damping = F32();
            p.MassInverse = (flags & 128) != 0 ? F32() : 1;
            p.Wind = F32();
            p.Gravity = F32();

            flags = U8();
            p.InertiaGlobal = (flags & 1) != 0;
            p.StrengthGlobal = (flags & 2) != 0;
            p.DampingGlobal = (flags & 4) != 0;
            p.MassGlobal = (flags & 8) != 0;
            p.WindGlobal = (flags & 16) != 0;
            p.GravityGlobal = (flags & 32) != 0;
            p.MixGlobal = (flags & 64) != 0;
            p.Mix = (flags & 128) != 0 ? F32() : 1;
            return p;
        }

        // §4.3.5
        private SliderDef ReadSlider()
        {
            SliderDef s = new();
            int flags = U8();
            s.SkinRequired = (flags & 1) != 0;
            s.Loop = (flags & 2) != 0;
            s.Additive = (flags & 4) != 0;
            bool boneDriven = (flags & 64) != 0;
            if ((flags & 8) != 0)
            {
                float value = F32();
                // With nonessential data a bone-driven slider stores the editor's "max" here instead.
                if (!(m_Nonessential && boneDriven)) s.Time = value;
            }

            s.Mix = (flags & 16) != 0 ? (flags & 32) != 0 ? F32() : 1 : 0;
            if (boneDriven)
            {
                s.Local = (flags & 128) != 0;
                s.Bone = BoneIndex();
                float propertyOffset = F32();
                s.Property = PropertyOf(U8());
                float propertyScale = PropertyScale(s.Property);
                s.PropertyOffset = propertyOffset * propertyScale;
                s.Offset = F32();
                s.Scale = F32() / propertyScale;
            }

            return s;
        }

        // §5
        private SkinDef[] ReadSkins()
        {
            List<SkinDef> skins = new();
            int defaultSlots = VarInt();
            if (defaultSlots > 0)
            {
                SkinDef skin = new() { Name = "default" };
                skins.Add(skin);
                m_Skeleton.DefaultSkin = skin;
                ReadSkinEntries(skin, skins.Count - 1, defaultSlots);
            }

            int count = VarInt();
            for (int i = 0; i < count; i++)
            {
                SkinDef skin = new() { Name = Str() };
                if (m_Nonessential) I32(); // colour

                skin.Bones = new int[VarInt()];
                for (int j = 0; j < skin.Bones.Length; j++) skin.Bones[j] = BoneIndex();

                skin.Constraints = new int[VarInt()];
                for (int j = 0; j < skin.Constraints.Length; j++)
                    skin.Constraints[j] = Index(VarInt(), m_Skeleton.Constraints.Length, "skin constraint");

                skins.Add(skin);
                ReadSkinEntries(skin, skins.Count - 1, VarInt());
            }

            return skins.ToArray();
        }

        private void ReadSkinEntries(SkinDef skin, int skinIndex, int slotCount)
        {
            for (int i = 0; i < slotCount; i++)
            {
                int slot = Index(VarInt(), m_Skeleton.Slots.Length, "skin slot");
                int attachmentCount = VarInt();
                for (int j = 0; j < attachmentCount; j++)
                {
                    string placeholder = SRef();
                    skin.Add(slot, placeholder, ReadAttachment(placeholder));
                }
            }
        }

        // §6
        private AttachmentDef ReadAttachment(string placeholder)
        {
            int flags = U8();
            int type = flags & 7;
            string name = (flags & 8) != 0 ? SRef() : placeholder;
            switch (type)
            {
                case 0:
                {
                    RegionDef r = new() { Name = name };
                    r.Path = ((flags & 16) != 0 ? SRef() : null) ?? name;
                    if ((flags & 32) != 0) r.Color = Rgba(I32());
                    if ((flags & 64) != 0) r.Sequence = ReadSequence();
                    if ((flags & 128) != 0) r.Rotation = F32();
                    r.X = F32() * m_Scale;
                    r.Y = F32() * m_Scale;
                    r.ScaleX = F32();
                    r.ScaleY = F32();
                    r.Width = F32() * m_Scale;
                    r.Height = F32() * m_Scale;
                    return r;
                }
                case 1:
                {
                    BoundingBoxDef b = new() { Name = name };
                    ReadVertices(b, (flags & 16) != 0);
                    if (m_Nonessential) I32();
                    return b;
                }
                case 2:
                {
                    MeshDef m = new() { Name = name };
                    m.Path = ((flags & 16) != 0 ? SRef() : null) ?? name;
                    if ((flags & 32) != 0) m.Color = Rgba(I32());
                    if ((flags & 64) != 0) m.Sequence = ReadSequence();
                    int hull = VarInt();
                    m.HullLength = hull * 2;
                    ReadVertices(m, (flags & 128) != 0);
                    int length = m.WorldVerticesLength;
                    m.RegionUVs = new float[length];
                    for (int i = 0; i < length; i++) m.RegionUVs[i] = F32();

                    int triangleIndices = (length - hull - 2) * 3;
                    if (triangleIndices < 0)
                        throw Error($"mesh '{name}' has {length / 2} vertices but a hull of {hull}");

                    m.Triangles = new int[triangleIndices];
                    for (int i = 0; i < triangleIndices; i++) m.Triangles[i] = VarInt();

                    m.TimelineSlots = new int[VarInt()];
                    for (int i = 0; i < m.TimelineSlots.Length; i++)
                        m.TimelineSlots[i] = Index(VarInt(), m_Skeleton.Slots.Length, "mesh timeline slot");

                    if (m_Nonessential)
                    {
                        m.Edges = new int[VarInt()];
                        for (int i = 0; i < m.Edges.Length; i++) m.Edges[i] = VarInt();

                        m.Width = F32() * m_Scale;
                        m.Height = F32() * m_Scale;
                    }

                    return m;
                }
                case 3:
                {
                    MeshDef m = new() { Name = name };
                    m.Path = ((flags & 16) != 0 ? SRef() : null) ?? name;
                    if ((flags & 32) != 0) m.Color = Rgba(I32());
                    if ((flags & 64) != 0) m.Sequence = ReadSequence();
                    bool inheritTimelines = (flags & 128) != 0;
                    int sourceSlot = VarInt();
                    int skin = VarInt();
                    string source = SRef();
                    if (m_Nonessential)
                    {
                        m.Width = F32() * m_Scale;
                        m.Height = F32() * m_Scale;
                    }

                    m_Links.Add(new PendingLink(m, skin, sourceSlot, source, inheritTimelines));
                    return m;
                }
                case 4:
                {
                    PathAttachmentDef p = new() { Name = name };
                    p.Closed = (flags & 16) != 0;
                    p.ConstantSpeed = (flags & 32) != 0;
                    ReadVertices(p, (flags & 64) != 0);
                    p.Lengths = new float[p.WorldVerticesLength / 6];
                    for (int i = 0; i < p.Lengths.Length; i++) p.Lengths[i] = F32() * m_Scale;

                    if (m_Nonessential) I32();
                    return p;
                }
                case 5:
                {
                    PointDef p = new() { Name = name };
                    p.Rotation = F32();
                    p.X = F32() * m_Scale;
                    p.Y = F32() * m_Scale;
                    if (m_Nonessential) I32();
                    return p;
                }
                case 6:
                {
                    ClippingDef c = new() { Name = name };
                    c.EndSlot = Index(VarInt(), m_Skeleton.Slots.Length, "clipping end slot");
                    ReadVertices(c, (flags & 16) != 0);
                    if (m_Nonessential) I32();
                    c.Convex = (flags & 32) != 0;
                    c.Inverse = (flags & 64) != 0;
                    return c;
                }
                default:
                    throw Error($"unknown attachment type {type} for '{name}'");
            }
        }

        // §6.8
        private SequenceDef ReadSequence()
        {
            return new SequenceDef
            {
                Count = VarInt(), Start = VarInt(), Digits = VarInt(), SetupIndex = VarInt(), HasPathSuffix = true
            };
        }

        // §6.9
        private void ReadVertices(VertexAttachmentDef attachment, bool weighted)
        {
            int vertexCount = VarInt();
            int length = vertexCount * 2;
            attachment.WorldVerticesLength = length;
            attachment.TimelineAttachment = attachment;
            if (!weighted)
            {
                attachment.Vertices = new float[length];
                for (int i = 0; i < length; i++) attachment.Vertices[i] = F32() * m_Scale;

                return;
            }

            int boneLength = VarInt();
            int influences = boneLength - vertexCount;
            if (influences < 0) throw Error($"weighted vertices: {boneLength} bone entries for {vertexCount} vertices");

            int[] bones = new int[boneLength];
            float[] weights = new float[influences * 3];
            int b = 0, w = 0;
            while (b < boneLength)
            {
                int n = VarInt();
                bones[b++] = n;
                for (int end = b + n; b < end; b++)
                {
                    bones[b] = BoneIndex();
                    weights[w++] = F32() * m_Scale;
                    weights[w++] = F32() * m_Scale;
                    weights[w++] = F32();
                }
            }

            attachment.Bones = bones;
            attachment.Vertices = weights;
        }

        // §6.10
        private void ResolveLinkedMeshes()
        {
            foreach (PendingLink link in m_Links)
            {
                if (link.Skin < 0 || link.Skin >= m_Skeleton.Skins.Length)
                    throw Error($"linked mesh '{link.Mesh.Name}' names skin {link.Skin}, which does not exist");

                if (!(m_Skeleton.Skins[link.Skin].Get(link.SourceSlot, link.Source) is MeshDef source))
                    throw Error($"source mesh not found: {link.Source}");

                MeshDef mesh = link.Mesh;
                mesh.TimelineAttachment = link.InheritTimelines ? source : mesh;
                mesh.SourceMesh = source;
                mesh.Bones = source.Bones;
                mesh.Vertices = source.Vertices;
                mesh.WorldVerticesLength = source.WorldVerticesLength;
                mesh.RegionUVs = source.RegionUVs;
                mesh.Triangles = source.Triangles;
                mesh.HullLength = source.HullLength;
                mesh.Edges = source.Edges;
                mesh.Width = source.Width;
                mesh.Height = source.Height;
            }

            m_Links.Clear();
        }

        // §7
        private EventDef[] ReadEvents()
        {
            EventDef[] events = new EventDef[VarInt()];
            for (int i = 0; i < events.Length; i++)
            {
                EventDef e = new() { Name = Str(), Int = VarIntZigZag(), Float = F32(), String = Str() };
                e.AudioPath = Str();
                if (e.AudioPath != null)
                {
                    e.Volume = F32();
                    e.Balance = F32();
                }

                events[i] = e;
            }

            return events;
        }

        // §8
        private AnimationDef ReadAnimation(string name)
        {
            AnimationDef animation = new() { Name = name };
            List<TimelineDef> timelines = animation.Timelines;
            SkeletonDef s = m_Skeleton;
            VarInt(); // timeline count hint

            // §8.3 Slot timelines.
            for (int slotCount = VarInt(), i = 0; i < slotCount; i++)
            {
                int slot = Index(VarInt(), s.Slots.Length, "slot timeline slot");
                for (int timelineCount = VarInt(), j = 0; j < timelineCount; j++)
                {
                    int type = U8();
                    int frameCount = VarInt();
                    if (type == 0)
                    {
                        TimelineDef t = NewTimeline(TimelineKind.SlotAttachment, slot, frameCount);
                        t.AttachmentNames = new string[frameCount];
                        for (int f = 0; f < frameCount; f++)
                        {
                            t.Frames[f] = F32();
                            t.AttachmentNames[f] = SRef();
                        }

                        timelines.Add(t);
                        continue;
                    }

                    int bezierCount = VarInt();
                    TimelineKind kind = type switch
                    {
                        1 => TimelineKind.SlotRgba,
                        2 => TimelineKind.SlotRgb,
                        3 => TimelineKind.SlotRgba2,
                        4 => TimelineKind.SlotRgb2,
                        5 => TimelineKind.SlotAlpha,
                        _ => throw Error($"unknown slot timeline type {type}")
                    };
                    timelines.Add(ReadCurveTimeline(kind, slot, frameCount, bezierCount, ChannelSource.ColorByte, 1,
                        1));
                }
            }

            // §8.4 Bone timelines.
            for (int boneCount = VarInt(), i = 0; i < boneCount; i++)
            {
                int bone = BoneIndex();
                for (int timelineCount = VarInt(), j = 0; j < timelineCount; j++)
                {
                    int type = U8();
                    int frameCount = VarInt();
                    if (type == 10)
                    {
                        TimelineDef t = NewTimeline(TimelineKind.BoneInherit, bone, frameCount);
                        for (int f = 0; f < frameCount; f++)
                        {
                            t.Frames[f * 2] = F32();
                            t.Frames[f * 2 + 1] = (float)InheritOf(U8());
                        }

                        timelines.Add(t);
                        continue;
                    }

                    int bezierCount = VarInt();
                    (TimelineKind kind, float channelScale) = type switch
                    {
                        0 => (TimelineKind.BoneRotate, 1f),
                        1 => (TimelineKind.BoneTranslate, m_Scale),
                        2 => (TimelineKind.BoneTranslateX, m_Scale),
                        3 => (TimelineKind.BoneTranslateY, m_Scale),
                        4 => (TimelineKind.BoneScale, 1f),
                        5 => (TimelineKind.BoneScaleX, 1f),
                        6 => (TimelineKind.BoneScaleY, 1f),
                        7 => (TimelineKind.BoneShear, 1f),
                        8 => (TimelineKind.BoneShearX, 1f),
                        9 => (TimelineKind.BoneShearY, 1f),
                        _ => throw Error($"unknown bone timeline type {type}")
                    };
                    timelines.Add(ReadCurveTimeline(kind, bone, frameCount, bezierCount, ChannelSource.Float,
                        channelScale, channelScale));
                }
            }

            // §8.5 IK timelines.
            for (int count = VarInt(), i = 0; i < count; i++)
            {
                int index = ConstraintIndex(ConstraintKind.Ik);
                timelines.Add(ReadIkTimeline(index, VarInt(), VarInt()));
            }

            // §8.6 Transform timelines.
            for (int count = VarInt(), i = 0; i < count; i++)
            {
                int index = ConstraintIndex(ConstraintKind.Transform);
                int frameCount = VarInt();
                timelines.Add(ReadCurveTimeline(TimelineKind.Transform, index, frameCount, VarInt(),
                    ChannelSource.Float, 1, 1));
            }

            // §8.7 Path timelines.
            for (int count = VarInt(), i = 0; i < count; i++)
            {
                int index = ConstraintIndex(ConstraintKind.Path);
                PathConstraintDef path = (PathConstraintDef)s.Constraints[index];
                for (int timelineCount = VarInt(), j = 0; j < timelineCount; j++)
                {
                    int type = U8();
                    int frameCount = VarInt();
                    int bezierCount = VarInt();
                    (TimelineKind kind, float channelScale) = type switch
                    {
                        0 => (TimelineKind.PathPosition, PositionScale(path)),
                        1 => (TimelineKind.PathSpacing, SpacingScale(path)),
                        2 => (TimelineKind.PathMix, 1f),
                        _ => throw Error($"unknown path timeline type {type}")
                    };
                    timelines.Add(ReadCurveTimeline(kind, index, frameCount, bezierCount, ChannelSource.Float,
                        channelScale, channelScale));
                }
            }

            // §8.8 Physics timelines. The file stores index + 1; 0 means every physics constraint.
            for (int count = VarInt(), i = 0; i < count; i++)
            {
                int index = VarInt() - 1;
                if (index != PhysicsAll) index = CheckConstraint(index, ConstraintKind.Physics);

                for (int timelineCount = VarInt(), j = 0; j < timelineCount; j++)
                {
                    int type = U8();
                    int frameCount = VarInt();
                    if (type == 8)
                    {
                        TimelineDef t = NewTimeline(TimelineKind.PhysicsReset, index, frameCount);
                        for (int f = 0; f < frameCount; f++) t.Frames[f] = F32();

                        timelines.Add(t);
                        continue;
                    }

                    TimelineKind kind = type switch
                    {
                        0 => TimelineKind.PhysicsInertia,
                        1 => TimelineKind.PhysicsStrength,
                        2 => TimelineKind.PhysicsDamping,
                        4 => TimelineKind.PhysicsMass,
                        5 => TimelineKind.PhysicsWind,
                        6 => TimelineKind.PhysicsGravity,
                        7 => TimelineKind.PhysicsMix,
                        _ => throw Error($"unknown physics timeline type {type}")
                    };
                    timelines.Add(ReadCurveTimeline(kind, index, frameCount, VarInt(), ChannelSource.Float, 1, 1));
                }
            }

            // §8.9 Slider timelines.
            for (int count = VarInt(), i = 0; i < count; i++)
            {
                int index = ConstraintIndex(ConstraintKind.Slider);
                for (int timelineCount = VarInt(), j = 0; j < timelineCount; j++)
                {
                    int type = S8();
                    int frameCount = VarInt();
                    TimelineKind kind = type switch
                    {
                        0 => TimelineKind.SliderTime,
                        1 => TimelineKind.SliderMix,
                        _ => throw Error($"unknown slider timeline type {type}")
                    };
                    timelines.Add(ReadCurveTimeline(kind, index, frameCount, VarInt(), ChannelSource.Float, 1, 1));
                }
            }

            // §8.10 Attachment timelines.
            for (int skinCount = VarInt(), i = 0; i < skinCount; i++)
            {
                int skinIndex = Index(VarInt(), s.Skins.Length, "attachment timeline skin");
                SkinDef skin = s.Skins[skinIndex];
                for (int slotCount = VarInt(), j = 0; j < slotCount; j++)
                {
                    int slot = Index(VarInt(), s.Slots.Length, "attachment timeline slot");
                    for (int attachmentCount = VarInt(), k = 0; k < attachmentCount; k++)
                    {
                        string attachmentName = SRef();
                        AttachmentDef attachment = skin.Get(slot, attachmentName)
                                                   ?? throw Error(
                                                       $"timeline attachment not found: {attachmentName}");
                        int type = U8();
                        int frameCount = VarInt();
                        TimelineDef t = type switch
                        {
                            0 => ReadDeformTimeline(slot, attachment, frameCount),
                            1 => ReadSequenceTimeline(slot, attachment, frameCount),
                            _ => throw Error($"unknown attachment timeline type {type}")
                        };
                        t.Skin = skinIndex;
                        timelines.Add(t);
                    }
                }
            }

            // §8.11 Draw order.
            int drawOrderCount = VarInt();
            if (drawOrderCount > 0)
            {
                TimelineDef t = NewTimeline(TimelineKind.DrawOrder, -1, drawOrderCount);
                t.DrawOrders = new int[drawOrderCount][];
                for (int f = 0; f < drawOrderCount; f++)
                {
                    t.Frames[f] = F32();
                    t.DrawOrders[f] = ReadDrawOrder(s.Slots.Length);
                }

                timelines.Add(t);
            }

            // §8.13 Draw-order folders.
            for (int folderCount = VarInt(), i = 0; i < folderCount; i++)
            {
                int[] folderSlots = new int[VarInt()];
                for (int j = 0; j < folderSlots.Length; j++)
                    folderSlots[j] = Index(VarInt(), s.Slots.Length, "draw order folder slot");

                int keyCount = VarInt();
                TimelineDef t = NewTimeline(TimelineKind.DrawOrderFolder, -1, keyCount);
                t.FolderSlots = folderSlots;
                t.DrawOrders = new int[keyCount][];
                for (int f = 0; f < keyCount; f++)
                {
                    t.Frames[f] = F32();
                    t.DrawOrders[f] = ReadDrawOrder(folderSlots.Length);
                }

                timelines.Add(t);
            }

            // §8.14 Events.
            int eventCount = VarInt();
            if (eventCount > 0)
            {
                TimelineDef t = NewTimeline(TimelineKind.Event, -1, eventCount);
                t.Events = new EventFrame[eventCount];
                for (int f = 0; f < eventCount; f++)
                {
                    float time = F32();
                    int index = Index(VarInt(), s.Events.Length, "event");
                    EventDef data = s.Events[index];
                    EventFrame e = new()
                    {
                        Time = time, Event = index, Int = VarIntZigZag(), Float = F32(), String = Str() ?? data.String
                    };
                    if (data.AudioPath != null)
                    {
                        e.Volume = F32();
                        e.Balance = F32();
                    }

                    t.Frames[f] = time;
                    t.Events[f] = e;
                }

                timelines.Add(t);
            }

            if (m_Nonessential) I32(); // colour

            foreach (TimelineDef t in timelines) animation.Duration = Math.Max(animation.Duration, t.Duration);

            return animation;
        }

        // §8.2.1
        private TimelineDef ReadCurveTimeline(TimelineKind kind, int target, int frameCount, int bezierCount,
            ChannelSource source, float firstChannelScale, float otherChannelScale)
        {
            TimelineDef t = NewTimeline(kind, target, frameCount);
            CurveBaker.Create(t, frameCount, bezierCount);
            int channels = t.FrameEntries - 1;
            float[] values = new float[channels];
            float[] next = new float[channels];
            float time = F32();
            ReadChannels(values, source, firstChannelScale, otherChannelScale);
            for (int frame = 0, bezier = 0;; frame++)
            {
                int at = frame * (channels + 1);
                t.Frames[at] = time;
                Array.Copy(values, 0, t.Frames, at + 1, channels);
                if (frame == frameCount - 1) break;

                float time2 = F32();
                ReadChannels(next, source, firstChannelScale, otherChannelScale);
                switch (U8())
                {
                    case 1:
                        CurveBaker.SetStepped(t.Curves, frame);
                        break;
                    case 2:
                        for (int c = 0; c < channels; c++)
                        {
                            float channelScale = c == 0 ? firstChannelScale : otherChannelScale;
                            float cx1 = F32(), cy1 = F32() * channelScale, cx2 = F32(), cy2 = F32() * channelScale;
                            CurveBaker.Bezier(t, frameCount, bezier++, frame, c, time, values[c], cx1, cy1, cx2,
                                cy2, time2, next[c]);
                        }

                        break;
                }

                time = time2;
                (values, next) = (next, values);
            }

            return t;
        }

        private void ReadChannels(float[] into, ChannelSource source, float firstScale, float otherScale)
        {
            for (int c = 0; c < into.Length; c++)
                into[c] = source == ChannelSource.ColorByte ? U8() / 255f : F32() * (c == 0 ? firstScale : otherScale);
        }

        // §8.5
        private TimelineDef ReadIkTimeline(int index, int frameCount, int bezierCount)
        {
            TimelineDef t = NewTimeline(TimelineKind.Ik, index, frameCount);
            CurveBaker.Create(t, frameCount, bezierCount);
            int flags = U8();
            float time = F32();
            float mix = IkMix(flags);
            float softness = (flags & 4) != 0 ? F32() * m_Scale : 0;
            for (int frame = 0, bezier = 0;; frame++)
            {
                int at = frame * 6;
                t.Frames[at] = time;
                t.Frames[at + 1] = mix;
                t.Frames[at + 2] = softness;
                t.Frames[at + 3] = (flags & 8) != 0 ? 1 : -1;
                t.Frames[at + 4] = (flags & 16) != 0 ? 1 : 0;
                t.Frames[at + 5] = (flags & 32) != 0 ? 1 : 0;
                if (frame == frameCount - 1) break;

                flags = U8();
                float time2 = F32();
                float mix2 = IkMix(flags);
                float softness2 = (flags & 4) != 0 ? F32() * m_Scale : 0;
                if ((flags & 64) != 0)
                {
                    CurveBaker.SetStepped(t.Curves, frame);
                }
                else if ((flags & 128) != 0)
                {
                    float cx1 = F32(), cy1 = F32(), cx2 = F32(), cy2 = F32();
                    CurveBaker.Bezier(t, frameCount, bezier++, frame, 0, time, mix, cx1, cy1, cx2, cy2, time2,
                        mix2);
                    cx1 = F32();
                    cy1 = F32() * m_Scale;
                    cx2 = F32();
                    cy2 = F32() * m_Scale;
                    CurveBaker.Bezier(t, frameCount, bezier++, frame, 1, time, softness, cx1, cy1, cx2, cy2,
                        time2, softness2);
                }

                time = time2;
                mix = mix2;
                softness = softness2;
            }

            return t;
        }

        private float IkMix(int flags)
        {
            return (flags & 1) != 0 ? (flags & 2) != 0 ? F32() : 1 : 0;
        }

        // §8.10.1
        private TimelineDef ReadDeformTimeline(int slot, AttachmentDef attachment, int frameCount)
        {
            if (!(attachment is VertexAttachmentDef vertexAttachment))
                throw Error($"deform timeline on '{attachment.Name}', which has no vertices");

            bool weighted = vertexAttachment.IsWeighted;
            float[] setup = vertexAttachment.Vertices;
            int deformLength = weighted ? setup.Length / 3 * 2 : setup.Length;

            TimelineDef t = NewTimeline(TimelineKind.Deform, slot, frameCount);
            t.Attachment = attachment;
            t.Deform = new float[frameCount][];
            CurveBaker.Create(t, frameCount, VarInt());
            float time = F32();
            for (int frame = 0, bezier = 0;; frame++)
            {
                float[] deform;
                int end = VarInt();
                if (end == 0)
                {
                    deform = weighted ? new float[deformLength] : setup;
                }
                else
                {
                    deform = new float[deformLength];
                    int start = VarInt();
                    end += start;
                    if (end > deformLength)
                        throw Error($"deform frame writes {end} floats into '{attachment.Name}' ({deformLength})");

                    for (int v = start; v < end; v++) deform[v] = F32() * m_Scale;

                    if (!weighted)
                        for (int v = 0; v < deformLength; v++)
                            deform[v] += setup[v];
                }

                t.Frames[frame] = time;
                t.Deform[frame] = deform;
                if (frame == frameCount - 1) break;

                float time2 = F32();
                switch (U8())
                {
                    case 1:
                        CurveBaker.SetStepped(t.Curves, frame);
                        break;
                    case 2:
                        float cx1 = F32(), cy1 = F32(), cx2 = F32(), cy2 = F32();
                        CurveBaker.DeformBezier(t, frameCount, bezier++, frame, time, cx1, cy1, cx2, cy2,
                            time2);
                        break;
                }

                time = time2;
            }

            return t;
        }

        // §8.10.2
        private TimelineDef ReadSequenceTimeline(int slot, AttachmentDef attachment, int frameCount)
        {
            if (!(attachment is RegionDef) && !(attachment is MeshDef))
                throw Error($"sequence timeline on '{attachment.Name}', which has no sequence");

            TimelineDef t = NewTimeline(TimelineKind.Sequence, slot, frameCount);
            t.Attachment = attachment;
            for (int f = 0; f < frameCount; f++)
            {
                t.Frames[f * 3] = F32();
                t.Frames[f * 3 + 1] = I32();
                t.Frames[f * 3 + 2] = F32();
            }

            return t;
        }

        // §8.12
        private int[] ReadDrawOrder(int size)
        {
            int changeCount = VarInt();
            if (changeCount == 0) return null;

            if (changeCount > size) throw Error($"draw order changes {changeCount} of {size} items");

            int[] order = new int[size];
            for (int i = 0; i < size; i++) order[i] = -1;

            int[] unchanged = new int[size - changeCount];
            int original = 0, u = 0;
            for (int i = 0; i < changeCount; i++)
            {
                int index = VarInt();
                while (original != index) unchanged[u++] = original++;

                order[original + VarInt()] = original++;
            }

            while (original < size) unchanged[u++] = original++;

            for (int i = size - 1; i >= 0; i--)
                if (order[i] == -1)
                    order[i] = unchanged[--u];

            return order;
        }

        private TimelineDef NewTimeline(TimelineKind kind, int target, int frameCount)
        {
            TimelineDef t = new() { Kind = kind, Target = target, FrameCount = frameCount };
            t.Frames = new float[frameCount * t.FrameEntries];
            return t;
        }

        // Index helpers: every index is checked, so a bad file fails where it is bad.

        private int[] BoneList()
        {
            int[] bones = new int[VarInt()];
            for (int i = 0; i < bones.Length; i++) bones[i] = BoneIndex();

            return bones;
        }

        private int BoneIndex()
        {
            return Index(VarInt(), m_Skeleton.Bones.Length, "bone");
        }

        private int ConstraintIndex(ConstraintKind kind)
        {
            return CheckConstraint(VarInt(), kind);
        }

        private int CheckConstraint(int index, ConstraintKind kind)
        {
            Index(index, m_Skeleton.Constraints.Length, "constraint");
            if (m_Skeleton.Constraints[index].Kind != kind)
                throw Error($"constraint {index} is {m_Skeleton.Constraints[index].Kind}, expected {kind}");

            return index;
        }

        private int Index(int index, int count, string what)
        {
            if (index < 0 || index >= count) throw Error($"{what} index {index} out of range (count {count})");

            return index;
        }

        private float PropertyScale(TransformProperty property)
        {
            return property == TransformProperty.X || property == TransformProperty.Y ? m_Scale : 1;
        }

        private float PositionScale(PathConstraintDef path)
        {
            return path.PositionMode == PositionMode.Fixed ? m_Scale : 1;
        }

        private float SpacingScale(PathConstraintDef path)
        {
            return path.SpacingMode == SpacingMode.Length || path.SpacingMode == SpacingMode.Fixed ? m_Scale : 1;
        }

        private Inherit InheritOf(int value)
        {
            return value >= 0 && value <= 4 ? (Inherit)value : throw Error($"unknown inherit mode {value}");
        }

        private BlendMode BlendOf(int value)
        {
            return value >= 0 && value <= 3 ? (BlendMode)value : throw Error($"unknown blend mode {value}");
        }

        private ScaleYMode ScaleYModeOf(int value)
        {
            return value >= 0 && value <= 2 ? (ScaleYMode)value : throw Error($"unknown scaleY mode {value}");
        }

        private TransformProperty PropertyOf(int value)
        {
            return value >= 0 && value <= 5
                ? (TransformProperty)value
                : throw Error($"unknown transform property {value}");
        }

        private SkeletonFormatException Error(string message)
        {
            return new SkeletonFormatException(
                $"Skeleton data ({m_Skeleton?.Version}) near byte {m_Position}: {message}.");
        }

        // §1 Primitives. Reads past the end are errors (§1.2).

        private void Need(int count)
        {
            if (m_Position + count > m_Data.Length) throw Error($"unexpected end of data ({count} more bytes needed)");
        }

        private int U8()
        {
            Need(1);
            return m_Data[m_Position++];
        }

        private int S8()
        {
            return (sbyte)U8();
        }

        private bool Bool()
        {
            return U8() != 0;
        }

        private int I32()
        {
            Need(4);
            int value = BinaryPrimitives.ReadInt32BigEndian(m_Data.AsSpan(m_Position, 4));
            m_Position += 4;
            return value;
        }

        private long I64()
        {
            Need(8);
            long value = BinaryPrimitives.ReadInt64BigEndian(m_Data.AsSpan(m_Position, 8));
            m_Position += 8;
            return value;
        }

        private float F32()
        {
            return BitConverter.Int32BitsToSingle(I32());
        }

        private int VarInt()
        {
            int b = U8();
            uint result = (uint)(b & 0x7F);
            if ((b & 0x80) != 0)
            {
                b = U8();
                result |= (uint)(b & 0x7F) << 7;
                if ((b & 0x80) != 0)
                {
                    b = U8();
                    result |= (uint)(b & 0x7F) << 14;
                    if ((b & 0x80) != 0)
                    {
                        b = U8();
                        result |= (uint)(b & 0x7F) << 21;
                        if ((b & 0x80) != 0)
                        {
                            b = U8();
                            result |= (uint)(b & 0x7F) << 28;
                        }
                    }
                }
            }

            return unchecked((int)result);
        }

        private int VarIntZigZag()
        {
            uint raw = unchecked((uint)VarInt());
            return unchecked((int)(raw >> 1) ^ -(int)(raw & 1));
        }

        private string Str()
        {
            int length = VarInt();
            if (length == 0) return null;

            if (length == 1) return "";

            length--;
            if (length < 0) throw Error("negative string length");

            Need(length);
            string value = Encoding.UTF8.GetString(m_Data, m_Position, length);
            m_Position += length;
            return value;
        }

        private string SRef()
        {
            int index = VarInt();
            if (index == 0) return null;

            return m_Strings[Index(index - 1, m_Strings.Count, "string")];
        }

        private static string NullIfEmpty(string value)
        {
            return string.IsNullOrEmpty(value) ? null : value;
        }

        private static float4 Rgba(int value)
        {
            uint v = unchecked((uint)value);
            return new float4(((v >> 24) & 0xFF) / 255f, ((v >> 16) & 0xFF) / 255f, ((v >> 8) & 0xFF) / 255f,
                (v & 0xFF) / 255f);
        }

        private enum ChannelSource
        {
            Float,
            ColorByte
        }

        private readonly struct PendingLink
        {
            public readonly MeshDef Mesh;
            public readonly int Skin, SourceSlot;
            public readonly string Source;
            public readonly bool InheritTimelines;

            public PendingLink(MeshDef mesh, int skin, int sourceSlot, string source, bool inheritTimelines)
            {
                Mesh = mesh;
                Skin = skin;
                SourceSlot = sourceSlot;
                Source = source;
                InheritTimelines = inheritTimelines;
            }
        }
    }
}