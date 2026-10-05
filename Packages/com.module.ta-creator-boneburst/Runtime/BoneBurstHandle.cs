using System;

namespace BoneBurst
{
    /// <summary>
    ///     Identifies one skeleton instance in <see cref="BoneBurstSystem" />.
    /// </summary>
    /// <remarks>
    ///     A handle names a slot, not a row: rows are compacted by swap-remove once per frame, slots never move.
    ///     The generation makes a handle to a removed instance detectably stale instead of silently naming whatever
    ///     reuses its slot. Generation 0 is never issued, so <c>default</c> is <see cref="None" />.
    /// </remarks>
    public readonly struct BoneBurstHandle : IEquatable<BoneBurstHandle>
    {
        internal readonly int Slot;
        internal readonly int Generation;

        internal BoneBurstHandle(int slot, int generation)
        {
            Slot = slot;
            Generation = generation;
        }

        /// <summary>
        ///     The handle that names no instance.
        /// </summary>
        public static BoneBurstHandle None => default;

        /// <summary>
        ///     True for <see cref="None" />. A non-None handle can still be stale; ask <see cref="BoneBurstSystem.IsAlive" />.
        /// </summary>
        public bool IsNone => Generation == 0;

        public bool Equals(BoneBurstHandle other)
        {
            return Slot == other.Slot && Generation == other.Generation;
        }

        public override bool Equals(object obj)
        {
            return obj is BoneBurstHandle other && Equals(other);
        }

        public override int GetHashCode()
        {
            return (Slot * 397) ^ Generation;
        }

        public static bool operator ==(BoneBurstHandle a, BoneBurstHandle b)
        {
            return a.Equals(b);
        }

        public static bool operator !=(BoneBurstHandle a, BoneBurstHandle b)
        {
            return !a.Equals(b);
        }

        public override string ToString()
        {
            return IsNone ? "BoneBurstHandle(None)" : $"BoneBurstHandle({Slot}#{Generation})";
        }
    }
}