using BoneBurst.Data;

namespace BoneBurst.Anim
{
    /// <summary>
    ///     The animatable state of one constraint, whatever its kind; each kind uses its own fields.
    ///     IK: Mix, Softness, BendDirection, Compress, Stretch. Transform: the six Mix* fields. Path: Position,
    ///     Spacing, MixRotate, MixX, MixY. Physics: Inertia, Strength, Damping, MassInverse, Wind, Gravity, Mix.
    ///     Slider: Time, Mix.
    /// </summary>
    /// <remarks>
    ///     Timelines write this pose; the constraint solvers read the applied copy
    ///     (<see cref="Instance.InstanceHeader.AppliedConstraints" />). The setup copy lives in the blob. Physics simulation
    ///     state is separate (<see cref="Constraints.PhysicsState" />).
    /// </remarks>
    public struct ConstraintPose
    {
        public float Mix, Softness;
        public int BendDirection;
        public bool Compress, Stretch;
        public float MixRotate, MixX, MixY, MixScaleX, MixScaleY, MixShearY;
        public float Position, Spacing;
        public float Inertia, Strength, Damping, MassInverse, Wind, Gravity;
        public float Time;
    }

    /// <summary>
    ///     What jobs need to know about a constraint besides its pose: kind, activation, and physics global flags.
    /// </summary>
    public struct ConstraintInfo
    {
        public ConstraintKind Kind;

        /// <summary>
        ///     The bone whose activity gates the constraint (IK target, transform source, path slot's bone, physics
        ///     bone), or -1 for a slider, which is always source-active (Constraints.md §3.1).
        /// </summary>
        public int SourceBone;

        public bool SkinRequired;

        /// <summary>
        ///     Physics: bit per property driven by the "all constraints" timelines, in <see cref="PhysicsGlobal" />
        ///     order.
        /// </summary>
        public int Globals;
    }

    /// <summary>
    ///     Bits of <see cref="ConstraintInfo.Globals" />.
    /// </summary>
    public static class PhysicsGlobal
    {
        public const int Inertia = 1, Strength = 2, Damping = 4, Mass = 8, Wind = 16, Gravity = 32, Mix = 64;
    }

    /// <summary>
    ///     How a timeline treats its base value and the time before its first key (Timelines.md §1.2).
    /// </summary>
    public enum MixFrom : byte
    {
        Current = 0,
        Setup = 1,
        First = 2
    }
}