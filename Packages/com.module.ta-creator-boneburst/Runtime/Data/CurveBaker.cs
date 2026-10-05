namespace BoneBurst.Data
{
    /// <summary>
    ///     Builds a timeline's <see cref="TimelineDef.Curves" /> array and bakes Bézier segments into 9 sample
    ///     points, operation for operation as <c>Doc/Format/Format-Binary.md</c> §8.2.3 specifies, so sampling
    ///     matches the stock runtime bit for bit.
    /// </summary>
    internal static class CurveBaker
    {
        /// <summary>
        ///     A curves array for <paramref name="frameCount" /> frames and <paramref name="bezierCount" /> baked
        ///     blocks: every segment linear, the last frame stepped (it has no outgoing segment).
        /// </summary>
        public static float[] Create(int frameCount, int bezierCount)
        {
            float[] curves = new float[frameCount + bezierCount * CurveType.BezierSize];
            if (frameCount > 0) curves[frameCount - 1] = CurveType.Stepped;

            return curves;
        }

        /// <summary>
        ///     <see cref="Create(int, int)" /> for a reader: sets <see cref="TimelineDef.Curves" /> and allocates
        ///     <see cref="TimelineDef.Beziers" /> for the control points.
        /// </summary>
        public static void Create(TimelineDef t, int frameCount, int bezierCount)
        {
            t.Curves = Create(frameCount, bezierCount);
            t.Beziers = new float[bezierCount * 4];
        }

        /// <summary>
        ///     <see cref="Bezier(float[], int, int, int, int, float, float, float, float, float, float, float, float)" />
        ///     into <see cref="TimelineDef.Curves" />, recording the control points in <see cref="TimelineDef.Beziers" />.
        /// </summary>
        public static void Bezier(TimelineDef t, int frameCount, int bezier, int frame, int channel,
            float t1, float v1, float cx1, float cy1, float cx2, float cy2, float t2, float v2)
        {
            Record(t, bezier, cx1, cy1, cx2, cy2);
            Bezier(t.Curves, frameCount, bezier, frame, channel, t1, v1, cx1, cy1, cx2, cy2, t2, v2);
        }

        /// <summary>
        ///     <see cref="DeformBezier(float[], int, int, int, float, float, float, float, float, float)" /> into
        ///     <see cref="TimelineDef.Curves" />, recording the control points in <see cref="TimelineDef.Beziers" />.
        /// </summary>
        public static void DeformBezier(TimelineDef t, int frameCount, int bezier, int frame,
            float t1, float cx1, float cy1, float cx2, float cy2, float t2)
        {
            Record(t, bezier, cx1, cy1, cx2, cy2);
            DeformBezier(t.Curves, frameCount, bezier, frame, t1, cx1, cy1, cx2, cy2, t2);
        }

        private static void Record(TimelineDef t, int bezier, float cx1, float cy1, float cx2, float cy2)
        {
            int i = bezier * 4;
            t.Beziers[i] = cx1;
            t.Beziers[i + 1] = cy1;
            t.Beziers[i + 2] = cx2;
            t.Beziers[i + 3] = cy2;
        }

        public static void SetStepped(float[] curves, int frame)
        {
            curves[frame] = CurveType.Stepped;
        }

        /// <summary>
        ///     Bakes one channel of the segment from frame <paramref name="frame" /> (key t1, v1) to the next key
        ///     (t2, v2) into block <paramref name="bezier" />. Channel 0 also marks the frame as Bézier.
        /// </summary>
        public static void Bezier(float[] curves, int frameCount, int bezier, int frame, int channel,
            float t1, float v1, float cx1, float cy1, float cx2, float cy2, float t2, float v2)
        {
            int i = frameCount + bezier * CurveType.BezierSize;
            if (channel == 0) curves[frame] = CurveType.Bezier + i;

            float tmpx = (t1 - cx1 * 2 + cx2) * 0.03f;
            float tmpy = (v1 - cy1 * 2 + cy2) * 0.03f;
            float dddx = ((cx1 - cx2) * 3 - t1 + t2) * 0.006f;
            float dddy = ((cy1 - cy2) * 3 - v1 + v2) * 0.006f;
            float ddx = tmpx * 2 + dddx;
            float ddy = tmpy * 2 + dddy;
            float dx = (cx1 - t1) * 0.3f + tmpx + dddx * 0.16666667f;
            float dy = (cy1 - v1) * 0.3f + tmpy + dddy * 0.16666667f;
            float x = t1 + dx;
            float y = v1 + dy;
            Fill(curves, i, x, y, dx, dy, ddx, ddy, dddx, dddy);
        }

        /// <summary>
        ///     The deform-timeline variant: a 0→1 percentage curve, with the algebraically simplified y terms the
        ///     stock runtime uses (equal in value, not bit-identical to <see cref="Bezier" />).
        /// </summary>
        public static void DeformBezier(float[] curves, int frameCount, int bezier, int frame,
            float t1, float cx1, float cy1, float cx2, float cy2, float t2)
        {
            int i = frameCount + bezier * CurveType.BezierSize;
            curves[frame] = CurveType.Bezier + i;

            float tmpx = (t1 - cx1 * 2 + cx2) * 0.03f;
            float tmpy = cy2 * 0.03f - cy1 * 0.06f;
            float dddx = ((cx1 - cx2) * 3 - t1 + t2) * 0.006f;
            float dddy = (cy1 - cy2 + 0.33333333f) * 0.018f;
            float ddx = tmpx * 2 + dddx;
            float ddy = tmpy * 2 + dddy;
            float dx = (cx1 - t1) * 0.3f + tmpx + dddx * 0.16666667f;
            float dy = cy1 * 0.3f + tmpy + dddy * 0.16666667f;
            float x = t1 + dx;
            float y = dy;
            Fill(curves, i, x, y, dx, dy, ddx, ddy, dddx, dddy);
        }

        private static void Fill(float[] curves, int i, float x, float y, float dx, float dy, float ddx, float ddy,
            float dddx, float dddy)
        {
            for (int n = i + CurveType.BezierSize; i < n; i += 2)
            {
                curves[i] = x;
                curves[i + 1] = y;
                dx += ddx;
                dy += ddy;
                ddx += dddx;
                ddy += dddy;
                x += dx;
                y += dy;
            }
        }
    }
}