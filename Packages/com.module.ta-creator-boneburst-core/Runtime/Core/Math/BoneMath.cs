using System.Runtime.CompilerServices;
using Unity.Mathematics;

namespace BoneBurst
{
    /// <summary>
    ///     Spine's numeric conventions (<c>Doc/Format/Pose-and-Mesh.md</c> §1): float32 storage, transcendentals
    ///     evaluated in double and narrowed to float, and the exact float32 degree/radian constants.
    /// </summary>
    /// <remarks>
    ///     Burst-compatible. Evaluating trig in double costs little next to the rest of a bone update and keeps
    ///     results equal to the stock runtime's, which parity depends on.
    /// </remarks>
    public static class BoneMath
    {
        /// <summary>
        ///     float32 PI (0x40490FDB).
        /// </summary>
        public const float Pi = 3.1415927f;

        /// <summary>
        ///     float32 PI / 180 (0x3C8EFA35).
        /// </summary>
        public const float DegRad = 0.017453292f;

        /// <summary>
        ///     float32 180 / PI (0x42652EE0).
        /// </summary>
        public const float RadDeg = 57.295776f;

        /// <summary>
        ///     Epsilon² as float32 (0x2EDBE6FE).
        /// </summary>
        public const float EpsilonSq = 0.00001f * 0.00001f;

        /// <summary>
        ///     float32 0.00001 (0x3727C5AC).
        /// </summary>
        public const float Epsilon = 0.00001f;

        /// <summary>
        ///     float32 PI × 2 (0x40C90FDB).
        /// </summary>
        public const float Pi2 = Pi * 2;

        /// <summary>
        ///     float32 1 / (PI × 2) (0x3E22F983).
        /// </summary>
        public const float InvPi2 = 1 / Pi2;

        /// <summary>
        ///     float32 PI / 2 (0x3FC90FDB).
        /// </summary>
        public const float HalfPi = Pi / 2;

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static float Cos(float radians)
        {
            return (float)math.cos((double)radians);
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static float Sin(float radians)
        {
            return (float)math.sin((double)radians);
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static float Atan2(float y, float x)
        {
            return (float)math.atan2((double)y, (double)x);
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static float Sqrt(float value)
        {
            return (float)math.sqrt((double)value);
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static float Acos(float value)
        {
            return (float)math.acos((double)value);
        }

        /// <summary>
        ///     <c>Math.Pow</c> on the widened floats, narrowed (Constraints-Path-Physics.md §1.1).
        /// </summary>
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static float Pow(float value, float exponent)
        {
            return (float)math.pow((double)value, (double)exponent);
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static float Ceil(float value)
        {
            return (float)math.ceil((double)value);
        }

        /// <summary>
        ///     The Mono <c>Math.Max(float, float)</c> the reference runs on: NaN from either side propagates, and a
        ///     tie returns <paramref name="b" />.
        /// </summary>
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static float Max(float a, float b)
        {
            if (a > b) return a;
            return float.IsNaN(a) ? a : b;
        }

        /// <summary>
        ///     <c>Math.Min(float, float)</c> with the same NaN rule as <see cref="Max" />.
        /// </summary>
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static float Min(float a, float b)
        {
            if (a < b) return a;
            return float.IsNaN(a) ? a : b;
        }

        /// <summary>
        ///     <c>Math.Sign(float)</c> as a float multiplier (0 for ±0).
        /// </summary>
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static float Sign(float value)
        {
            return value > 0 ? 1 : value < 0 ? -1 : 0;
        }

        /// <summary>
        ///     <c>atan2</c> in degrees: narrowed to float first, then multiplied in float.
        /// </summary>
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static float Atan2Deg(float y, float x)
        {
            return Atan2(y, x) * RadDeg;
        }
    }
}