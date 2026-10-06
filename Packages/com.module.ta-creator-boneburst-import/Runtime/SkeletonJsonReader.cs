using System;
using System.Collections.Generic;
using System.Globalization;
using Unity.Mathematics;

namespace BoneBurst.Data
{
    /// <summary>
    ///     Reads a Spine 4.3 JSON skeleton into a <see cref="SkeletonDef" />, the same model
    ///     <see cref="SkeletonBinaryReader" /> produces.
    /// </summary>
    /// <remarks>
    ///     Written from <c>Doc/Format/Format-Json-Atlas.md</c>; section numbers below refer to it. JSON defaults are
    ///     not always the binary defaults (sequence start 1, alpha key 0, slider time key 1, …); each is kept as the
    ///     spec lists it, because the stock runtime behaves that way and parity is measured against it.
    /// </remarks>
    public sealed class SkeletonJsonReader
    {
        private static readonly float[] Scales1 = { 1, 1, 1, 1, 1, 1, 1 };
        private readonly List<PendingLink> m_Links = new();
        private readonly float m_Scale;
        private SkeletonDef m_Skeleton;

        private SkeletonJsonReader(float scale)
        {
            m_Scale = scale;
        }

        /// <summary>
        ///     Reads a whole JSON skeleton. <paramref name="scale" /> multiplies every positional value.
        /// </summary>
        /// <exception cref="SkeletonFormatException">The text is not a readable Spine 4.3 JSON skeleton.</exception>
        public static SkeletonDef Read(string json, float scale = 1)
        {
            if (json == null) throw new ArgumentNullException(nameof(json));

            if (scale == 0) throw new ArgumentOutOfRangeException(nameof(scale), "scale cannot be 0.");

            SkeletonJsonReader reader = new(scale);
            JsonNode root = JsonNode.Parse(json);
            if (!root.IsObject) throw new SkeletonFormatException("JSON skeleton root is not an object.");

            try
            {
                return reader.ReadSkeleton(root);
            }
            catch (SkeletonFormatException e)
            {
                throw new SkeletonFormatException(
                    $"JSON skeleton ({reader.m_Skeleton?.Version}): {e.Message}", e.InnerException);
            }
        }

        private SkeletonDef ReadSkeleton(JsonNode root)
        {
            SkeletonDef s = m_Skeleton = new SkeletonDef();

            // §4 Header.
            JsonNode header = root["skeleton"];
            if (header != null)
            {
                s.Hash = Str(header, "hash");
                s.Version = Str(header, "spine");
                CheckVersion(s.Version);
                s.X = Float(header, "x", 0);
                s.Y = Float(header, "y", 0);
                s.Width = Float(header, "width", 0);
                s.Height = Float(header, "height", 0);
                s.ReferenceScale = Float(header, "referenceScale", 100) * m_Scale;
                s.Fps = Float(header, "fps", 30);
                s.ImagesPath = Str(header, "images");
                s.AudioPath = Str(header, "audio");
            }
            else
            {
                throw new SkeletonFormatException("JSON has no \"skeleton\" header, so its Spine version is unknown");
            }

            s.Bones = ReadBones(root["bones"]);
            s.Slots = ReadSlots(root["slots"]);
            s.Constraints = ReadConstraints(root["constraints"]);
            s.Skins = ReadSkins(root["skins"]);
            ResolveLinkedMeshes();
            s.Events = ReadEvents(root["events"]);

            JsonNode animations = root["animations"];
            List<AnimationDef> list = new();
            if (animations != null)
                for (int i = 0; i < animations.Count; i++)
                    list.Add(ReadAnimation(animations.Keys[i], animations[i]));

            s.Animations = list.ToArray();

            // §13 Slider animations, resolved after all animations exist.
            JsonNode constraints = root["constraints"];
            for (int i = 0; constraints != null && i < constraints.Count; i++)
                if (s.Constraints[i] is SliderDef slider)
                {
                    string name = ReqStr(constraints[i], "animation");
                    slider.Animation = Array.FindIndex(s.Animations, a => a.Name == name);
                    if (slider.Animation < 0) throw Error($"slider '{slider.Name}' animation not found: {name}");
                }

            return s;
        }

        private static void CheckVersion(string version)
        {
            if (string.IsNullOrEmpty(version) || !version.StartsWith("4.3", StringComparison.Ordinal))
                throw new SkeletonFormatException(
                    $"JSON skeleton is version {version ?? "(none)"}; this reader supports Spine 4.3 only. Re-export it from Spine 4.3.");
        }

        // §5
        private BoneDef[] ReadBones(JsonNode bones)
        {
            List<BoneDef> list = new();
            for (int i = 0; bones != null && i < bones.Count; i++)
            {
                JsonNode map = bones[i];
                BoneDef b = new() { Name = ReqStr(map, "name") };
                string parent = Str(map, "parent");
                if (parent != null)
                {
                    b.Parent = list.FindIndex(x => x.Name == parent);
                    if (b.Parent < 0) throw Error($"parent bone not found: {parent}");
                }

                b.Length = Float(map, "length", 0) * m_Scale;
                b.X = Float(map, "x", 0) * m_Scale;
                b.Y = Float(map, "y", 0) * m_Scale;
                b.Rotation = Float(map, "rotation", 0);
                b.ScaleX = Float(map, "scaleX", 1);
                b.ScaleY = Float(map, "scaleY", 1);
                b.ShearX = Float(map, "shearX", 0);
                b.ShearY = Float(map, "shearY", 0);
                b.Inherit = Enum(map, "inherit", Inherit.Normal);
                b.SkinRequired = Bool(map, "skin", false);
                list.Add(b);
            }

            return list.ToArray();
        }

        // §6
        private SlotDef[] ReadSlots(JsonNode slots)
        {
            SlotDef[] list = new SlotDef[slots?.Count ?? 0];
            for (int i = 0; i < list.Length; i++)
            {
                JsonNode map = slots[i];
                SlotDef slot = new() { Name = ReqStr(map, "name") };
                slot.Bone = BoneIndex(ReqStr(map, "bone"));
                string color = Str(map, "color");
                if (color != null) slot.Color = Hex8(color);

                string dark = Str(map, "dark");
                if (dark != null)
                {
                    slot.HasDarkColor = true;
                    slot.DarkColor = Hex6(dark);
                }

                slot.AttachmentName = Str(map, "attachment");
                slot.Blend = Enum(map, "blend", BlendMode.Normal);
                list[i] = slot;
            }

            return list;
        }

        // §7
        private ConstraintDef[] ReadConstraints(JsonNode constraints)
        {
            ConstraintDef[] list = new ConstraintDef[constraints?.Count ?? 0];
            for (int i = 0; i < list.Length; i++)
            {
                JsonNode map = constraints[i];
                string type = ReqStr(map, "type");
                ConstraintDef c = type switch
                {
                    "ik" => ReadIk(map),
                    "transform" => ReadTransform(map),
                    "path" => ReadPathConstraint(map),
                    "physics" => ReadPhysics(map),
                    "slider" => ReadSlider(map),
                    _ => throw Error($"unknown constraint type '{type}'")
                };
                c.Name = ReqStr(map, "name");
                c.SkinRequired = Bool(map, "skin", false);
                list[i] = c;
            }

            return list;
        }

        // §7.2
        private IkDef ReadIk(JsonNode map)
        {
            IkDef ik = new() { Bones = BoneList(map["bones"]) };
            ik.Target = BoneIndex(ReqStr(map, "target"));
            ik.ScaleYMode = Enum(map, "scaleY", ScaleYMode.None);
            ik.Mix = Float(map, "mix", 1);
            ik.Softness = Float(map, "softness", 0) * m_Scale;
            ik.BendDirection = Bool(map, "bendPositive", true) ? 1 : -1;
            ik.Compress = Bool(map, "compress", false);
            ik.Stretch = Bool(map, "stretch", false);
            return ik;
        }

        // §7.3
        private TransformDef ReadTransform(JsonNode map)
        {
            TransformDef t = new() { Bones = BoneList(map["bones"]) };
            t.Source = BoneIndex(ReqStr(map, "source"));
            t.LocalSource = Bool(map, "localSource", false);
            t.LocalTarget = Bool(map, "localTarget", false);
            t.Additive = Bool(map, "additive", false);
            t.Clamp = Bool(map, "clamp", false);

            bool rotate = false, x = false, y = false, scaleX = false, scaleY = false, shearY = false;
            List<TransformFromDef> fromList = new();
            JsonNode properties = map["properties"];
            for (int i = 0; properties != null && i < properties.Count; i++)
            {
                TransformFromDef from = new() { Property = PropertyNamed(properties.Keys[i]) };
                float fromScale = PropertyScale(from.Property);
                JsonNode fromMap = properties[i];
                from.Offset = Float(fromMap, "offset", 0) * fromScale;
                List<TransformToDef> toList = new();
                JsonNode to = fromMap["to"];
                for (int j = 0; to != null && j < to.Count; j++)
                {
                    TransformToDef toDef = new() { Property = PropertyNamed(to.Keys[j]) };
                    float toScale = PropertyScale(toDef.Property);
                    JsonNode toMap = to[j];
                    toDef.Offset = Float(toMap, "offset", 0) * toScale;
                    toDef.Max = Float(toMap, "max", 1) * toScale;
                    toDef.Scale = Float(toMap, "scale", 1) * toScale / fromScale;
                    switch (toDef.Property)
                    {
                        case TransformProperty.Rotate: rotate = true; break;
                        case TransformProperty.X: x = true; break;
                        case TransformProperty.Y: y = true; break;
                        case TransformProperty.ScaleX: scaleX = true; break;
                        case TransformProperty.ScaleY: scaleY = true; break;
                        case TransformProperty.ShearY: shearY = true; break;
                    }

                    toList.Add(toDef);
                }

                // A from-property that drives nothing is dropped.
                if (toList.Count > 0)
                {
                    from.To = toList.ToArray();
                    fromList.Add(from);
                }
            }

            t.From = fromList.ToArray();
            t.OffsetRotation = Float(map, "rotation", 0);
            t.OffsetX = Float(map, "x", 0) * m_Scale;
            t.OffsetY = Float(map, "y", 0) * m_Scale;
            t.OffsetScaleX = Float(map, "scaleX", 0);
            t.OffsetScaleY = Float(map, "scaleY", 0);
            t.OffsetShearY = Float(map, "shearY", 0);

            // A mix is read only when some to-property of its kind exists; otherwise it stays 0.
            if (rotate) t.MixRotate = Float(map, "mixRotate", 1);
            if (x) t.MixX = Float(map, "mixX", 1);
            if (y) t.MixY = Float(map, "mixY", t.MixX);
            if (scaleX) t.MixScaleX = Float(map, "mixScaleX", 1);
            if (scaleY) t.MixScaleY = Float(map, "mixScaleY", t.MixScaleX);
            if (shearY) t.MixShearY = Float(map, "mixShearY", 1);
            return t;
        }

        // §7.4
        private PathConstraintDef ReadPathConstraint(JsonNode map)
        {
            PathConstraintDef p = new() { Bones = BoneList(map["bones"]) };
            p.Slot = SlotIndex(ReqStr(map, "slot"));
            p.PositionMode = Enum(map, "positionMode", PositionMode.Percent);
            p.SpacingMode = Enum(map, "spacingMode", SpacingMode.Length);
            p.RotateMode = Enum(map, "rotateMode", RotateMode.Tangent);
            p.OffsetRotation = Float(map, "rotation", 0);
            p.Position = Float(map, "position", 0) * PositionScale(p);
            p.Spacing = Float(map, "spacing", 0) * SpacingScale(p);
            p.MixRotate = Float(map, "mixRotate", 1);
            p.MixX = Float(map, "mixX", 1);
            p.MixY = Float(map, "mixY", p.MixX);
            return p;
        }

        // §7.5
        private PhysicsDef ReadPhysics(JsonNode map)
        {
            PhysicsDef p = new() { Bone = BoneIndex(ReqStr(map, "bone")) };
            p.X = Float(map, "x", 0);
            p.Y = Float(map, "y", 0);
            p.Rotate = Float(map, "rotate", 0);
            p.ScaleX = Float(map, "scaleX", 0);
            p.ScaleYMode = Enum(map, "scaleY", ScaleYMode.None);
            p.ShearX = Float(map, "shearX", 0);
            p.Limit = Float(map, "limit", 5000) * m_Scale;
            p.Step = 1f / Int(map, "fps", 60);
            p.Inertia = Float(map, "inertia", 0.5f);
            p.Strength = Float(map, "strength", 100);
            p.Damping = Float(map, "damping", 0.85f);
            p.MassInverse = 1f / Float(map, "mass", 1);
            p.Wind = Float(map, "wind", 0);
            p.Gravity = Float(map, "gravity", 0);
            p.Mix = Float(map, "mix", 1);
            p.InertiaGlobal = Bool(map, "inertiaGlobal", false);
            p.StrengthGlobal = Bool(map, "strengthGlobal", false);
            p.DampingGlobal = Bool(map, "dampingGlobal", false);
            p.MassGlobal = Bool(map, "massGlobal", false);
            p.WindGlobal = Bool(map, "windGlobal", false);
            p.GravityGlobal = Bool(map, "gravityGlobal", false);
            p.MixGlobal = Bool(map, "mixGlobal", false);
            return p;
        }

        // §7.6
        private SliderDef ReadSlider(JsonNode map)
        {
            SliderDef s = new();
            s.Additive = Bool(map, "additive", false);
            s.Loop = Bool(map, "loop", false);
            s.Mix = Float(map, "mix", 1);
            string bone = Str(map, "bone");
            if (bone != null)
            {
                s.Bone = BoneIndex(bone);
                s.Property = PropertyNamed(ReqStr(map, "property"));
                float propertyScale = PropertyScale(s.Property);
                s.PropertyOffset = Float(map, "from", 0) * propertyScale;
                s.Offset = Float(map, "to", 0);
                s.Scale = Float(map, "scale", 1) / propertyScale;
                s.Local = Bool(map, "local", false);
            }
            else
            {
                s.Time = Float(map, "time", 0);
            }

            return s;
        }

        // §8
        private SkinDef[] ReadSkins(JsonNode skins)
        {
            SkinDef[] list = new SkinDef[skins?.Count ?? 0];
            for (int i = 0; i < list.Length; i++)
            {
                JsonNode map = skins[i];
                SkinDef skin = new() { Name = ReqStr(map, "name") };
                skin.Bones = BoneList(map["bones"]);
                List<int> constraints = new();
                AddSkinConstraints(constraints, map["ik"], ConstraintKind.Ik);
                AddSkinConstraints(constraints, map["transform"], ConstraintKind.Transform);
                AddSkinConstraints(constraints, map["path"], ConstraintKind.Path);
                AddSkinConstraints(constraints, map["physics"], ConstraintKind.Physics);
                AddSkinConstraints(constraints, map["slider"], ConstraintKind.Slider);
                skin.Constraints = constraints.ToArray();

                JsonNode attachments = map["attachments"];
                for (int j = 0; attachments != null && j < attachments.Count; j++)
                {
                    int slot = SlotIndex(attachments.Keys[j]);
                    JsonNode slotMap = attachments[j];
                    for (int k = 0; k < slotMap.Count; k++)
                    {
                        string placeholder = slotMap.Keys[k];
                        AttachmentDef attachment = ReadAttachment(slotMap[k], slot, placeholder);
                        if (attachment != null) skin.Add(slot, placeholder, attachment);
                    }
                }

                list[i] = skin;
                if (skin.Name == "default") m_Skeleton.DefaultSkin = skin;
            }

            return list;
        }

        private void AddSkinConstraints(List<int> into, JsonNode names, ConstraintKind kind)
        {
            for (int i = 0; names != null && i < names.Count; i++) into.Add(ConstraintIndex(names[i].String, kind));
        }

        // §8.2–8.8
        private AttachmentDef ReadAttachment(JsonNode map, int slot, string placeholder)
        {
            string name = Str(map, "name") ?? placeholder;
            string type = Str(map, "type") ?? "region";
            switch (type.ToLowerInvariant())
            {
                case "region":
                {
                    RegionDef r = new() { Name = name };
                    r.Path = Str(map, "path") ?? name;
                    r.Sequence = ReadSequence(map["sequence"]);
                    r.X = Float(map, "x", 0) * m_Scale;
                    r.Y = Float(map, "y", 0) * m_Scale;
                    r.ScaleX = Float(map, "scaleX", 1);
                    r.ScaleY = Float(map, "scaleY", 1);
                    r.Rotation = Float(map, "rotation", 0);
                    r.Width = ReqFloat(map, "width") * m_Scale;
                    r.Height = ReqFloat(map, "height") * m_Scale;
                    string color = Str(map, "color");
                    if (color != null) r.Color = Hex8(color);
                    return r;
                }
                case "boundingbox":
                {
                    BoundingBoxDef b = new() { Name = name };
                    ReadVertices(map, b, Int(map, "vertexCount", 0) * 2);
                    return b;
                }
                case "mesh":
                case "linkedmesh":
                {
                    MeshDef m = new() { Name = name };
                    m.Path = Str(map, "path") ?? name;
                    m.Sequence = ReadSequence(map["sequence"]);
                    string color = Str(map, "color");
                    if (color != null) m.Color = Hex8(color);
                    m.Width = Float(map, "width", 0) * m_Scale;
                    m.Height = Float(map, "height", 0) * m_Scale;

                    string source = Str(map, "source");
                    if (source != null)
                    {
                        string sourceSlot = Str(map, "slot");
                        m_Links.Add(new PendingLink(m, Str(map, "skin"), slot,
                            sourceSlot == null ? slot : SlotIndex(sourceSlot), source,
                            Bool(map, "timelines", true)));
                        return m;
                    }

                    float[] uvs = FloatArray(map["uvs"] ?? throw Error($"mesh '{name}' has no uvs"));
                    ReadVertices(map, m, uvs.Length);
                    m.RegionUVs = uvs;
                    m.Triangles = IntArray(map["triangles"] ?? throw Error($"mesh '{name}' has no triangles"));
                    m.HullLength = Int(map, "hull", 0) * 2;
                    JsonNode edges = map["edges"];
                    if (edges != null) m.Edges = IntArray(edges);
                    return m;
                }
                case "path":
                {
                    PathAttachmentDef p = new() { Name = name };
                    p.Closed = Bool(map, "closed", false);
                    p.ConstantSpeed = Bool(map, "constantSpeed", true);
                    ReadVertices(map, p, Int(map, "vertexCount", 0) * 2);
                    float[] lengths = FloatArray(map["lengths"] ?? throw Error($"path '{name}' has no lengths"));
                    for (int i = 0; i < lengths.Length; i++) lengths[i] *= m_Scale;
                    p.Lengths = lengths;
                    return p;
                }
                case "point":
                {
                    PointDef p = new() { Name = name };
                    p.X = Float(map, "x", 0) * m_Scale;
                    p.Y = Float(map, "y", 0) * m_Scale;
                    p.Rotation = Float(map, "rotation", 0);
                    return p;
                }
                case "clipping":
                {
                    ClippingDef c = new() { Name = name };
                    string end = Str(map, "end");
                    if (end != null) c.EndSlot = SlotIndex(end);
                    ReadVertices(map, c, Int(map, "vertexCount", 0) * 2);
                    c.Convex = Bool(map, "convex", false);
                    c.Inverse = Bool(map, "inverse", false);
                    return c;
                }
                case "sequence":
                    // Parses, but yields no attachment (§8.2).
                    return null;
                default:
                    throw Error($"unknown attachment type '{type}' for '{name}'");
            }
        }

        // §17
        private static SequenceDef ReadSequence(JsonNode map)
        {
            if (map == null) return new SequenceDef();

            return new SequenceDef
            {
                Count = ReqInt(map, "count"), Start = Int(map, "start", 1), Digits = Int(map, "digits", 0),
                SetupIndex = Int(map, "setup", 0), HasPathSuffix = true
            };
        }

        // §8.9
        private void ReadVertices(JsonNode map, VertexAttachmentDef attachment, int length)
        {
            float[] values = FloatArray(map["vertices"] ?? throw Error($"'{attachment.Name}' has no vertices"));
            attachment.WorldVerticesLength = length;
            attachment.TimelineAttachment = attachment;
            if (values.Length == length)
            {
                for (int i = 0; i < values.Length; i++) values[i] *= m_Scale;
                attachment.Vertices = values;
                return;
            }

            List<int> bones = new();
            List<float> weights = new();
            for (int i = 0; i < values.Length;)
            {
                int n = (int)values[i++];
                bones.Add(n);
                for (int end = i + n * 4; i < end; i += 4)
                {
                    if (i + 3 >= values.Length) throw Error($"'{attachment.Name}' weighted vertices end mid-influence");

                    bones.Add(CheckBone((int)values[i]));
                    weights.Add(values[i + 1] * m_Scale);
                    weights.Add(values[i + 2] * m_Scale);
                    weights.Add(values[i + 3]);
                }
            }

            attachment.Bones = bones.ToArray();
            attachment.Vertices = weights.ToArray();
        }

        // §9
        private void ResolveLinkedMeshes()
        {
            foreach (PendingLink link in m_Links)
            {
                SkinDef skin = link.Skin == null
                    ? m_Skeleton.DefaultSkin
                    : Array.Find(m_Skeleton.Skins, s => s.Name == link.Skin);
                if (skin == null)
                    throw Error($"linked mesh '{link.Mesh.Name}': skin not found: {link.Skin ?? "default"}");

                if (!(skin.Get(link.SourceSlot, link.Source) is MeshDef source))
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

                if (link.InheritTimelines && link.OwnSlot != link.SourceSlot &&
                    Array.IndexOf(source.TimelineSlots, link.OwnSlot) < 0)
                {
                    int[] slots = new int[source.TimelineSlots.Length + 1];
                    source.TimelineSlots.CopyTo(slots, 0);
                    slots[slots.Length - 1] = link.OwnSlot;
                    source.TimelineSlots = slots;
                }
            }

            m_Links.Clear();
        }

        // §10
        private static EventDef[] ReadEvents(JsonNode events)
        {
            EventDef[] list = new EventDef[events?.Count ?? 0];
            for (int i = 0; i < list.Length; i++)
            {
                JsonNode map = events[i];
                EventDef e = new()
                {
                    Name = events.Keys[i], Int = Int(map, "int", 0), Float = Float(map, "float", 0),
                    String = Str(map, "string") ?? "", AudioPath = Str(map, "audio")
                };
                if (e.AudioPath != null)
                {
                    e.Volume = Float(map, "volume", 1);
                    e.Balance = Float(map, "balance", 0);
                }

                list[i] = e;
            }

            return list;
        }

        // §11
        private AnimationDef ReadAnimation(string name, JsonNode map)
        {
            AnimationDef animation = new() { Name = name };
            List<TimelineDef> timelines = animation.Timelines;
            SkeletonDef s = m_Skeleton;

            // §11.3 Slot timelines.
            JsonNode slots = map["slots"];
            for (int i = 0; slots != null && i < slots.Count; i++)
            {
                int slot = SlotIndex(slots.Keys[i]);
                JsonNode slotMap = slots[i];
                for (int j = 0; j < slotMap.Count; j++)
                {
                    JsonNode keys = slotMap[j];
                    if (keys.Count == 0) continue;
                    switch (slotMap.Keys[j])
                    {
                        case "attachment":
                        {
                            TimelineDef t = NewTimeline(TimelineKind.SlotAttachment, slot, keys.Count);
                            t.AttachmentNames = new string[keys.Count];
                            for (int f = 0; f < keys.Count; f++)
                            {
                                t.Frames[f] = Float(keys[f], "time", 0);
                                t.AttachmentNames[f] = Str(keys[f], "name");
                            }

                            timelines.Add(t);
                            break;
                        }
                        case "rgba":
                            timelines.Add(Curve(TimelineKind.SlotRgba, slot, keys, Scales1, (k, v) =>
                            {
                                float4 c = Hex8(ReqStr(k, "color"));
                                v[0] = c.x;
                                v[1] = c.y;
                                v[2] = c.z;
                                v[3] = c.w;
                            }));
                            break;
                        case "rgb":
                            timelines.Add(Curve(TimelineKind.SlotRgb, slot, keys, Scales1, (k, v) =>
                            {
                                float3 c = Hex6(ReqStr(k, "color"));
                                v[0] = c.x;
                                v[1] = c.y;
                                v[2] = c.z;
                            }));
                            break;
                        case "rgba2":
                            timelines.Add(Curve(TimelineKind.SlotRgba2, slot, keys, Scales1, (k, v) =>
                            {
                                float4 light = Hex8(ReqStr(k, "light"));
                                float3 dark = Hex6(ReqStr(k, "dark"));
                                v[0] = light.x;
                                v[1] = light.y;
                                v[2] = light.z;
                                v[3] = light.w;
                                v[4] = dark.x;
                                v[5] = dark.y;
                                v[6] = dark.z;
                            }));
                            break;
                        case "rgb2":
                            timelines.Add(Curve(TimelineKind.SlotRgb2, slot, keys, Scales1, (k, v) =>
                            {
                                float3 light = Hex6(ReqStr(k, "light"));
                                float3 dark = Hex6(ReqStr(k, "dark"));
                                v[0] = light.x;
                                v[1] = light.y;
                                v[2] = light.z;
                                v[3] = dark.x;
                                v[4] = dark.y;
                                v[5] = dark.z;
                            }));
                            break;
                        case "alpha":
                            timelines.Add(Curve(TimelineKind.SlotAlpha, slot, keys, Scales1,
                                (k, v) => v[0] = Float(k, "value", 0)));
                            break;
                    }
                }
            }

            // §11.4 Bone timelines.
            JsonNode bones = map["bones"];
            for (int i = 0; bones != null && i < bones.Count; i++)
            {
                int bone = BoneIndex(bones.Keys[i]);
                JsonNode boneMap = bones[i];
                for (int j = 0; j < boneMap.Count; j++)
                {
                    JsonNode keys = boneMap[j];
                    if (keys.Count == 0) continue;
                    float[] moved = { m_Scale, m_Scale };
                    switch (boneMap.Keys[j])
                    {
                        case "rotate":
                            timelines.Add(Value(TimelineKind.BoneRotate, bone, keys, 0, 1));
                            break;
                        case "translate":
                            timelines.Add(Curve(TimelineKind.BoneTranslate, bone, keys, moved,
                                (k, v) =>
                                {
                                    v[0] = Float(k, "x", 0) * m_Scale;
                                    v[1] = Float(k, "y", 0) * m_Scale;
                                }));
                            break;
                        case "translatex":
                            timelines.Add(Value(TimelineKind.BoneTranslateX, bone, keys, 0, m_Scale));
                            break;
                        case "translatey":
                            timelines.Add(Value(TimelineKind.BoneTranslateY, bone, keys, 0, m_Scale));
                            break;
                        case "scale":
                            timelines.Add(Curve(TimelineKind.BoneScale, bone, keys, Scales1,
                                (k, v) =>
                                {
                                    v[0] = Float(k, "x", 1);
                                    v[1] = Float(k, "y", 1);
                                }));
                            break;
                        case "scalex":
                            timelines.Add(Value(TimelineKind.BoneScaleX, bone, keys, 1, 1));
                            break;
                        case "scaley":
                            timelines.Add(Value(TimelineKind.BoneScaleY, bone, keys, 1, 1));
                            break;
                        case "shear":
                            timelines.Add(Curve(TimelineKind.BoneShear, bone, keys, Scales1,
                                (k, v) =>
                                {
                                    v[0] = Float(k, "x", 0);
                                    v[1] = Float(k, "y", 0);
                                }));
                            break;
                        case "shearx":
                            timelines.Add(Value(TimelineKind.BoneShearX, bone, keys, 0, 1));
                            break;
                        case "sheary":
                            timelines.Add(Value(TimelineKind.BoneShearY, bone, keys, 0, 1));
                            break;
                        case "inherit":
                        {
                            TimelineDef t = NewTimeline(TimelineKind.BoneInherit, bone, keys.Count);
                            for (int f = 0; f < keys.Count; f++)
                            {
                                t.Frames[f * 2] = Float(keys[f], "time", 0);
                                t.Frames[f * 2 + 1] = (float)Enum(keys[f], "inherit", Inherit.Normal);
                            }

                            timelines.Add(t);
                            break;
                        }
                    }
                }
            }

            // §11.5 IK timelines.
            JsonNode ik = map["ik"];
            for (int i = 0; ik != null && i < ik.Count; i++)
            {
                JsonNode keys = ik[i];
                if (keys.Count == 0) continue;
                int index = ConstraintIndex(ik.Keys[i], ConstraintKind.Ik);
                timelines.Add(Curve(TimelineKind.Ik, index, keys, new[] { 1, m_Scale }, (k, v) =>
                {
                    v[0] = Float(k, "mix", 1);
                    v[1] = Float(k, "softness", 0) * m_Scale;
                    v[2] = Bool(k, "bendPositive", true) ? 1 : -1;
                    v[3] = Bool(k, "compress", false) ? 1 : 0;
                    v[4] = Bool(k, "stretch", false) ? 1 : 0;
                }, 2));
            }

            // §11.6 Transform timelines.
            JsonNode transform = map["transform"];
            for (int i = 0; transform != null && i < transform.Count; i++)
            {
                JsonNode keys = transform[i];
                if (keys.Count == 0) continue;
                int index = ConstraintIndex(transform.Keys[i], ConstraintKind.Transform);
                timelines.Add(Curve(TimelineKind.Transform, index, keys, Scales1, (k, v) =>
                {
                    v[0] = Float(k, "mixRotate", 1);
                    v[1] = Float(k, "mixX", 1);
                    v[2] = Float(k, "mixY", v[1]);
                    v[3] = Float(k, "mixScaleX", 1);
                    v[4] = Float(k, "mixScaleY", 1);
                    v[5] = Float(k, "mixShearY", 1);
                }));
            }

            // §11.7 Path timelines.
            JsonNode path = map["path"];
            for (int i = 0; path != null && i < path.Count; i++)
            {
                int index = ConstraintIndex(path.Keys[i], ConstraintKind.Path);
                PathConstraintDef data = (PathConstraintDef)s.Constraints[index];
                JsonNode pathMap = path[i];
                for (int j = 0; j < pathMap.Count; j++)
                {
                    JsonNode keys = pathMap[j];
                    if (keys.Count == 0) continue;
                    switch (pathMap.Keys[j])
                    {
                        case "position":
                            timelines.Add(Value(TimelineKind.PathPosition, index, keys, 0, PositionScale(data)));
                            break;
                        case "spacing":
                            timelines.Add(Value(TimelineKind.PathSpacing, index, keys, 0, SpacingScale(data)));
                            break;
                        case "mix":
                            timelines.Add(Curve(TimelineKind.PathMix, index, keys, Scales1, (k, v) =>
                            {
                                v[0] = Float(k, "mixRotate", 1);
                                v[1] = Float(k, "mixX", 1);
                                v[2] = Float(k, "mixY", v[1]);
                            }));
                            break;
                    }
                }
            }

            // §11.8 Physics timelines. The empty name means every physics constraint.
            JsonNode physics = map["physics"];
            for (int i = 0; physics != null && i < physics.Count; i++)
            {
                int index = physics.Keys[i].Length == 0 ? -1 : ConstraintIndex(physics.Keys[i], ConstraintKind.Physics);
                JsonNode physicsMap = physics[i];
                for (int j = 0; j < physicsMap.Count; j++)
                {
                    JsonNode keys = physicsMap[j];
                    if (keys.Count == 0) continue;
                    switch (physicsMap.Keys[j])
                    {
                        case "reset":
                        {
                            TimelineDef t = NewTimeline(TimelineKind.PhysicsReset, index, keys.Count);
                            for (int f = 0; f < keys.Count; f++) t.Frames[f] = Float(keys[f], "time", 0);
                            timelines.Add(t);
                            break;
                        }
                        case "inertia":
                            timelines.Add(Value(TimelineKind.PhysicsInertia, index, keys, 0, 1));
                            break;
                        case "strength":
                            timelines.Add(Value(TimelineKind.PhysicsStrength, index, keys, 0, 1));
                            break;
                        case "damping":
                            timelines.Add(Value(TimelineKind.PhysicsDamping, index, keys, 0, 1));
                            break;
                        case "mass":
                            timelines.Add(Value(TimelineKind.PhysicsMass, index, keys, 0, 1));
                            break;
                        case "wind":
                            timelines.Add(Value(TimelineKind.PhysicsWind, index, keys, 0, 1));
                            break;
                        case "gravity":
                            timelines.Add(Value(TimelineKind.PhysicsGravity, index, keys, 0, 1));
                            break;
                        case "mix":
                            timelines.Add(Value(TimelineKind.PhysicsMix, index, keys, 1, 1));
                            break;
                    }
                }
            }

            // §11.9 Slider timelines.
            JsonNode slider = map["slider"];
            for (int i = 0; slider != null && i < slider.Count; i++)
            {
                int index = ConstraintIndex(slider.Keys[i], ConstraintKind.Slider);
                JsonNode sliderMap = slider[i];
                for (int j = 0; j < sliderMap.Count; j++)
                {
                    JsonNode keys = sliderMap[j];
                    if (keys.Count == 0) continue;
                    switch (sliderMap.Keys[j])
                    {
                        case "time":
                            timelines.Add(Value(TimelineKind.SliderTime, index, keys, 1, 1));
                            break;
                        case "mix":
                            timelines.Add(Value(TimelineKind.SliderMix, index, keys, 1, 1));
                            break;
                    }
                }
            }

            // §11.10 Attachment timelines.
            JsonNode attachments = map["attachments"];
            for (int i = 0; attachments != null && i < attachments.Count; i++)
            {
                string skinName = attachments.Keys[i];
                int skinIndex = Array.FindIndex(s.Skins, x => x.Name == skinName);
                if (skinIndex < 0) throw Error($"skin not found: {skinName}");
                SkinDef skin = s.Skins[skinIndex];
                JsonNode skinMap = attachments[i];
                for (int j = 0; j < skinMap.Count; j++)
                {
                    int slot = SlotIndex(skinMap.Keys[j]);
                    JsonNode slotMap = skinMap[j];
                    for (int k = 0; k < slotMap.Count; k++)
                    {
                        string attachmentName = slotMap.Keys[k];
                        AttachmentDef attachment = skin.Get(slot, attachmentName)
                                                   ?? throw Error($"timeline attachment not found: {attachmentName}");
                        JsonNode timelineMap = slotMap[k];
                        for (int n = 0; n < timelineMap.Count; n++)
                        {
                            JsonNode keys = timelineMap[n];
                            if (keys.Count == 0) continue;
                            TimelineDef t;
                            switch (timelineMap.Keys[n])
                            {
                                case "deform":
                                    t = Deform(slot, attachment, keys);
                                    break;
                                case "sequence":
                                    t = Sequence(slot, attachment, keys);
                                    break;
                                default:
                                    continue;
                            }

                            t.Skin = skinIndex;
                            timelines.Add(t);
                        }
                    }
                }
            }

            // §11.11 Draw order.
            JsonNode drawOrder = map["drawOrder"];
            if (drawOrder != null && drawOrder.Count > 0)
            {
                TimelineDef t = NewTimeline(TimelineKind.DrawOrder, -1, drawOrder.Count);
                t.DrawOrders = new int[drawOrder.Count][];
                for (int f = 0; f < drawOrder.Count; f++)
                {
                    JsonNode key = drawOrder[f];
                    t.Frames[f] = Float(key, "time", 0);
                    t.DrawOrders[f] = DrawOrder(key["offsets"], s.Slots.Length, SlotIndex);
                }

                timelines.Add(t);
            }

            // §11.12 Draw-order folders.
            JsonNode folders = map["drawOrderFolder"];
            for (int i = 0; folders != null && i < folders.Count; i++)
            {
                JsonNode folder = folders[i];
                JsonNode slotNames = folder["slots"] ?? throw Error("draw order folder has no slots");
                int[] folderSlots = new int[slotNames.Count];
                for (int j = 0; j < folderSlots.Length; j++) folderSlots[j] = SlotIndex(slotNames[j].String);
                JsonNode keys = folder["keys"] ?? throw Error("draw order folder has no keys");
                TimelineDef t = NewTimeline(TimelineKind.DrawOrderFolder, -1, keys.Count);
                t.FolderSlots = folderSlots;
                t.DrawOrders = new int[keys.Count][];
                for (int f = 0; f < keys.Count; f++)
                {
                    t.Frames[f] = Float(keys[f], "time", 0);
                    t.DrawOrders[f] = DrawOrder(keys[f]["offsets"], folderSlots.Length, slotName =>
                    {
                        int position = Array.IndexOf(folderSlots, SlotIndex(slotName));
                        return position >= 0 ? position : throw Error($"slot not in folder: {slotName}");
                    });
                }

                timelines.Add(t);
            }

            // §11.13 Events.
            JsonNode events = map["events"];
            if (events != null && events.Count > 0)
            {
                TimelineDef t = NewTimeline(TimelineKind.Event, -1, events.Count);
                t.Events = new EventFrame[events.Count];
                for (int f = 0; f < events.Count; f++)
                {
                    JsonNode key = events[f];
                    string eventName = ReqStr(key, "name");
                    int index = Array.FindIndex(s.Events, x => x.Name == eventName);
                    if (index < 0) throw Error($"event not found: {eventName}");
                    EventDef data = s.Events[index];
                    EventFrame e = new()
                    {
                        Time = Float(key, "time", 0), Event = index, Int = Int(key, "int", data.Int),
                        Float = Float(key, "float", data.Float), String = Str(key, "string") ?? data.String
                    };
                    if (data.AudioPath != null)
                    {
                        e.Volume = Float(key, "volume", data.Volume);
                        e.Balance = Float(key, "balance", data.Balance);
                    }

                    t.Frames[f] = e.Time;
                    t.Events[f] = e;
                }

                timelines.Add(t);
            }

            foreach (TimelineDef t in timelines) animation.Duration = Math.Max(animation.Duration, t.Duration);

            return animation;
        }

        /// <summary>
        ///     A one-channel curve timeline keyed by "value".
        /// </summary>
        private TimelineDef Value(TimelineKind kind, int target, JsonNode keys, float defaultValue, float scale)
        {
            return Curve(kind, target, keys, new[] { scale }, (k, v) => v[0] = Float(k, "value", defaultValue) * scale);
        }

        /// <summary>
        ///     §11.2 The generic curve loop. <paramref name="values" /> fills every value entry of one key (already
        ///     scaled); the first <paramref name="curveChannels" /> of them are curved (all, when 0).
        /// </summary>
        private TimelineDef Curve(TimelineKind kind, int target, JsonNode keys, float[] scales,
            Action<JsonNode, float[]> values, int curveChannels = 0)
        {
            TimelineDef t = NewTimeline(kind, target, keys.Count);
            int entries = t.FrameEntries;
            int channels = curveChannels > 0 ? curveChannels : entries - 1;

            int bezierCount = 0;
            for (int f = 0; f < keys.Count - 1; f++)
                if (keys[f]["curve"] is { IsArray: true })
                    bezierCount += channels;

            CurveBaker.Create(t, keys.Count, bezierCount);
            float[] value = new float[entries - 1];
            float[] next = new float[entries - 1];
            JsonNode key = keys[0];
            float time = Float(key, "time", 0);
            values(key, value);
            for (int frame = 0, bezier = 0;; frame++)
            {
                t.Frames[frame * entries] = time;
                Array.Copy(value, 0, t.Frames, frame * entries + 1, entries - 1);
                if (frame == keys.Count - 1) break;

                JsonNode nextKey = keys[frame + 1];
                float time2 = Float(nextKey, "time", 0);
                values(nextKey, next);
                JsonNode curve = key["curve"];
                if (curve != null)
                {
                    if (curve.Kind == JsonNode.Type.String)
                    {
                        if (curve.String == "stepped") CurveBaker.SetStepped(t.Curves, frame);
                    }
                    else if (curve.IsArray)
                    {
                        for (int c = 0; c < channels; c++)
                        {
                            float cx1 = CurveNumber(curve, c * 4), cy1 = CurveNumber(curve, c * 4 + 1) * scales[c];
                            float cx2 = CurveNumber(curve, c * 4 + 2), cy2 = CurveNumber(curve, c * 4 + 3) * scales[c];
                            CurveBaker.Bezier(t, keys.Count, bezier++, frame, c, time, value[c], cx1, cy1, cx2,
                                cy2, time2, next[c]);
                        }
                    }
                }

                time = time2;
                key = nextKey;
                (value, next) = (next, value);
            }

            return t;
        }

        private float CurveNumber(JsonNode curve, int index)
        {
            if (index >= curve.Count || curve[index].Kind != JsonNode.Type.Number)
                throw Error($"bezier curve needs {index + 1} numbers, has {curve.Count}");

            return curve[index].Number;
        }

        // §11.10 deform
        private TimelineDef Deform(int slot, AttachmentDef attachment, JsonNode keys)
        {
            if (!(attachment is VertexAttachmentDef vertexAttachment))
                throw Error($"deform timeline on '{attachment.Name}', which has no vertices");

            bool weighted = vertexAttachment.IsWeighted;
            float[] setup = vertexAttachment.Vertices;
            int deformLength = weighted ? setup.Length / 3 * 2 : setup.Length;

            TimelineDef t = NewTimeline(TimelineKind.Deform, slot, keys.Count);
            t.Attachment = attachment;
            t.Deform = new float[keys.Count][];
            int bezierCount = 0;
            for (int f = 0; f < keys.Count - 1; f++)
                if (keys[f]["curve"] is { IsArray: true })
                    bezierCount++;

            CurveBaker.Create(t, keys.Count, bezierCount);
            JsonNode key = keys[0];
            float time = Float(key, "time", 0);
            for (int frame = 0, bezier = 0;; frame++)
            {
                float[] deform;
                JsonNode vertices = key["vertices"];
                if (vertices == null)
                {
                    deform = weighted ? new float[deformLength] : setup;
                }
                else
                {
                    deform = new float[deformLength];
                    int start = Int(key, "offset", 0);
                    float[] values = FloatArray(vertices);
                    if (start < 0 || start + values.Length > deformLength)
                        throw Error($"deform key writes past '{attachment.Name}' ({deformLength} floats)");

                    for (int v = 0; v < values.Length; v++) deform[start + v] = values[v] * m_Scale;
                    if (!weighted)
                        for (int v = 0; v < deformLength; v++)
                            deform[v] += setup[v];
                }

                t.Frames[frame] = time;
                t.Deform[frame] = deform;
                if (frame == keys.Count - 1) break;

                JsonNode nextKey = keys[frame + 1];
                float time2 = Float(nextKey, "time", 0);
                JsonNode curve = key["curve"];
                if (curve != null)
                {
                    if (curve.Kind == JsonNode.Type.String)
                    {
                        if (curve.String == "stepped") CurveBaker.SetStepped(t.Curves, frame);
                    }
                    else if (curve.IsArray)
                    {
                        // The percentage curve uses the simplified deform bake, as the binary reader does.
                        CurveBaker.DeformBezier(t, keys.Count, bezier++, frame, time, CurveNumber(curve, 0),
                            CurveNumber(curve, 1), CurveNumber(curve, 2), CurveNumber(curve, 3), time2);
                    }
                }

                time = time2;
                key = nextKey;
            }

            return t;
        }

        // §11.10 sequence
        private TimelineDef Sequence(int slot, AttachmentDef attachment, JsonNode keys)
        {
            if (!(attachment is RegionDef) && !(attachment is MeshDef))
                throw Error($"sequence timeline on '{attachment.Name}', which has no sequence");

            TimelineDef t = NewTimeline(TimelineKind.Sequence, slot, keys.Count);
            t.Attachment = attachment;
            float delay = 0;
            for (int f = 0; f < keys.Count; f++)
            {
                JsonNode key = keys[f];
                delay = Float(key, "delay", delay);
                int mode = (int)Enum(key, "mode", SequenceMode.Hold);
                t.Frames[f * 3] = Float(key, "time", 0);
                t.Frames[f * 3 + 1] = mode | (Int(key, "index", 0) << 4);
                t.Frames[f * 3 + 2] = delay;
            }

            return t;
        }

        // §11.11. The offsets must name each slot at most once, in slot order, and move no two to one place: the
        // algorithm (stock's) runs past its arrays otherwise, so each of those is refused, all positions first.
        private int[] DrawOrder(JsonNode offsets, int size, Func<string, int> positionOf)
        {
            if (offsets == null) return null;

            if (offsets.Count > size) throw Error($"draw order changes {offsets.Count} of {size} items");

            int[] positions = new int[offsets.Count];
            for (int i = 0; i < offsets.Count; i++)
            {
                string slot = ReqStr(offsets[i], "slot");
                positions[i] = positionOf(slot);
                if (i > 0 && positions[i] <= positions[i - 1])
                    throw Error(positions[i] == positions[i - 1]
                        ? $"draw order moves slot {slot} twice"
                        : $"draw order lists slot {slot} after a slot that follows it");
            }

            int[] order = new int[size];
            for (int i = 0; i < size; i++) order[i] = -1;
            int[] unchanged = new int[size - offsets.Count];
            int original = 0, u = 0;
            for (int i = 0; i < offsets.Count; i++)
            {
                while (original != positions[i]) unchanged[u++] = original++;
                int target = original + ReqInt(offsets[i], "offset");
                if (target < 0 || target >= size) throw Error($"draw order offset moves past {size} items");
                if (order[target] != -1)
                    throw Error($"draw order moves slot {Str(offsets[i], "slot")} to a place another slot takes");

                order[target] = original++;
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

        // Lookups.

        private int[] BoneList(JsonNode names)
        {
            int[] bones = new int[names?.Count ?? 0];
            for (int i = 0; i < bones.Length; i++) bones[i] = BoneIndex(names[i].String);
            return bones;
        }

        private int BoneIndex(string name)
        {
            int index = Array.FindIndex(m_Skeleton.Bones, b => b.Name == name);
            return index >= 0 ? index : throw Error($"bone not found: {name}");
        }

        private int CheckBone(int index)
        {
            return index >= 0 && index < m_Skeleton.Bones.Length
                ? index
                : throw Error($"bone index {index} out of range");
        }

        private int SlotIndex(string name)
        {
            int index = Array.FindIndex(m_Skeleton.Slots, s => s.Name == name);
            return index >= 0 ? index : throw Error($"slot not found: {name}");
        }

        private int ConstraintIndex(string name, ConstraintKind kind)
        {
            int index = Array.FindIndex(m_Skeleton.Constraints, c => c.Name == name && c.Kind == kind);
            return index >= 0 ? index : throw Error($"{kind} constraint not found: {name}");
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

        private TransformProperty PropertyNamed(string name)
        {
            return name switch
            {
                "rotate" => TransformProperty.Rotate,
                "x" => TransformProperty.X,
                "y" => TransformProperty.Y,
                "scaleX" => TransformProperty.ScaleX,
                "scaleY" => TransformProperty.ScaleY,
                "shearY" => TransformProperty.ShearY,
                _ => throw Error($"unknown transform property '{name}'")
            };
        }

        // Typed value access. A present key of the wrong type is an error, never a silent default.

        private static float Float(JsonNode map, string key, float defaultValue)
        {
            JsonNode node = map[key];
            if (node == null) return defaultValue;
            return node.Kind == JsonNode.Type.Number
                ? node.Number
                : throw new SkeletonFormatException($"\"{key}\" is not a number");
        }

        private static float ReqFloat(JsonNode map, string key)
        {
            return map.Has(key) ? Float(map, key, 0) : throw new SkeletonFormatException($"missing \"{key}\"");
        }

        private static int Int(JsonNode map, string key, int defaultValue)
        {
            return map.Has(key) ? (int)Float(map, key, 0) : defaultValue;
        }

        private static int ReqInt(JsonNode map, string key)
        {
            return map.Has(key) ? (int)Float(map, key, 0) : throw new SkeletonFormatException($"missing \"{key}\"");
        }

        private static bool Bool(JsonNode map, string key, bool defaultValue)
        {
            JsonNode node = map[key];
            if (node == null) return defaultValue;
            return node.Kind switch
            {
                JsonNode.Type.True => true,
                JsonNode.Type.False => false,
                _ => throw new SkeletonFormatException($"\"{key}\" is not true or false")
            };
        }

        private static string Str(JsonNode map, string key)
        {
            JsonNode node = map[key];
            if (node == null || node.Kind == JsonNode.Type.Null) return null;
            return node.Kind == JsonNode.Type.String
                ? node.String
                : throw new SkeletonFormatException($"\"{key}\" is not a string");
        }

        private static string ReqStr(JsonNode map, string key)
        {
            return Str(map, key) ?? throw new SkeletonFormatException($"missing \"{key}\"");
        }

        private static T Enum<T>(JsonNode map, string key, T defaultValue) where T : struct, Enum
        {
            string value = Str(map, key);
            if (value == null) return defaultValue;
            foreach (T member in (T[])System.Enum.GetValues(typeof(T)))
                if (string.Equals(member.ToString(), value, StringComparison.OrdinalIgnoreCase))
                    return member;

            throw new SkeletonFormatException($"\"{key}\": unknown value '{value}'");
        }

        private static float[] FloatArray(JsonNode array)
        {
            float[] values = new float[array.Count];
            for (int i = 0; i < values.Length; i++)
                values[i] = array[i].Kind == JsonNode.Type.Number
                    ? array[i].Number
                    : throw new SkeletonFormatException("array holds a non-number");

            return values;
        }

        private static int[] IntArray(JsonNode array)
        {
            float[] values = FloatArray(array);
            int[] ints = new int[values.Length];
            for (int i = 0; i < ints.Length; i++) ints[i] = (int)values[i];
            return ints;
        }

        private static float4 Hex8(string hex)
        {
            if (hex.Length < 8) throw new SkeletonFormatException($"colour '{hex}' needs 8 hex digits");
            return new float4(Channel(hex, 0), Channel(hex, 1), Channel(hex, 2), Channel(hex, 3));
        }

        private static float3 Hex6(string hex)
        {
            if (hex.Length < 6) throw new SkeletonFormatException($"colour '{hex}' needs 6 hex digits");
            return new float3(Channel(hex, 0), Channel(hex, 1), Channel(hex, 2));
        }

        private static float Channel(string hex, int index)
        {
            if (!int.TryParse(hex.Substring(index * 2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture,
                    out int value))
                throw new SkeletonFormatException($"colour '{hex}' is not hex");

            return value / 255f;
        }

        private static SkeletonFormatException Error(string message)
        {
            return new SkeletonFormatException(message);
        }

        private enum SequenceMode
        {
            Hold,
            Once,
            Loop,
            Pingpong,
            OnceReverse,
            LoopReverse,
            PingpongReverse
        }

        private readonly struct PendingLink
        {
            public readonly MeshDef Mesh;
            public readonly string Skin;
            public readonly int OwnSlot, SourceSlot;
            public readonly string Source;
            public readonly bool InheritTimelines;

            public PendingLink(MeshDef mesh, string skin, int ownSlot, int sourceSlot, string source,
                bool inheritTimelines)
            {
                Mesh = mesh;
                Skin = skin;
                OwnSlot = ownSlot;
                SourceSlot = sourceSlot;
                Source = source;
                InheritTimelines = inheritTimelines;
            }
        }
    }
}