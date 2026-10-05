using System;

namespace BoneBurst.Data
{
    /// <summary>
    ///     A skeleton or atlas file that cannot be read: malformed, truncated, or a version this reader does not
    ///     support. Always thrown, never returned as null; a half-read skeleton is worse than none.
    /// </summary>
    public sealed class SkeletonFormatException : Exception
    {
        public SkeletonFormatException(string message) : base(message)
        {
        }

        public SkeletonFormatException(string message, Exception inner) : base(message, inner)
        {
        }
    }
}