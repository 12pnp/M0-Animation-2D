namespace BoneBurst.Data
{
    /// <summary>
    ///     Every 4.3 timeline type. The name says what it drives; <see cref="TimelineDef.Target" /> says which one.
    /// </summary>
    public enum TimelineKind : byte
    {
        SlotAttachment,
        SlotRgba,
        SlotRgb,
        SlotRgba2,
        SlotRgb2,
        SlotAlpha,
        BoneRotate,
        BoneTranslate,
        BoneTranslateX,
        BoneTranslateY,
        BoneScale,
        BoneScaleX,
        BoneScaleY,
        BoneShear,
        BoneShearX,
        BoneShearY,
        BoneInherit,
        Ik,
        Transform,
        PathPosition,
        PathSpacing,
        PathMix,
        PhysicsInertia,
        PhysicsStrength,
        PhysicsDamping,
        PhysicsMass,
        PhysicsWind,
        PhysicsGravity,
        PhysicsMix,
        PhysicsReset,
        SliderTime,
        SliderMix,
        Deform,
        Sequence,
        DrawOrder,
        DrawOrderFolder,
        Event
    }

    /// <summary>
    ///     Curve type stored per frame in <see cref="TimelineDef.Curves" />. Values of 2 and above mean Bézier:
    ///     <c>value - 2</c> is the index of that segment's first baked block.
    /// </summary>
    public static class CurveType
    {
        public const float Linear = 0;
        public const float Stepped = 1;
        public const float Bezier = 2;

        /// <summary>
        ///     Floats per baked Bézier block: 9 sampled (x, y) points.
        /// </summary>
        public const int BezierSize = 18;
    }

    /// <summary>
    ///     One timeline: keyed frames in a flat array plus baked curves, laid out so that sampling reproduces the
    ///     stock runtime exactly (<c>Doc/Format/Format-Binary.md</c> §8.2).
    /// </summary>
    public sealed class TimelineDef
    {
        public AttachmentDef Attachment;

        /// <summary>
        ///     SlotAttachment: attachment name per frame (null clears).
        /// </summary>
        public string[] AttachmentNames;

        /// <summary>
        ///     The Bézier control points <see cref="Curves" /> was baked from: <c>cx1, cy1, cx2, cy2</c> per block, in
        ///     block order, <c>cy</c> already scaled. Null when <see cref="Curves" /> is. Kept so
        ///     <see cref="BoneBurstDataWriter" /> can store 4 floats per block instead of 18 and rebuild the rest.
        /// </summary>
        public float[] Beziers;

        /// <summary>
        ///     Null for timelines without curves. Otherwise <c>FrameCount</c> curve types, then Bézier blocks of
        ///     <see cref="CurveType.BezierSize" /> floats.
        /// </summary>
        public float[] Curves;

        /// <summary>
        ///     Deform: vertex floats per frame. Weighted: offsets per influence. Unweighted: absolute positions.
        /// </summary>
        public float[][] Deform;

        /// <summary>
        ///     DrawOrder: per frame, slot index drawn at each position (null = setup order).
        ///     DrawOrderFolder: the same in folder-local indices.
        /// </summary>
        public int[][] DrawOrders;

        /// <summary>
        ///     Event: one fired event per frame.
        /// </summary>
        public EventFrame[] Events;

        /// <summary>
        ///     DrawOrderFolder: the folder's slots, in setup order.
        /// </summary>
        public int[] FolderSlots;

        public int FrameCount;

        /// <summary>
        ///     <see cref="FrameEntries" /> floats per frame: time first, then the channel values.
        /// </summary>
        public float[] Frames;

        public TimelineKind Kind;

        /// <summary>
        ///     Deform and Sequence: the skin whose attachment is keyed, and that attachment.
        /// </summary>
        public int Skin = -1;

        /// <summary>
        ///     Bone, slot or constraint index, depending on <see cref="Kind" />. Physics: -1 means every physics
        ///     constraint with the matching global flag. Draw order and event timelines: -1.
        /// </summary>
        public int Target = -1;

        public int FrameEntries => EntriesOf(Kind);

        /// <summary>
        ///     Time of the last frame, or 0 without frames.
        /// </summary>
        public float Duration => FrameCount == 0 ? 0 : Frames[(FrameCount - 1) * FrameEntries];

        /// <summary>
        ///     Floats per frame in <see cref="Frames" /> for a kind.
        /// </summary>
        public static int EntriesOf(TimelineKind kind)
        {
            switch (kind)
            {
                case TimelineKind.BoneTranslate:
                case TimelineKind.BoneScale:
                case TimelineKind.BoneShear:
                    return 3;
                case TimelineKind.SlotRgba:
                    return 5;
                case TimelineKind.SlotRgb:
                case TimelineKind.PathMix:
                    return 4;
                case TimelineKind.SlotRgba2:
                    return 8;
                case TimelineKind.SlotRgb2:
                case TimelineKind.Transform:
                    return 7;
                case TimelineKind.Ik:
                    return 6;
                case TimelineKind.Sequence:
                    return 3;
                case TimelineKind.SlotAttachment:
                case TimelineKind.PhysicsReset:
                case TimelineKind.Deform:
                case TimelineKind.DrawOrder:
                case TimelineKind.DrawOrderFolder:
                case TimelineKind.Event:
                    return 1;
                default:
                    return 2;
            }
        }
    }

    public struct EventFrame
    {
        public float Time;
        public int Event;
        public int Int;
        public float Float;
        public string String;
        public float Volume, Balance;
    }
}