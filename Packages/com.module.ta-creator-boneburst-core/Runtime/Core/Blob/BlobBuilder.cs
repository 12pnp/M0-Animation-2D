using System;
using System.Collections.Generic;
using BoneBurst.Anim;
using BoneBurst.Data;
using Unity.Mathematics;

namespace BoneBurst.Blob
{
    /// <summary>
    ///     Flattens a <see cref="SkeletonDef" /> and its <see cref="AtlasDef" /> into a <see cref="SkeletonBlob" />:
    ///     setup pose, and every attachment with its atlas UVs and region offsets already resolved per sequence
    ///     frame, so no per-frame job ever looks at the atlas.
    /// </summary>
    /// <remarks>
    ///     UV and offset formulas: <c>Doc/Format/Format-Json-Atlas.md</c> §16. <paramref name="flipV" /> applies
    ///     Unity's bottom-up V (spine-unity does the same with <c>FlipV</c> before computing UVs); the formulas are
    ///     affine in V, so they apply unchanged to the flipped values.
    /// </remarks>
    public static class BlobBuilder
    {
        // Timelines.md §6: Property enum ordinals.
        private const ulong Rotate = 0,
            X = 1,
            Y = 2,
            ScaleX = 3,
            ScaleY = 4,
            ShearX = 5,
            ShearY = 6,
            Inherit = 7,
            Rgb = 8,
            Alpha = 9,
            Rgb2 = 10,
            Attachment = 11,
            Deform = 12,
            Event = 13,
            DrawOrder = 14,
            DrawOrderFolder = 15,
            Ik = 16,
            Transform = 17,
            PathPosition = 18,
            PathSpacing = 19,
            PathMix = 20,
            PhysicsInertia = 21,
            PhysicsReset = 28,
            Sequence = 29,
            SliderTime = 30,
            SliderMix = 31;

        /// <summary>
        ///     Builds the native blob every instance of an asset shares.
        /// </summary>
        /// <exception cref="SkeletonFormatException">An attachment names a region the atlas does not have.</exception>
        public static SkeletonBlob Build(SkeletonDef skeleton, AtlasDef atlas, bool flipV = true)
        {
            return new SkeletonBlob(BuildContent(skeleton, atlas, flipV));
        }

        /// <summary>
        ///     Builds the blob's content as managed arrays.
        /// </summary>
        /// <exception cref="SkeletonFormatException">An attachment names a region the atlas does not have.</exception>
        public static BlobContent BuildContent(SkeletonDef skeleton, AtlasDef atlas, bool flipV = true)
        {
            if (skeleton == null) throw new ArgumentNullException(nameof(skeleton));
            if (atlas == null) throw new ArgumentNullException(nameof(atlas));

            BlobContent blob = new() { Skeleton = skeleton, PageCount = atlas.Pages.Count };
            BuildSetup(skeleton, blob);

            // Every distinct attachment object gets one index, in skin order.
            Dictionary<AttachmentDef, int> indexOf = new();
            List<AttachmentDef> attachments = new();
            foreach (SkinDef skin in skeleton.Skins)
            foreach (SkinEntry entry in skin.Entries)
                if (!indexOf.ContainsKey(entry.Attachment))
                {
                    indexOf.Add(entry.Attachment, attachments.Count);
                    attachments.Add(entry.Attachment);
                }

            List<float> vertices = new();
            List<int> bones = new();
            List<int> triangles = new();
            List<float> uvs = new();
            List<float> offsets = new();
            List<int> timelineSlots = new();
            List<float> pathLengths = new();
            List<int> framePages = new();
            AttachmentBlob[] flat = new AttachmentBlob[attachments.Count];
            for (int i = 0; i < flat.Length; i++)
            {
                AttachmentDef def = attachments[i];
                AttachmentBlob a = new()
                {
                    Kind = def.Kind, BonesStart = -1, Page = -1, Color = new float4(1, 1, 1, 1),
                    TimelineAttachment = i, UvStart = -1, OffsetStart = -1, ClipEndSlot = -1
                };
                switch (def)
                {
                    case RegionDef region:
                        a.VertexCount = 4;
                        a.Color = region.Color;
                        a.FrameCount = region.Sequence.Count;
                        a.SetupFrame = region.Sequence.SetupIndex;
                        a.UvStart = uvs.Count;
                        a.OffsetStart = offsets.Count;
                        a.PageStart = framePages.Count;
                        for (int k = 0; k < region.Sequence.Count; k++)
                        {
                            AtlasRegionDef r = FindRegion(atlas, region.Sequence.FramePath(region.Path, k),
                                region.Name);
                            if (k == 0) a.Page = r.Page;
                            framePages.Add(r.Page);
                            RegionFrame(region, Flip(r, flipV), offsets, uvs);
                        }

                        break;
                    case VertexAttachmentDef vertex:
                        a.VertexCount = vertex.WorldVerticesLength / 2;
                        a.VerticesStart = vertices.Count;
                        vertices.AddRange(vertex.Vertices ?? Array.Empty<float>());
                        if (vertex.IsWeighted)
                        {
                            a.BonesStart = bones.Count;
                            bones.AddRange(vertex.Bones);
                        }

                        if (vertex.TimelineAttachment != null &&
                            indexOf.TryGetValue(vertex.TimelineAttachment, out int timeline))
                            a.TimelineAttachment = timeline;

                        if (vertex is ClippingDef clip)
                        {
                            a.ClipEndSlot = clip.EndSlot;
                            a.ClipConvex = clip.Convex;
                            a.ClipInverse = clip.Inverse;
                        }

                        if (vertex is PathAttachmentDef path)
                        {
                            a.Closed = path.Closed;
                            a.ConstantSpeed = path.ConstantSpeed;
                            a.LengthsStart = pathLengths.Count;
                            pathLengths.AddRange(path.Lengths ?? Array.Empty<float>());
                        }

                        if (vertex is MeshDef mesh)
                        {
                            a.TimelineSlotsStart = timelineSlots.Count;
                            a.TimelineSlotsCount = mesh.TimelineSlots.Length;
                            timelineSlots.AddRange(mesh.TimelineSlots);
                            a.Color = mesh.Color;
                            a.TriangleStart = triangles.Count;
                            a.TriangleCount = mesh.Triangles.Length;
                            triangles.AddRange(mesh.Triangles);
                            a.FrameCount = mesh.Sequence.Count;
                            a.SetupFrame = mesh.Sequence.SetupIndex;
                            a.UvStart = uvs.Count;
                            a.PageStart = framePages.Count;
                            for (int k = 0; k < mesh.Sequence.Count; k++)
                            {
                                AtlasRegionDef r = FindRegion(atlas, mesh.Sequence.FramePath(mesh.Path, k), mesh.Name);
                                if (k == 0) a.Page = r.Page;
                                framePages.Add(r.Page);
                                MeshFrame(mesh.RegionUVs, Flip(r, flipV), uvs);
                            }
                        }

                        break;
                }

                flat[i] = a;
            }

            blob.Attachments = flat;
            BuildSkins(skeleton, blob, indexOf);
            foreach (AttachmentBlob a in flat)
                if (a.Kind == AttachmentKind.Clipping)
                {
                    blob.ClipPolygonMax = Math.Max(blob.ClipPolygonMax, a.VertexCount * 2);
                }
                else if (a.Kind == AttachmentKind.Region || a.Kind == AttachmentKind.Mesh ||
                         a.Kind == AttachmentKind.LinkedMesh)
                {
                    blob.RenderVerticesMax = Math.Max(blob.RenderVerticesMax, a.VertexCount * 2);
                    blob.RenderTrianglesMax = Math.Max(blob.RenderTrianglesMax,
                        a.Kind == AttachmentKind.Region ? 6 : a.TriangleCount);
                }

            blob.AttachmentDefs = attachments.ToArray();
            blob.Vertices = vertices.ToArray();
            blob.Bones = bones.ToArray();
            blob.Triangles = triangles.ToArray();
            blob.Uvs = uvs.ToArray();
            blob.Offsets = offsets.ToArray();
            blob.TimelineSlots = timelineSlots.ToArray();
            blob.PathLengths = pathLengths.ToArray();
            blob.FramePages = framePages.ToArray();
            BuildConstraints(skeleton, blob);
            BuildAnimations(skeleton, blob, indexOf);
            BuildSolverData(skeleton, blob);
            return blob;
        }

        /// <summary>
        ///     Flattens every animation's timelines into shared arrays, interns attachment-timeline names as
        ///     <see cref="AttachmentKey" />s, and sizes each slot's deform buffer.
        /// </summary>
        private static void BuildAnimations(SkeletonDef skeleton, BlobContent blob,
            Dictionary<AttachmentDef, int> indexOf)
        {
            List<AnimationBlob> animations = new();
            List<TimelineBlob> timelines = new();
            List<float> frames = new(), curves = new(), deform = new();
            List<int> ints = new();
            List<EventBlob> events = new();
            List<AttachmentKey> keys = new();
            Dictionary<(int, string), int> keyIndex = new();
            List<string> strings = new();
            Dictionary<string, int> stringIndex = new();
            int[] deformCapacity = new int[skeleton.Slots.Length];
            int maxEvents = 0;
            List<ulong[]> ids = new();
            List<bool> instant = new();

            foreach (AnimationDef animation in skeleton.Animations)
            {
                animations.Add(new AnimationBlob
                {
                    Duration = animation.Duration, TimelineStart = timelines.Count,
                    TimelineCount = animation.Timelines.Count
                });
                foreach (TimelineDef t in animation.Timelines)
                {
                    TimelineBlob tb = new()
                    {
                        Kind = t.Kind, Target = t.Target, FrameCount = t.FrameCount, Entries = t.FrameEntries,
                        FramesStart = frames.Count, CurvesStart = -1, ExtraStart = -1, FolderStart = -1, Attachment = -1
                    };
                    if (t.Frames != null) frames.AddRange(t.Frames);
                    if (t.Curves != null)
                    {
                        tb.CurvesStart = curves.Count;
                        curves.AddRange(t.Curves);
                    }

                    switch (t.Kind)
                    {
                        case TimelineKind.SlotAttachment:
                            tb.ExtraStart = ints.Count;
                            foreach (string name in t.AttachmentNames)
                                ints.Add(name == null ? -1 : Key(t.Target, name));

                            break;
                        case TimelineKind.Deform:
                        {
                            tb.Attachment = indexOf[t.Attachment];
                            tb.ExtraStart = deform.Count;
                            tb.ExtraLength = t.Deform.Length > 0 ? t.Deform[0].Length : 0;
                            foreach (float[] values in t.Deform) deform.AddRange(values);

                            deformCapacity[t.Target] = Math.Max(deformCapacity[t.Target], tb.ExtraLength);
                            if (t.Attachment is MeshDef mesh)
                                foreach (int slot in mesh.TimelineSlots)
                                    deformCapacity[slot] = Math.Max(deformCapacity[slot], tb.ExtraLength);

                            break;
                        }
                        case TimelineKind.BoneTranslateSpline:
                            // The path's table lives in the shared float pool the deform timelines use.
                            tb.ExtraStart = deform.Count;
                            tb.ExtraLength = t.Spline.Length;
                            deform.AddRange(t.Spline);
                            break;
                        case TimelineKind.Sequence:
                            tb.Attachment = indexOf[t.Attachment];
                            break;
                        case TimelineKind.DrawOrder:
                        case TimelineKind.DrawOrderFolder:
                        {
                            int size = t.Kind == TimelineKind.DrawOrder ? skeleton.Slots.Length : t.FolderSlots.Length;
                            tb.ExtraLength = size;
                            if (t.FolderSlots != null)
                            {
                                tb.FolderStart = ints.Count;
                                ints.AddRange(t.FolderSlots);
                            }

                            tb.ExtraStart = ints.Count;
                            foreach (int[] order in t.DrawOrders)
                            {
                                ints.Add(order == null ? 1 : 0);
                                for (int i = 0; i < size; i++) ints.Add(order == null ? i : order[i]);
                            }

                            break;
                        }
                        case TimelineKind.Event:
                            maxEvents = Math.Max(maxEvents, t.Events.Length);
                            tb.ExtraStart = events.Count;
                            foreach (EventFrame e in t.Events)
                                events.Add(new EventBlob
                                {
                                    Time = e.Time, Event = e.Event, Int = e.Int, Float = e.Float,
                                    String = String(e.String), Volume = e.Volume, Balance = e.Balance
                                });

                            break;
                    }

                    timelines.Add(tb);
                    ids.Add(PropertyIds(t, tb));
                    instant.Add(IsInstant(t.Kind));
                }

                blob.MaxTimelines = Math.Max(blob.MaxTimelines, animation.Timelines.Count);
            }

            blob.TimelineIds = ids.ToArray();
            blob.TimelineInstant = instant.ToArray();

            blob.Animations = animations.ToArray();
            blob.Timelines = timelines.ToArray();
            blob.Frames = frames.ToArray();
            blob.Curves = curves.ToArray();
            blob.Ints = ints.ToArray();
            blob.DeformFrames = deform.ToArray();
            blob.Events = events.ToArray();
            blob.AttachmentKeys = keys.ToArray();
            blob.EventStrings = strings.ToArray();
            blob.SlotDeformCapacity = deformCapacity;
            blob.SlotDeformStart = new int[deformCapacity.Length];
            int total = 0;
            for (int i = 0; i < deformCapacity.Length; i++)
            {
                blob.SlotDeformStart[i] = total;
                total += deformCapacity[i];
            }

            blob.DeformTotal = total;
            // A wrapped apply fires the tail and then the head: at most every key twice.
            blob.MaxEventsPerApply = maxEvents * 2;

            int Key(int slot, string name)
            {
                if (!keyIndex.TryGetValue((slot, name), out int index))
                {
                    index = keys.Count;
                    keyIndex.Add((slot, name), index);
                    keys.Add(new AttachmentKey { Slot = slot, Name = name });
                }

                return index;
            }

            int String(string value)
            {
                if (value == null) return -1;
                if (!stringIndex.TryGetValue(value, out int index))
                {
                    index = strings.Count;
                    stringIndex.Add(value, index);
                    strings.Add(value);
                }

                return index;
            }
        }

        /// <summary>
        ///     The property IDs a timeline keys (Timelines.md §6). Deform and sequence IDs use the blob attachment
        ///     index where stock uses a process-wide attachment id; both only need to be equal for the same
        ///     attachment.
        /// </summary>
        private static ulong[] PropertyIds(TimelineDef t, TimelineBlob tb)
        {
            ulong target = (ulong)(uint)t.Target;

            ulong Id(ulong property)
            {
                return (property << 53) | target;
            }

            switch (t.Kind)
            {
                case TimelineKind.BoneRotate: return new[] { Id(Rotate) };
                case TimelineKind.BoneTranslate:
                case TimelineKind.BoneTranslateSpline: return new[] { Id(X), Id(Y) };
                case TimelineKind.BoneTranslateX: return new[] { Id(X) };
                case TimelineKind.BoneTranslateY: return new[] { Id(Y) };
                case TimelineKind.BoneScale: return new[] { Id(ScaleX), Id(ScaleY) };
                case TimelineKind.BoneScaleX: return new[] { Id(ScaleX) };
                case TimelineKind.BoneScaleY: return new[] { Id(ScaleY) };
                case TimelineKind.BoneShear: return new[] { Id(ShearX), Id(ShearY) };
                case TimelineKind.BoneShearX: return new[] { Id(ShearX) };
                case TimelineKind.BoneShearY: return new[] { Id(ShearY) };
                case TimelineKind.BoneInherit: return new[] { Id(Inherit) };
                case TimelineKind.SlotRgba: return new[] { Id(Rgb), Id(Alpha) };
                case TimelineKind.SlotRgb: return new[] { Id(Rgb) };
                case TimelineKind.SlotAlpha: return new[] { Id(Alpha) };
                case TimelineKind.SlotRgba2: return new[] { Id(Rgb), Id(Alpha), Id(Rgb2) };
                case TimelineKind.SlotRgb2: return new[] { Id(Rgb), Id(Rgb2) };
                case TimelineKind.SlotAttachment: return new[] { Id(Attachment) };
                case TimelineKind.Deform: return new[] { (Deform << 53) | (target << 32) | (ulong)(uint)tb.Attachment };
                case TimelineKind.Sequence:
                    return new[] { (Sequence << 53) | (target << 32) | (ulong)(uint)tb.Attachment };
                case TimelineKind.Event: return new[] { Event << 58 };
                case TimelineKind.DrawOrder: return new[] { DrawOrder << 53 };
                case TimelineKind.DrawOrderFolder:
                {
                    ulong[] folder = new ulong[t.FolderSlots.Length];
                    for (int i = 0; i < folder.Length; i++)
                        folder[i] = (DrawOrderFolder << 53) | (ulong)(uint)t.FolderSlots[i];
                    return folder;
                }
                case TimelineKind.Ik: return new[] { Id(Ik) };
                case TimelineKind.Transform: return new[] { Id(Transform) };
                case TimelineKind.PathPosition: return new[] { Id(PathPosition) };
                case TimelineKind.PathSpacing: return new[] { Id(PathSpacing) };
                case TimelineKind.PathMix: return new[] { Id(PathMix) };
                case TimelineKind.PhysicsReset: return new[] { PhysicsReset << 58 };
                case TimelineKind.SliderTime: return new[] { Id(SliderTime) };
                case TimelineKind.SliderMix: return new[] { Id(SliderMix) };
                default:
                    // Physics inertia..mix are consecutive in both enums.
                    return new[] { Id(PhysicsInertia + (ulong)(t.Kind - TimelineKind.PhysicsInertia)) };
            }
        }

        private static bool IsInstant(TimelineKind kind)
        {
            return kind == TimelineKind.SlotAttachment || kind == TimelineKind.DrawOrder ||
                   kind == TimelineKind.DrawOrderFolder || kind == TimelineKind.BoneInherit ||
                   kind == TimelineKind.Sequence || kind == TimelineKind.Event || kind == TimelineKind.PhysicsReset;
        }

        /// <summary>
        ///     Setup pose and activation data of every constraint.
        /// </summary>
        private static void BuildConstraints(SkeletonDef skeleton, BlobContent blob)
        {
            int count = skeleton.Constraints.Length;
            blob.ConstraintSetups = new ConstraintPose[count];
            blob.ConstraintInfos = new ConstraintInfo[count];
            for (int i = 0; i < count; i++)
            {
                ConstraintDef c = skeleton.Constraints[i];
                ConstraintPose pose = default;
                ConstraintInfo info = new() { Kind = c.Kind, SkinRequired = c.SkinRequired, SourceBone = -1 };
                switch (c)
                {
                    case IkDef ik:
                        info.SourceBone = ik.Target;
                        pose.Mix = ik.Mix;
                        pose.Softness = ik.Softness;
                        pose.BendDirection = ik.BendDirection;
                        pose.Compress = ik.Compress;
                        pose.Stretch = ik.Stretch;
                        break;
                    case TransformDef t:
                        info.SourceBone = t.Source;
                        pose.MixRotate = t.MixRotate;
                        pose.MixX = t.MixX;
                        pose.MixY = t.MixY;
                        pose.MixScaleX = t.MixScaleX;
                        pose.MixScaleY = t.MixScaleY;
                        pose.MixShearY = t.MixShearY;
                        break;
                    case PathConstraintDef p:
                        info.SourceBone = skeleton.Slots[p.Slot].Bone;
                        pose.Position = p.Position;
                        pose.Spacing = p.Spacing;
                        pose.MixRotate = p.MixRotate;
                        pose.MixX = p.MixX;
                        pose.MixY = p.MixY;
                        break;
                    case PhysicsDef p:
                        info.SourceBone = p.Bone;
                        pose.Inertia = p.Inertia;
                        pose.Strength = p.Strength;
                        pose.Damping = p.Damping;
                        pose.MassInverse = p.MassInverse;
                        pose.Wind = p.Wind;
                        pose.Gravity = p.Gravity;
                        pose.Mix = p.Mix;
                        info.Globals = (p.InertiaGlobal ? PhysicsGlobal.Inertia : 0) |
                                       (p.StrengthGlobal ? PhysicsGlobal.Strength : 0) |
                                       (p.DampingGlobal ? PhysicsGlobal.Damping : 0) |
                                       (p.MassGlobal ? PhysicsGlobal.Mass : 0) |
                                       (p.WindGlobal ? PhysicsGlobal.Wind : 0) |
                                       (p.GravityGlobal ? PhysicsGlobal.Gravity : 0) |
                                       (p.MixGlobal ? PhysicsGlobal.Mix : 0);
                        break;
                    case SliderDef s:
                        // A slider is always source-active; its bone is checked every update (Constraints.md §3.1).
                        info.SourceBone = -1;
                        pose.Time = s.Time;
                        pose.Mix = s.Mix;
                        break;
                }

                blob.ConstraintSetups[i] = pose;
                blob.ConstraintInfos[i] = info;
            }
        }

        private static void BuildSetup(SkeletonDef skeleton, BlobContent blob)
        {
            BoneSetup[] bones = new BoneSetup[skeleton.Bones.Length];
            for (int i = 0; i < bones.Length; i++)
            {
                BoneDef b = skeleton.Bones[i];
                bones[i] = new BoneSetup
                {
                    X = b.X, Y = b.Y, Rotation = b.Rotation, ScaleX = b.ScaleX, ScaleY = b.ScaleY, ShearX = b.ShearX,
                    ShearY = b.ShearY, Parent = b.Parent, Inherit = b.Inherit, SkinRequired = b.SkinRequired,
                    Length = b.Length
                };
            }

            // Children in index order, as the stock runtime appends them while creating bones.
            List<int> children = new();
            for (int i = 0; i < bones.Length; i++)
            {
                bones[i].ChildStart = children.Count;
                for (int c = i + 1; c < bones.Length; c++)
                    if (skeleton.Bones[c].Parent == i)
                        children.Add(c);

                bones[i].ChildCount = children.Count - bones[i].ChildStart;
            }

            blob.BoneChildren = children.ToArray();

            SlotSetup[] slots = new SlotSetup[skeleton.Slots.Length];
            blob.SetupAttachmentNames = new string[slots.Length];
            for (int i = 0; i < slots.Length; i++)
            {
                SlotDef s = skeleton.Slots[i];
                slots[i] = new SlotSetup
                {
                    Bone = s.Bone, Color = s.Color, DarkColor = s.DarkColor, HasDarkColor = s.HasDarkColor,
                    Blend = s.Blend
                };
                blob.SetupAttachmentNames[i] = s.AttachmentName;
            }

            blob.BoneSetups = bones;
            blob.SlotSetups = slots;
        }

        /// <summary>
        ///     The file's skins as <see cref="BoneBurstSkin" />s. Entries go in through the skin's own setter, so a
        ///     placeholder listed twice keeps its first position with the last attachment, as the stock loaders'
        ///     dictionary does.
        /// </summary>
        private static void BuildSkins(SkeletonDef skeleton, BlobContent blob, Dictionary<AttachmentDef, int> indexOf)
        {
            blob.Skins = new BoneBurstSkin[skeleton.Skins.Length];
            for (int s = 0; s < skeleton.Skins.Length; s++)
            {
                SkinDef def = skeleton.Skins[s];
                BoneBurstSkin skin = new(def.Name, blob);
                foreach (int bone in def.Bones) skin.AddBone(bone);
                foreach (int constraint in def.Constraints) skin.AddConstraint(constraint);
                foreach (SkinEntry entry in def.Entries)
                    skin.SetAttachment(entry.Slot, entry.Placeholder, indexOf[entry.Attachment]);

                blob.Skins[s] = skin;
                if (def == skeleton.DefaultSkin) blob.DefaultSkin = skin;
            }
        }

        /// <summary>
        ///     Solver data for P5: constraint data, transform properties, path buffer sizes, and each animation's
        ///     keyed bones (for sliders).
        /// </summary>
        private static unsafe void BuildSolverData(SkeletonDef skeleton, BlobContent blob)
        {
            blob.ReferenceScale = skeleton.ReferenceScale;
            int count = skeleton.Constraints.Length;
            ConstraintBlob[] datas = new ConstraintBlob[count];
            List<int> bones = new();
            List<TransformFromBlob> froms = new();
            List<TransformToBlob> tos = new();
            int positions = 0;
            for (int i = 0; i < count; i++)
            {
                ConstraintBlob d = new()
                {
                    Kind = skeleton.Constraints[i].Kind, BonesStart = bones.Count, Target = -1,
                    Animation = -1
                };
                switch (skeleton.Constraints[i])
                {
                    case IkDef ik:
                        bones.AddRange(ik.Bones);
                        d.Target = ik.Target;
                        d.ScaleYMode = ik.ScaleYMode;
                        break;
                    case TransformDef t:
                        bones.AddRange(t.Bones);
                        d.Target = t.Source;
                        d.LocalSource = t.LocalSource;
                        d.LocalTarget = t.LocalTarget;
                        d.Additive = t.Additive;
                        d.Clamp = t.Clamp;
                        d.Offsets[0] = t.OffsetRotation;
                        d.Offsets[1] = t.OffsetX;
                        d.Offsets[2] = t.OffsetY;
                        d.Offsets[3] = t.OffsetScaleX;
                        d.Offsets[4] = t.OffsetScaleY;
                        d.Offsets[5] = t.OffsetShearY;
                        d.FromStart = froms.Count;
                        d.FromCount = t.From.Length;
                        foreach (TransformFromDef from in t.From)
                        {
                            froms.Add(new TransformFromBlob
                            {
                                Property = from.Property, Offset = from.Offset, ToStart = tos.Count,
                                ToCount = from.To.Length
                            });
                            foreach (TransformToDef to in from.To)
                                tos.Add(new TransformToBlob
                                {
                                    Property = to.Property, Offset = to.Offset, Max = to.Max, Scale = to.Scale
                                });
                        }

                        break;
                    case PathConstraintDef p:
                    {
                        bones.AddRange(p.Bones);
                        d.Target = p.Slot;
                        d.PositionMode = p.PositionMode;
                        d.SpacingMode = p.SpacingMode;
                        d.RotateMode = p.RotateMode;
                        d.OffsetRotation = p.OffsetRotation;
                        d.PositionsStart = positions;
                        int spaces = p.Bones.Length + 1;
                        positions += spaces * 3 + 2;
                        blob.PathSpacesMax = Math.Max(blob.PathSpacesMax, spaces);
                        break;
                    }
                    case PhysicsDef p:
                        bones.Add(p.Bone);
                        d.Target = p.Bone;
                        d.ScaleYMode = p.ScaleYMode;
                        d.X = p.X;
                        d.Y = p.Y;
                        d.Rotate = p.Rotate;
                        d.ScaleX = p.ScaleX;
                        d.ShearX = p.ShearX;
                        d.Limit = p.Limit;
                        d.Step = p.Step;
                        break;
                    case SliderDef s:
                        d.Target = s.Bone;
                        d.Animation = s.Animation;
                        d.Loop = s.Loop;
                        d.Additive = s.Additive;
                        d.Local = s.Local;
                        d.Property = s.Property;
                        d.PropertyOffset = s.PropertyOffset;
                        d.Offset = s.Offset;
                        d.Scale = s.Scale;
                        break;
                }

                d.BonesCount = bones.Count - d.BonesStart;
                datas[i] = d;
            }

            // World-vertex scratch: a closed constant-speed path needs V + 2 floats, a curve window 8.
            blob.PathWorldMax = 8;
            for (int i = 0; i < blob.Attachments.Length; i++)
            {
                AttachmentBlob a = blob.Attachments[i];
                if (a.Kind != AttachmentKind.Path) continue;
                blob.PathWorldMax = Math.Max(blob.PathWorldMax, a.VertexCount * 2 + 2);
                blob.PathCurvesMax = Math.Max(blob.PathCurvesMax, a.VertexCount * 2 / 6);
            }

            blob.ConstraintDatas = datas;
            blob.ConstraintBones = bones.ToArray();
            blob.TransformFroms = froms.ToArray();
            blob.TransformTos = tos.ToArray();
            blob.PathPositionsTotal = positions;
            List<int> physics = new();
            for (int i = 0; i < count; i++)
                if (datas[i].Kind == ConstraintKind.Physics)
                    physics.Add(i);

            blob.PhysicsConstraints = physics.ToArray();

            List<int> animationBones = new();
            for (int a = 0; a < blob.Animations.Length; a++)
            {
                AnimationBlob animation = blob.Animations[a];
                animation.BonesStart = animationBones.Count;
                for (int t = animation.TimelineStart; t < animation.TimelineStart + animation.TimelineCount; t++)
                {
                    TimelineBlob tb = blob.Timelines[t];
                    if ((tb.Kind < TimelineKind.BoneRotate || tb.Kind > TimelineKind.BoneInherit) &&
                        tb.Kind != TimelineKind.BoneTranslateSpline) continue;
                    if (animationBones.IndexOf(tb.Target, animation.BonesStart) < 0) animationBones.Add(tb.Target);
                }

                animation.BonesCount = animationBones.Count - animation.BonesStart;
                blob.Animations[a] = animation;
            }

            blob.AnimationBones = animationBones.ToArray();
        }

        private static AtlasRegionDef FindRegion(AtlasDef atlas, string path, string attachment)
        {
            return atlas.FindRegion(path) ??
                   throw new SkeletonFormatException($"Region not found in atlas: {path} (attachment: {attachment})");
        }

        private static Uv Flip(AtlasRegionDef r, bool flipV)
        {
            return flipV ? new Uv(r, r.U, 1 - r.V, r.U2, 1 - r.V2) : new Uv(r, r.U, r.V, r.U2, r.V2);
        }

        // Pose-and-Mesh.md §5.3–5.4: 8 local offsets (BL, UL, UR, BR), and 8 UVs paired with the world
        // outputs W0..W3 (BR, BL, UL, UR), not with the offsets.
        private static void RegionFrame(RegionDef a, Uv uv, List<float> offsets, List<float> uvs)
        {
            AtlasRegionDef r = uv.Region;
            float width = a.Width, height = a.Height;
            float left = -width / 2, bottom = -height / 2, right = width / 2, top = height / 2;
            left += r.OffsetX / r.OriginalWidth * width;
            bottom += r.OffsetY / r.OriginalHeight * height;
            bool rotated = r.Degrees == 90;
            if (rotated)
            {
                right -= (r.OriginalWidth - r.OffsetX - r.PackedHeight) / r.OriginalWidth * width;
                top -= (r.OriginalHeight - r.OffsetY - r.PackedWidth) / r.OriginalHeight * height;
            }
            else
            {
                right -= (r.OriginalWidth - r.OffsetX - r.PackedWidth) / r.OriginalWidth * width;
                top -= (r.OriginalHeight - r.OffsetY - r.PackedHeight) / r.OriginalHeight * height;
            }

            left *= a.ScaleX;
            right *= a.ScaleX;
            bottom *= a.ScaleY;
            top *= a.ScaleY;

            float radians = a.Rotation * BoneMath.DegRad;
            float cos = BoneMath.Cos(radians), sin = BoneMath.Sin(radians);
            float x = a.X, y = a.Y;
            float leftCos = left * cos + x, leftSin = left * sin;
            float bottomCos = bottom * cos + y, bottomSin = bottom * sin;
            float rightCos = right * cos + x, rightSin = right * sin;
            float topCos = top * cos + y, topSin = top * sin;
            offsets.Add(leftCos - bottomSin);
            offsets.Add(bottomCos + leftSin);
            offsets.Add(leftCos - topSin);
            offsets.Add(topCos + leftSin);
            offsets.Add(rightCos - topSin);
            offsets.Add(topCos + rightSin);
            offsets.Add(rightCos - bottomSin);
            offsets.Add(bottomCos + rightSin);

            if (rotated)
            {
                uvs.Add(uv.U2);
                uvs.Add(uv.V);
                uvs.Add(uv.U2);
                uvs.Add(uv.V2);
                uvs.Add(uv.U);
                uvs.Add(uv.V2);
                uvs.Add(uv.U);
                uvs.Add(uv.V);
            }
            else
            {
                uvs.Add(uv.U2);
                uvs.Add(uv.V2);
                uvs.Add(uv.U);
                uvs.Add(uv.V2);
                uvs.Add(uv.U);
                uvs.Add(uv.V);
                uvs.Add(uv.U2);
                uvs.Add(uv.V);
            }
        }

        // §16.3: mesh UVs for one sequence frame.
        private static void MeshFrame(float[] regionUVs, Uv uv, List<float> uvs)
        {
            AtlasRegionDef r = uv.Region;
            float textureWidth = r.PackedWidth / (uv.U2 - uv.U);
            float textureHeight = r.PackedHeight / (uv.V2 - uv.V);
            float u, v, width, height;
            switch (r.Degrees)
            {
                case 90:
                    u = uv.U - (r.OriginalHeight - r.OffsetY - r.PackedWidth) / textureWidth;
                    v = uv.V - (r.OriginalWidth - r.OffsetX - r.PackedHeight) / textureHeight;
                    width = r.OriginalHeight / textureWidth;
                    height = r.OriginalWidth / textureHeight;
                    for (int i = 0; i < regionUVs.Length; i += 2)
                    {
                        uvs.Add(u + regionUVs[i + 1] * width);
                        uvs.Add(v + (1 - regionUVs[i]) * height);
                    }

                    return;
                case 180:
                    u = uv.U - (r.OriginalWidth - r.OffsetX - r.PackedWidth) / textureWidth;
                    v = uv.V - r.OffsetY / textureHeight;
                    width = r.OriginalWidth / textureWidth;
                    height = r.OriginalHeight / textureHeight;
                    for (int i = 0; i < regionUVs.Length; i += 2)
                    {
                        uvs.Add(u + (1 - regionUVs[i]) * width);
                        uvs.Add(v + (1 - regionUVs[i + 1]) * height);
                    }

                    return;
                case 270:
                    u = uv.U - r.OffsetY / textureWidth;
                    v = uv.V - r.OffsetX / textureHeight;
                    width = r.OriginalHeight / textureWidth;
                    height = r.OriginalWidth / textureHeight;
                    for (int i = 0; i < regionUVs.Length; i += 2)
                    {
                        uvs.Add(u + (1 - regionUVs[i + 1]) * width);
                        uvs.Add(v + regionUVs[i] * height);
                    }

                    return;
                default:
                    u = uv.U - r.OffsetX / textureWidth;
                    v = uv.V - (r.OriginalHeight - r.OffsetY - r.PackedHeight) / textureHeight;
                    width = r.OriginalWidth / textureWidth;
                    height = r.OriginalHeight / textureHeight;
                    for (int i = 0; i < regionUVs.Length; i += 2)
                    {
                        uvs.Add(u + regionUVs[i] * width);
                        uvs.Add(v + regionUVs[i + 1] * height);
                    }

                    return;
            }
        }

        /// <summary>
        ///     Region UV bounds after the optional V flip.
        /// </summary>
        private readonly struct Uv
        {
            public readonly AtlasRegionDef Region;
            public readonly float U, V, U2, V2;

            public Uv(AtlasRegionDef region, float u, float v, float u2, float v2)
            {
                Region = region;
                U = u;
                V = v;
                U2 = u2;
                V2 = v2;
            }
        }
    }
}