namespace BoneBurst.Constraints
{
    /// <summary>
    ///     How physics constraints step in one world update: the stock <c>Physics</c> enum.
    /// </summary>
    public enum PhysicsMode : byte
    {
        /// <summary>
        ///     Physics constraints do nothing; bones keep their unconstrained world transform.
        /// </summary>
        None = 0,

        /// <summary>
        ///     Reset every physics constraint, then update.
        /// </summary>
        Reset = 1,

        /// <summary>
        ///     Step the simulation to the skeleton's time. The normal per-frame mode.
        /// </summary>
        Update = 2,

        /// <summary>
        ///     Re-apply the last simulated offsets without stepping.
        /// </summary>
        Pose = 3
    }

    /// <summary>
    ///     Per-instance skeleton values the solvers read and the frame advances (Constraints-Path-Physics.md §4.4,
    ///     Constraints.md §4.1).
    /// </summary>
    public struct SkeletonState
    {
        /// <summary>
        ///     The physics clock: <c>Skeleton.Update(delta)</c> adds each frame's scaled delta, in float.
        /// </summary>
        public float Time;

        /// <summary>
        ///     The <c>update</c> counter, incremented by every world update; the bone validity flags compare to it.
        /// </summary>
        public int Update;

        public float WindX, WindY, GravityX, GravityY;

        public static SkeletonState Initial => new() { WindX = 1, GravityY = 1 };
    }

    /// <summary>
    ///     One physics constraint's simulation state between frames (Constraints-Path-Physics.md §4.5).
    /// </summary>
    public struct PhysicsState
    {
        /// <summary>
        ///     The next step captures the bone's position instead of simulating.
        /// </summary>
        public bool Reset;

        public float Ux, Uy, Cx, Cy, Tx, Ty;
        public float XOffset, XLag, XVelocity;
        public float YOffset, YLag, YVelocity;
        public float RotateOffset, RotateLag, RotateVelocity;
        public float ScaleOffset, ScaleLag, ScaleVelocity;
        public float Remaining, LastTime;

        public static PhysicsState Initial => new() { Reset = true };
    }
}