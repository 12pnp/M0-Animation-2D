using System;
using System.Collections.Generic;
using Unity.Mathematics;

namespace BoneBurst.Data
{
    /// <summary>
    ///     Everything a Spine 4.3 skeleton file holds, as read by <see cref="SkeletonBinaryReader" /> or
    ///     <see cref="SkeletonJsonReader" />, already multiplied by the load scale.
    /// </summary>
    /// <remarks>
    ///     Load-time only: plain managed objects, allocation is fine here. The per-frame runtime never touches this;
    ///     <c>BlobBuilder</c> flattens it into a blittable blob. Nonessential editor-only data (bone colours, icons,
    ///     skin and animation colours, edges are kept only where a later phase needs them) is dropped, as the stock
    ///     runtime drops it. Field meanings and defaults: <c>Doc/Format/Format-Binary.md</c>.
    /// </remarks>
    public sealed class SkeletonDef
    {
        public AnimationDef[] Animations;

        public BoneDef[] Bones;

        /// <summary>
        ///     All constraint kinds in one list; a constraint's index here is what skins and timelines use.
        /// </summary>
        public ConstraintDef[] Constraints;

        /// <summary>
        ///     The skin named "default", or null.
        /// </summary>
        public SkinDef DefaultSkin;

        public EventDef[] Events;
        public float Fps;

        /// <summary>
        ///     Export hash as text, or null when the file has none.
        /// </summary>
        public string Hash;

        public string ImagesPath, AudioPath;
        public float ReferenceScale = 100;

        /// <summary>
        ///     The default skin (when present) first, then named skins in file order.
        /// </summary>
        public SkinDef[] Skins;

        public SlotDef[] Slots;

        /// <summary>
        ///     Spine Editor version that wrote the file, for example "4.3.74-beta".
        /// </summary>
        public string Version;

        public float X, Y, Width, Height;
    }

    /// <summary>
    ///     How a bone takes its parent's transform. Values match the file encoding.
    /// </summary>
    public enum Inherit : byte
    {
        Normal = 0,
        OnlyTranslation = 1,
        NoRotationOrReflection = 2,
        NoScale = 3,
        NoScaleOrReflection = 4
    }

    /// <summary>
    ///     Slot blend mode. Values match the file encoding.
    /// </summary>
    public enum BlendMode : byte
    {
        Normal = 0,
        Additive = 1,
        Multiply = 2,
        Screen = 3
    }

    public sealed class BoneDef
    {
        public Inherit Inherit;
        public float Length;
        public string Name;

        /// <summary>
        ///     Index of an earlier bone, or -1 for the root.
        /// </summary>
        public int Parent = -1;

        public float Rotation, X, Y, ScaleX = 1, ScaleY = 1, ShearX, ShearY;
        public bool SkinRequired;
    }

    public sealed class SlotDef
    {
        /// <summary>
        ///     Setup attachment placeholder name, or null.
        /// </summary>
        public string AttachmentName;

        public BlendMode Blend;
        public int Bone;
        public float4 Color = new(1, 1, 1, 1);

        public float3 DarkColor;

        /// <summary>
        ///     Whether the slot has a dark colour (two-colour tinting). Presence matters, not just the value.
        /// </summary>
        public bool HasDarkColor;

        public string Name;
    }

    public enum ConstraintKind : byte
    {
        Ik = 0,
        Path = 1,
        Transform = 2,
        Physics = 3,
        Slider = 4
    }

    public abstract class ConstraintDef
    {
        public string Name;
        public bool SkinRequired;
        public abstract ConstraintKind Kind { get; }
    }

    /// <summary>
    ///     How IK scales a bone's Y when stretching. Values match the file encoding.
    /// </summary>
    public enum ScaleYMode : byte
    {
        None = 0,
        Uniform = 1,
        Volume = 2
    }

    public sealed class IkDef : ConstraintDef
    {
        public int BendDirection = 1;
        public int[] Bones;
        public bool Compress, Stretch;
        public float Mix = 1, Softness;
        public ScaleYMode ScaleYMode;
        public int Target;
        public override ConstraintKind Kind => ConstraintKind.Ik;
    }

    /// <summary>
    ///     A transform-constraint or slider property. Values match the file encoding.
    /// </summary>
    public enum TransformProperty : byte
    {
        Rotate = 0,
        X = 1,
        Y = 2,
        ScaleX = 3,
        ScaleY = 4,
        ShearY = 5
    }

    public sealed class TransformFromDef
    {
        public float Offset;
        public TransformProperty Property;
        public TransformToDef[] To;
    }

    public sealed class TransformToDef
    {
        public float Offset, Max, Scale;
        public TransformProperty Property;
    }

    public sealed class TransformDef : ConstraintDef
    {
        public int[] Bones;
        public TransformFromDef[] From;
        public bool LocalSource, LocalTarget, Additive, Clamp;
        public float MixRotate, MixX, MixY, MixScaleX, MixScaleY, MixShearY;
        public float OffsetRotation, OffsetX, OffsetY, OffsetScaleX, OffsetScaleY, OffsetShearY;
        public int Source;
        public override ConstraintKind Kind => ConstraintKind.Transform;
    }

    public enum PositionMode : byte
    {
        Fixed = 0,
        Percent = 1
    }

    public enum SpacingMode : byte
    {
        Length = 0,
        Fixed = 1,
        Percent = 2,
        Proportional = 3
    }

    public enum RotateMode : byte
    {
        Tangent = 0,
        Chain = 1,
        ChainScale = 2
    }

    public sealed class PathConstraintDef : ConstraintDef
    {
        public int[] Bones;
        public float OffsetRotation, Position, Spacing, MixRotate, MixX, MixY;

        public PositionMode PositionMode;
        public RotateMode RotateMode;

        /// <summary>
        ///     Slot holding the path attachment (a slot index, not a bone).
        /// </summary>
        public int Slot;

        public SpacingMode SpacingMode;
        public override ConstraintKind Kind => ConstraintKind.Path;
    }

    public sealed class PhysicsDef : ConstraintDef
    {
        public int Bone;

        public float Inertia, Strength, Damping, MassInverse = 1, Wind, Gravity, Mix = 1;
        public bool InertiaGlobal, StrengthGlobal, DampingGlobal, MassGlobal, WindGlobal, GravityGlobal, MixGlobal;
        public float Limit;
        public ScaleYMode ScaleYMode;

        /// <summary>
        ///     Seconds per physics step (1 / fps).
        /// </summary>
        public float Step;

        public float X, Y, Rotate, ScaleX, ShearX;
        public override ConstraintKind Kind => ConstraintKind.Physics;
    }

    public sealed class SliderDef : ConstraintDef
    {
        /// <summary>
        ///     Index into <see cref="SkeletonDef.Animations" />, or -1.
        /// </summary>
        public int Animation = -1;

        /// <summary>
        ///     Driving bone, or -1 when the slider is time-driven.
        /// </summary>
        public int Bone = -1;

        public bool Local;
        public bool Loop, Additive;

        public TransformProperty Property;
        public float PropertyOffset, Offset, Scale;
        public float Time, Mix;
        public override ConstraintKind Kind => ConstraintKind.Slider;
    }

    /// <summary>
    ///     One skin: attachments keyed by (slot index, placeholder name), plus the bones and constraints it enables.
    /// </summary>
    public sealed class SkinDef
    {
        /// <summary>
        ///     Entries in file order.
        /// </summary>
        public readonly List<SkinEntry> Entries = new();

        private readonly Dictionary<(int slot, string name), AttachmentDef> m_Lookup = new();
        public int[] Bones = Array.Empty<int>();
        public int[] Constraints = Array.Empty<int>();

        public string Name;

        public void Add(int slot, string placeholder, AttachmentDef attachment)
        {
            m_Lookup[(slot, placeholder)] = attachment;
            Entries.Add(new SkinEntry { Slot = slot, Placeholder = placeholder, Attachment = attachment });
        }

        public AttachmentDef Get(int slot, string placeholder)
        {
            return placeholder != null && m_Lookup.TryGetValue((slot, placeholder), out AttachmentDef attachment)
                ? attachment
                : null;
        }
    }

    public struct SkinEntry
    {
        public int Slot;
        public string Placeholder;
        public AttachmentDef Attachment;
    }

    public enum AttachmentKind : byte
    {
        Region = 0,
        BoundingBox = 1,
        Mesh = 2,
        LinkedMesh = 3,
        Path = 4,
        Point = 5,
        Clipping = 6
    }

    public abstract class AttachmentDef
    {
        public string Name;
        public abstract AttachmentKind Kind { get; }
    }

    /// <summary>
    ///     Frame sequence of a region or mesh. Without a sequence block in the file: one frame, no path suffix.
    /// </summary>
    public sealed class SequenceDef
    {
        public int Count = 1, Start, Digits, SetupIndex;

        /// <summary>
        ///     True when frame paths are <c>path + zeroPad(Start + k, Digits)</c>.
        /// </summary>
        public bool HasPathSuffix;

        /// <summary>
        ///     Atlas path of frame <paramref name="k" />.
        /// </summary>
        public string FramePath(string basePath, int k)
        {
            return HasPathSuffix ? basePath + (Start + k).ToString().PadLeft(Digits, '0') : basePath;
        }
    }

    public sealed class RegionDef : AttachmentDef
    {
        public float4 Color = new(1, 1, 1, 1);
        public string Path;
        public SequenceDef Sequence = new();
        public float X, Y, Rotation, ScaleX = 1, ScaleY = 1, Width, Height;
        public override AttachmentKind Kind => AttachmentKind.Region;
    }

    /// <summary>
    ///     An attachment whose geometry is bone-driven vertices.
    /// </summary>
    public abstract class VertexAttachmentDef : AttachmentDef
    {
        /// <summary>
        ///     Null when unweighted. Weighted: per vertex, an influence count then that many bone indices.
        /// </summary>
        public int[] Bones;

        /// <summary>
        ///     The attachment whose deform timelines drive this one: itself, or a linked mesh's source when it
        ///     inherits timelines.
        /// </summary>
        public VertexAttachmentDef TimelineAttachment;

        /// <summary>
        ///     Unweighted: x,y per vertex. Weighted: x,y,weight per influence (bone-local bind positions).
        /// </summary>
        public float[] Vertices;

        /// <summary>
        ///     2 × vertex count.
        /// </summary>
        public int WorldVerticesLength;

        public bool IsWeighted => Bones != null;
    }

    public sealed class MeshDef : VertexAttachmentDef
    {
        public float4 Color = new(1, 1, 1, 1);

        public int[] Edges;

        /// <summary>
        ///     Hull size in floats (2 × hull vertices), as the stock runtime keeps it.
        /// </summary>
        public int HullLength;

        public string Path;

        public float[] RegionUVs;
        public SequenceDef Sequence = new();

        /// <summary>
        ///     For a linked mesh, the mesh its geometry comes from; null otherwise.
        /// </summary>
        public MeshDef SourceMesh;

        /// <summary>
        ///     Extra slots whose attachments use this mesh's timelines. Linked meshes keep an empty list.
        /// </summary>
        public int[] TimelineSlots = Array.Empty<int>();

        public int[] Triangles;
        public float Width, Height;

        public override AttachmentKind Kind => SourceMesh != null ? AttachmentKind.LinkedMesh : AttachmentKind.Mesh;
    }

    public sealed class BoundingBoxDef : VertexAttachmentDef
    {
        public override AttachmentKind Kind => AttachmentKind.BoundingBox;
    }

    public sealed class PathAttachmentDef : VertexAttachmentDef
    {
        public bool Closed, ConstantSpeed;
        public float[] Lengths;
        public override AttachmentKind Kind => AttachmentKind.Path;
    }

    public sealed class PointDef : AttachmentDef
    {
        public float X, Y, Rotation;
        public override AttachmentKind Kind => AttachmentKind.Point;
    }

    public sealed class ClippingDef : VertexAttachmentDef
    {
        public bool Convex, Inverse;
        public int EndSlot = -1;
        public override AttachmentKind Kind => AttachmentKind.Clipping;
    }

    public sealed class EventDef
    {
        public string AudioPath;
        public float Float;
        public int Int;
        public string Name;
        public string String;
        public float Volume, Balance;
    }

    /// <summary>
    ///     One animation: its timelines, and its duration (the last key time over all of them).
    /// </summary>
    public sealed class AnimationDef
    {
        public readonly List<TimelineDef> Timelines = new();
        public float Duration;
        public string Name;
    }
}