using System;

namespace BoneBurst.TwinSpline
{
    /// <summary>
    ///     One node of a TwinSpline path as the BoneBurst Editor writes it (<c>name.twinspline.json</c>, version 1): its
    ///     place, its speed value, and the optional parts, each with a flag saying whether the file had it (a handle
    ///     <c>Tx</c>/<c>Ty</c> the way out, a broken leg <c>Bx</c>/<c>By</c> the way in, the speed spline's legs
    ///     <c>Ss</c> and <c>Sb</c>).
    /// </summary>
    public struct TwinNode
    {
        public double X, Y, Speed;
        public bool HasOut, HasBack, HasSs, HasSb;
        public double Tx, Ty, Bx, By, Ss, Sb;
    }

    /// <summary>
    ///     Turns a TwinSpline path into the tables the runtime reads (<see cref="TwinSplineMath" />). A port of the
    ///     BoneBurst Editor's own maths (<c>src/motion/curve.ts</c> and <c>speed.ts</c>), step for step and in double
    ///     precision, so the tables hold what the editor computes on every call: the curve sampled 64 times per span with
    ///     its cumulative arc length, and the cumulative time share of the speed spline at 512 steps. The editor's code
    ///     is the oracle (<c>scripts/twin-fixtures.ts</c> writes the numbers the tests compare against).
    /// </summary>
    public static class TwinSplineBake
    {
        /// <summary>
        ///     Samples per span of the curve.
        /// </summary>
        public const int Samples = 64;

        /// <summary>
        ///     Steps of the time table.
        /// </summary>
        public const int TimeSamples = 512;

        /// <summary>
        ///     Floats before the tables: duration, loop, curve length, curve point count, time table steps, three reserved.
        /// </summary>
        public const int HeaderFloats = 8;

        public const double SpeedMin = -0.99, SpeedMax = 5;

        /// <summary>
        ///     The flat float table of one path: header, then the curve (x, y and cumulative length of each sample), then
        ///     the time table (<see cref="TimeSamples" /> + 1 cumulative shares). The bone's setup pose is not in it: the
        ///     runtime takes it from the blob's bone, the one place it is kept.
        /// </summary>
        public static float[] Build(TwinNode[] nodes, bool closed, double duration, bool loop)
        {
            if (nodes == null || nodes.Length < 2) throw new ArgumentException("A path needs at least two nodes.");
            if (!(duration > 0)) throw new ArgumentException("A path runs for more than 0 seconds.");
            Curve curve = BuildCurve(nodes, closed);
            double[] time = BuildTimeTable(nodes, closed, curve);
            int points = curve.X.Length;
            float[] table = new float[HeaderFloats + 3 * points + TimeSamples + 1];
            table[0] = (float)duration;
            table[1] = loop ? 1 : 0;
            table[2] = (float)curve.Length;
            table[3] = points;
            table[4] = TimeSamples;
            for (int i = 0; i < points; i++)
            {
                table[HeaderFloats + 3 * i] = (float)curve.X[i];
                table[HeaderFloats + 3 * i + 1] = (float)curve.Y[i];
                table[HeaderFloats + 3 * i + 2] = (float)curve.Cum[i];
            }

            int at = HeaderFloats + 3 * points;
            for (int k = 0; k <= TimeSamples; k++) table[at + k] = (float)time[k];
            return table;
        }

        /// <summary>
        ///     The length of the path's curve.
        /// </summary>
        public static double Length(TwinNode[] nodes, bool closed)
        {
            return BuildCurve(nodes, closed).Length;
        }

        /// <summary>
        ///     The speed spline's value at progress <paramref name="p" /> (0..1 of the curve's length).
        /// </summary>
        public static double SpeedAt(TwinNode[] nodes, bool closed, double p)
        {
            Curve curve = BuildCurve(nodes, closed);
            return SpeedAt(nodes, closed, NodeProgress(curve, nodes.Length), p);
        }

        /// <summary>
        ///     A speed value held to its range and rounded to four places (the editor's <c>clampSpeed</c>; JavaScript
        ///     rounds halves up, so this does too).
        /// </summary>
        public static double ClampSpeed(double v)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return 0;
            return Math.Floor(Math.Min(SpeedMax, Math.Max(SpeedMin, v)) * 1e4 + 0.5) / 1e4;
        }

        private sealed class Curve
        {
            public double[] X, Y, Cum, NodeAt;
            public double Length;
        }

        private static double Hypot(double dx, double dy)
        {
            return Math.Sqrt(dx * dx + dy * dy);
        }

        private static void Handles(TwinNode[] nodes, bool closed, double[] outX, double[] outY, double[] inX, double[] inY)
        {
            int n = nodes.Length;
            for (int i = 0; i < n; i++)
            {
                TwinNode p = nodes[i];
                bool hasPrev = closed || i > 0, hasNext = closed || i < n - 1;
                TwinNode prev = closed ? nodes[(i + n - 1) % n] : (i > 0 ? nodes[i - 1] : default);
                TwinNode next = closed ? nodes[(i + 1) % n] : (i < n - 1 ? nodes[i + 1] : default);
                double lenOut = hasNext ? Hypot(next.X - p.X, next.Y - p.Y) / 3 : 0;
                double lenIn = hasPrev ? Hypot(p.X - prev.X, p.Y - prev.Y) / 3 : 0;
                double ox = 0, oy = 0, bx = 0, by = 0;
                if (p.HasOut)
                {
                    if (hasNext) { ox = p.Tx; oy = p.Ty; }
                    if (hasPrev) { bx = -p.Tx; by = -p.Ty; }
                }
                else if (closed && n == 2)
                {
                    // Prev and next are the same node: bow out to the left of the way from the first to the second, and back on the right: a lens.
                    TwinNode a = nodes[0], o = nodes[1];
                    double dx = o.X - a.X, dy = o.Y - a.Y, d = Hypot(dx, dy);
                    if (d == 0) d = 1;
                    double k = i == 0 ? 1 : -1;
                    ox = (-dy / d) * (d / 2) * k;
                    oy = (dx / d) * (d / 2) * k;
                    bx = -ox;
                    by = -oy;
                }
                else
                {
                    TwinNode a = hasPrev ? prev : p, b = hasNext ? next : p;
                    double dx = b.X - a.X, dy = b.Y - a.Y, d = Hypot(dx, dy);
                    if (d == 0) d = 1;
                    if (hasNext) { ox = (dx / d) * lenOut; oy = (dy / d) * lenOut; }
                    if (hasPrev) { bx = -(dx / d) * lenIn; by = -(dy / d) * lenIn; }
                }

                // A broken leg: the way in is its own, not the mirror of the way out.
                if (hasPrev && p.HasBack) { bx = p.Bx; by = p.By; }
                outX[i] = ox; outY[i] = oy; inX[i] = bx; inY[i] = by;
            }
        }

        private static Curve BuildCurve(TwinNode[] nodes, bool closed)
        {
            int n = nodes.Length, spans = closed ? n : n - 1, total = spans * Samples + 1;
            double[] hox = new double[n], hoy = new double[n], hix = new double[n], hiy = new double[n];
            Handles(nodes, closed, hox, hoy, hix, hiy);
            Curve c = new() { X = new double[total], Y = new double[total], Cum = new double[total], NodeAt = new double[spans + 1] };
            c.X[0] = nodes[0].X;
            c.Y[0] = nodes[0].Y;
            int at = 1;
            for (int i = 0; i < spans; i++)
            {
                int j = (i + 1) % n;
                TwinNode p0 = nodes[i], p3 = nodes[j];
                double c1x = p0.X + hox[i], c1y = p0.Y + hoy[i], c2x = p3.X + hix[j], c2y = p3.Y + hiy[j];
                for (int k = 1; k <= Samples; k++)
                {
                    double t = (double)k / Samples, u = 1 - t, b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
                    c.X[at] = b0 * p0.X + b1 * c1x + b2 * c2x + b3 * p3.X;
                    c.Y[at] = b0 * p0.Y + b1 * c1y + b2 * c2y + b3 * p3.Y;
                    c.Cum[at] = c.Cum[at - 1] + Hypot(c.X[at] - c.X[at - 1], c.Y[at] - c.Y[at - 1]);
                    at++;
                }

                c.NodeAt[i + 1] = c.Cum[at - 1];
            }

            c.Length = c.Cum[total - 1];
            return c;
        }

        private static double[] NodeProgress(Curve c, int n)
        {
            double[] xs = new double[n];
            for (int i = 0; i < n; i++) xs[i] = c.Length > 0 ? (i < c.NodeAt.Length ? c.NodeAt[i] : 0) / c.Length : (double)i / Math.Max(1, n - 1);
            return xs;
        }

        private static double AutoSlope(TwinNode[] nodes, bool closed, double[] xs, int i)
        {
            int n = nodes.Length;
            if (n < 2) return 0;
            double px, pv, nx, nv;
            if (i > 0) { px = xs[i - 1]; pv = ClampSpeed(nodes[i - 1].Speed); }
            else if (closed) { px = xs[n - 1] - 1; pv = ClampSpeed(nodes[n - 1].Speed); }
            else { px = xs[0]; pv = ClampSpeed(nodes[0].Speed); }
            if (i < n - 1) { nx = xs[i + 1]; nv = ClampSpeed(nodes[i + 1].Speed); }
            else if (closed) { nx = 1 + xs[0]; nv = ClampSpeed(nodes[0].Speed); }
            else { nx = xs[n - 1]; nv = ClampSpeed(nodes[n - 1].Speed); }
            double dx = nx - px;
            return dx > 1e-9 ? (nv - pv) / dx : 0;
        }

        // The legs of the speed spline at node i: the slope it leaves by and the one it arrives by.
        private static void Slopes(TwinNode[] nodes, bool closed, double[] xs, int i, out double slopeOut, out double slopeIn)
        {
            double auto = AutoSlope(nodes, closed, xs, i);
            TwinNode node = nodes[i];
            slopeOut = node.HasSs ? node.Ss : auto;
            bool broken = node.HasSs && node.HasSb;
            slopeIn = broken ? node.Sb : slopeOut;
        }

        private static double SpeedAt(TwinNode[] nodes, bool closed, double[] xs, double p)
        {
            int n = nodes.Length;
            double x = Math.Min(1, Math.Max(0, p));
            // The points the curve runs through: on a ring, the first again at 1.
            int count = closed ? n + 1 : n, last = count - 1;
            double Px(int k) => k < n ? xs[k] : 1;
            double Pv(int k) => ClampSpeed(nodes[k < n ? k : 0].Speed);
            int i = 0;
            while (i < last - 1 && x > Px(i + 1)) i++;
            double x0 = Px(i), x1 = Px(i + 1), h = x1 - x0;
            if (h <= 1e-9) return ClampSpeed(Pv(i));
            double t = (x - x0) / h, t2 = t * t, t3 = t2 * t;
            Slopes(nodes, closed, xs, i % n, out double slopeOut, out _);
            Slopes(nodes, closed, xs, (i + 1) % n, out _, out double slopeIn);
            double v = (2 * t3 - 3 * t2 + 1) * Pv(i) + (t3 - 2 * t2 + t) * h * slopeOut + (-2 * t3 + 3 * t2) * Pv(i + 1) + (t3 - t2) * h * slopeIn;
            return ClampSpeed(v);
        }

        private static double[] BuildTimeTable(TwinNode[] nodes, bool closed, Curve curve)
        {
            double[] xs = NodeProgress(curve, nodes.Length), cum = new double[TimeSamples + 1];
            double prev = 1 / (1 + ClampSpeed(SpeedAt(nodes, closed, xs, 0)));
            for (int k = 1; k <= TimeSamples; k++)
            {
                double cur = 1 / (1 + ClampSpeed(SpeedAt(nodes, closed, xs, (double)k / TimeSamples)));
                cum[k] = cum[k - 1] + ((prev + cur) / 2) / TimeSamples;
                prev = cur;
            }

            double total = cum[TimeSamples];
            if (total == 0) total = 1;
            for (int k = 0; k <= TimeSamples; k++) cum[k] /= total;
            return cum;
        }
    }
}
