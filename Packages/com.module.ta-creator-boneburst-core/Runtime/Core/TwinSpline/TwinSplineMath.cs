namespace BoneBurst.TwinSpline
{
    /// <summary>
    ///     Plays a baked TwinSpline path (<see cref="TwinSplineBake.Build" />): two binary searches and one
    ///     interpolation per sample, on the float table, with pointers and no allocation so Burst can compile it. The
    ///     result is the path's point in its reference bone's space; for a path relative to the bone's own parent that
    ///     is the bone's local place, from which the setup pose is subtracted (<see cref="SetupX" />, <see cref="SetupY" />).
    /// </summary>
    public static unsafe class TwinSplineMath
    {
        public static float Duration(float* table)
        {
            return table[0];
        }

        public static bool Loops(float* table)
        {
            return table[1] > 0.5f;
        }

        public static float SetupX(float* table)
        {
            return table[5];
        }

        public static float SetupY(float* table)
        {
            return table[6];
        }

        /// <summary>
        ///     The path's own time at animation time <paramref name="time" />: starting over each run when it loops, held
        ///     at its end when it does not.
        /// </summary>
        public static float PathTime(float* table, float time)
        {
            float duration = table[0];
            if (!(duration > 0)) return 0;
            return table[1] > 0.5f ? time % duration : (time < duration ? time : duration);
        }

        /// <summary>
        ///     The path's point at animation time <paramref name="time" />.
        /// </summary>
        public static void Pose(float* table, float time, out float x, out float y)
        {
            PoseAtPathTime(table, PathTime(table, time), out x, out y);
        }

        /// <summary>
        ///     The path's point at its own time <paramref name="pathTime" /> (seconds from the start of a run, held to
        ///     the run).
        /// </summary>
        public static void PoseAtPathTime(float* table, float pathTime, out float x, out float y)
        {
            float duration = table[0], length = table[2];
            int points = (int)table[3], steps = (int)table[4];
            float* curve = table + TwinSplineBake.HeaderFloats;
            float* share = curve + 3 * points;
            float tau = pathTime / (duration > 1e-9f ? duration : 1e-9f);
            tau = tau < 0 ? 0 : (tau > 1 ? 1 : tau);
            // Progress along the ring at this share of the run's time.
            int lo = 0, hi = steps;
            while (hi - lo > 1)
            {
                int mid = (lo + hi) >> 1;
                if (share[mid] <= tau) lo = mid;
                else hi = mid;
            }

            float span = share[hi] - share[lo];
            float progress = (lo + (span > 0 ? (tau - share[lo]) / span : 0)) / steps;
            // The point that far along the curve.
            if (!(length > 0))
            {
                x = curve[0];
                y = curve[1];
                return;
            }

            float d = progress * length;
            d = d < 0 ? 0 : (d > length ? length : d);
            lo = 0;
            hi = points - 1;
            while (hi - lo > 1)
            {
                int mid = (lo + hi) >> 1;
                if (curve[3 * mid + 2] <= d) lo = mid;
                else hi = mid;
            }

            float cumLo = curve[3 * lo + 2], cumSpan = curve[3 * hi + 2] - cumLo;
            float f = cumSpan > 0 ? (d - cumLo) / cumSpan : 0;
            x = curve[3 * lo] + (curve[3 * hi] - curve[3 * lo]) * f;
            y = curve[3 * lo + 1] + (curve[3 * hi + 1] - curve[3 * lo + 1]) * f;
        }
    }
}
