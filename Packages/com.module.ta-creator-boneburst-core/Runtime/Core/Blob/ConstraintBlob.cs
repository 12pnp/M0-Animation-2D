using BoneBurst.Data;

namespace BoneBurst.Blob
{
    /// <summary>
    ///     What a solver needs of one constraint besides its pose: <c>Doc/Format/Constraints.md</c> §6–8 and
    ///     <c>Constraints-Path-Physics.md</c> §3–4. One struct for every kind; each kind reads its own fields.
    /// </summary>
    public unsafe struct ConstraintBlob
    {
        public ConstraintKind Kind;

        /// <summary>
        ///     Constrained bones in <see cref="BlobView.ConstraintBones" /> (IK: parent first; physics: one).
        /// </summary>
        public int BonesStart, BonesCount;

        /// <summary>
        ///     IK: target bone. Transform: source bone. Path: slot. Physics: bone. Slider: driving bone or -1.
        /// </summary>
        public int Target;

        /// <summary>
        ///     IK and physics.
        /// </summary>
        public ScaleYMode ScaleYMode;

        // Transform (Additive is shared with the slider).
        public bool LocalSource, LocalTarget, Additive, Clamp;

        /// <summary>
        ///     Transform: rotation, x, y, scaleX, scaleY, shearY. Zero for every other kind (the slider's
        ///     <c>property.Value</c> reads six zeros).
        /// </summary>
        public fixed float Offsets[6];

        /// <summary>
        ///     Transform: its From properties in <see cref="BlobView.TransformFroms" />.
        /// </summary>
        public int FromStart, FromCount;

        // Path.
        public PositionMode PositionMode;
        public SpacingMode SpacingMode;
        public RotateMode RotateMode;

        /// <summary>
        ///     Path: offset rotation in degrees.
        /// </summary>
        public float OffsetRotation;

        /// <summary>
        ///     Path: start of this constraint's persistent <c>positions</c> buffer in the instance arena.
        /// </summary>
        public int PositionsStart;

        // Physics.
        public float X, Y, Rotate, ScaleX, ShearX, Limit, Step;

        // Slider.
        public int Animation;
        public bool Loop, Local;

        /// <summary>
        ///     Slider: the bone property that drives the time, with its offset, and the time mapping.
        /// </summary>
        public TransformProperty Property;

        public float PropertyOffset, Offset, Scale;
    }

    /// <summary>
    ///     A transform constraint's source property and its targets (<c>Constraints.md</c> §7.3).
    /// </summary>
    public struct TransformFromBlob
    {
        public TransformProperty Property;
        public float Offset;
        public int ToStart, ToCount;
    }

    /// <summary>
    ///     One target property of a <see cref="TransformFromBlob" /> (<c>Constraints.md</c> §7.4).
    /// </summary>
    public struct TransformToBlob
    {
        public TransformProperty Property;
        public float Offset, Max, Scale;
    }
}