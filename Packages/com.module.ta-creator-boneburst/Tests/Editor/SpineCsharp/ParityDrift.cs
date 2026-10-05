using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using BoneBurst.Data;
using NUnit.Framework;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     Every stock-parity comparison of the Editor suites goes through here, so the size of each difference is
    ///     recorded per category (<c>Doc/Review/BoneBurst-ParityPlan.md</c>, F2).
    /// </summary>
    /// <remarks>
    ///     <para>
    ///         Normally a value is the same when it is equal or NaN on both sides, exactly as the suites compared before,
    ///         so their results do not change. While <see cref="Measuring" />, every comparison answers "same", so each
    ///         scenario plays to its end and the report shows how far Mono's rounding drifts over frames, instead of
    ///         stopping at the first difference.
    ///     </para>
    ///     <para>
    ///         Run the measurement with <see cref="ParityDriftReport" />. In the strict-float harness
    ///         (<c>Tools~/ParityHarness</c>) every value must be exact; in Unity the report gives the error sizes the F3
    ///         tolerance is chosen from.
    ///     </para>
    /// </remarks>
    internal static class ParityDrift
    {
        /// <summary>
        ///     Upper bounds of the absolute-error buckets; the last bucket is everything above.
        /// </summary>
        private static readonly double[] s_Buckets = { 0, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2 };

        private static readonly Regex s_Frame = new(@"frame (\d+)", RegexOptions.Compiled);

        private sealed class Stat
        {
            public readonly long[] Buckets = new long[s_Buckets.Length + 1];
            public readonly SortedDictionary<int, (double abs, string at)> MaxAbsByFrameBand = new();
            public double MaxAbs, MaxRel, MaxRatio;
            public string MaxAbsAt, MaxRelAt, FirstInexactAt;
            public string MaxRatioAt;
            public long MaxUlps;
            public long Values, Exact, NanMismatch;
        }

        private static readonly Dictionary<string, Stat> s_Stats = new();
        private static string s_Scope = "";

        /// <summary>
        ///     Tolerance mode, the Editor's default: a value also passes within <see cref="ToleranceOf" /> of stock.
        ///     The strict-float harness compares exactly, which is what proves bit-for-bit parity (parity plan F1, F3).
        /// </summary>
#if BONEBURST_PARITY_HARNESS
        public static bool Tolerant = false;
#else
        public static bool Tolerant = true;
#endif

        /// <summary>
        ///     One frame of Mono's rounding, with margin (parity plan F2: frame-0 errors reach 5.8e-6 on unit values
        ///     and about 1e-6 of the value on positions).
        /// </summary>
        public const double AbsTolerance = 1e-5, RelTolerance = 1e-5;

        private static long s_CaseValues, s_CaseExact;
        private static double s_CaseWorstRatio;
        private static string s_CaseWorstAt;

        /// <summary>
        ///     Share of a case's frames that may be over tolerance, each isolated (parity plan F3): Mono's rounding
        ///     meets ill-conditioned spots (IK near a straight chain, a clip edge, a branch at a knife edge) on single
        ///     frames; a bug persists over consecutive frames or shows everywhere.
        /// </summary>
        public const double IsolatedFrameShare = 0.02;

        private static bool s_FrameOver;
        private static string s_FrameOverAt;
        private static readonly List<(bool over, string at)> s_Frames = new();

        /// <summary>
        ///     While true, every comparison records and answers "same".
        /// </summary>
        public static bool Measuring { get; private set; }

        public static void Start()
        {
            s_Stats.Clear();
            Measuring = true;
        }

        public static void Stop()
        {
            Measuring = false;
            s_Scope = "";
        }

        /// <summary>
        ///     Prefix for every location recorded from now on (suite and case).
        /// </summary>
        public static void Scope(string scope)
        {
            s_Scope = scope;
        }

        /// <summary>
        ///     The largest difference from stock that passes in tolerance mode: a colour byte may be off by one;
        ///     every other value by <c>max(1e-5, 1e-5 × |value|)</c>.
        /// </summary>
        public static double ToleranceOf(string category, float stock, float mine)
        {
            return s_Factor * BaseToleranceOf(category, stock, mine);
        }

        /// <summary>
        ///     Multiplier for the values compared next (<see cref="ParityConditioning" />); callers set it for one
        ///     bone and reset it to 1.
        /// </summary>
        public static double Factor
        {
            get => s_Factor;
            set => s_Factor = value;
        }

        private static double s_Factor = 1;

        private static double BaseToleranceOf(string category, float stock, float mine)
        {
            if (category == "mesh.color") return 1;

            // The applied pose is decomposed from the world (atan2, square roots) and recomposed for the comparison
            // (cos, sin): two rounding stages more than the world it comes from. Measured: 1.49 × the base bound
            // (raptor 'Jump', back_bracer, a held pose); 4 × leaves a 2.7 × margin (parity plan I1).
            if (category == "applied.matrix")
                return 4 * Math.Max(AbsTolerance,
                    RelTolerance * Math.Max(Math.Abs((double)stock), Math.Abs((double)mine)));

            double magnitude = Math.Max(Math.Abs((double)stock), Math.Abs((double)mine));
            if (IsPositional(category)) return RelTolerance * Math.Max(magnitude, s_Size);
            if (category.EndsWith(".rotation")) return RelTolerance * Math.Max(magnitude, 360);
            return Math.Max(AbsTolerance, RelTolerance * magnitude);
        }

        /// <summary>
        ///     Positions and what is made of them: their rounding scales with the skeleton's size (products and sums of
        ///     coordinates of that size), not with the value, which can be near zero.
        /// </summary>
        private static bool IsPositional(string category)
        {
            return category.EndsWith(".xy") || category == "mesh.position" || category == "mesh.bounds" ||
                   category == "physics.state";
        }

        private static double s_Size = 1;

        /// <summary>
        ///     A skeleton's size for <see cref="ToleranceOf" />: the export's own bounds at the read scale, else the sum
        ///     of every bone's offset and length (a generous upper bound for synthetic files without bounds).
        /// </summary>
        public static double SizeOf(SkeletonDef def, float scale)
        {
            double size = Math.Max(def.Width, def.Height) * scale;
            if (size > 0) return size;
            foreach (BoneDef bone in def.Bones) size += Math.Abs(bone.X) + Math.Abs(bone.Y) + Math.Abs(bone.Length);
            return Math.Max(size, 1);
        }

        /// <summary>
        ///     Counts <paramref name="count" /> bit-exact values compared by a caller's own fast path.
        /// </summary>
        public static void CountExact(int count)
        {
            s_CaseValues += count;
            s_CaseExact += count;
        }

        /// <summary>
        ///     Starts one test case's counters (<see cref="CaseSummary" />).
        /// </summary>
        public static void BeginCase(double size)
        {
            s_IsolatedFrames = 0;
            s_Size = size;
            s_Frames.Clear();
            s_FrameOver = false;
            s_FrameOverAt = null;
            s_CaseValues = s_CaseExact = 0;
            s_CaseWorstRatio = 0;
            s_CaseWorstAt = null;
        }

        /// <summary>
        ///     How many values the case compared, how many were bit-exact, and the closest any came to its tolerance, so
        ///     a drift towards the limit shows in the test output before it fails.
        /// </summary>
        public static string CaseSummary()
        {
            return $"{s_CaseValues:N0} values compared, {s_CaseExact:N0} bit-exact " +
                   $"({100.0 * s_CaseExact / Math.Max(1, s_CaseValues):F2}%)" +
                   (s_CaseWorstAt == null
                       ? ""
                       : $"; worst {100 * s_CaseWorstRatio:F1}% of tolerance at {s_CaseWorstAt}") +
                   $"; {s_IsolatedFrames} isolated frame(s) over tolerance of {s_Frames.Count}";
        }

        /// <summary>
        ///     Marks the current frame as over tolerance (or as a clip-topology difference), with the first reason.
        ///     Only in tolerance mode; exact comparison fails on the spot.
        /// </summary>
        public static void MarkFrame(string what)
        {
            s_FrameOver = true;
            s_FrameOverAt ??= what;
        }

        /// <summary>
        ///     Ends one compared frame (called by <see cref="ParityLockstep.CompareAndSync" />).
        /// </summary>
        public static void EndFrame()
        {
            if (Measuring) return;
            s_Frames.Add((s_FrameOver, s_FrameOverAt));
            s_FrameOver = false;
            s_FrameOverAt = null;
        }

        /// <summary>
        ///     Longest run of consecutive frames that may be over tolerance: a pose passing through an ill-conditioned
        ///     spot (an IK chain straightening, a clip edge) stays there for a few frames. Measured worst case: 3
        ///     (parity plan F3); a bug persists longer or recurs.
        /// </summary>
        public const int MaxIsolatedRun = 3;

        /// <summary>
        ///     The isolated-frame rule, at the end of a case. Frames over tolerance must come in runs of at most
        ///     <see cref="MaxIsolatedRun" />, each with a frame within tolerance on both sides, and there may be at most
        ///     <c>max(1, 2 %)</c> of the case's frames over. A run at the first or last frame has no neighbour on that
        ///     side, so a one-frame case (the setup pose) is compared strictly.
        /// </summary>
        public static void CheckFrames(List<string> failures)
        {
            if (Measuring) return;
            if (s_FrameOver) EndFrame();
            int over = 0;
            for (int i = 0; i < s_Frames.Count;)
            {
                if (!s_Frames[i].over)
                {
                    i++;
                    continue;
                }

                int end = i;
                while (end < s_Frames.Count && s_Frames[end].over) end++;
                int run = end - i;
                over += run;
                bool bounded = i > 0 && end < s_Frames.Count;
                if (run > MaxIsolatedRun || !bounded)
                    failures.Add(
                        $"{run} consecutive frame(s) over tolerance{(bounded ? "" : " at the start or end")}, " +
                        $"from {s_Frames[i].at}");

                i = end;
            }

            int allowed = Math.Max(1, (int)(IsolatedFrameShare * s_Frames.Count));
            if (over > allowed)
                failures.Add($"{over} of {s_Frames.Count} frames over tolerance, more than the {allowed} allowed");

            s_IsolatedFrames = over;
        }

        private static int s_IsolatedFrames;

        /// <summary>
        ///     Writes <see cref="CaseSummary" /> to the test output. Nothing while measuring: the report runs the suites
        ///     outside NUnit, where there is no test context.
        /// </summary>
        public static void WriteCaseSummary()
        {
            if (Measuring) return;
            try
            {
                TestContext.WriteLine(CaseSummary());
            }
            catch (NullReferenceException)
            {
                // A suite invoked outside an NUnit run (an Editor snippet) has no test context to write to.
            }
        }

        /// <summary>
        ///     A stock value against BoneBurst's. True when the caller may carry on: equal, NaN on both sides, within
        ///     tolerance in tolerance mode, or measuring.
        /// </summary>
        public static bool Same(string category, string at, float stock, float mine)
        {
            bool equal = stock == mine || (float.IsNaN(stock) && float.IsNaN(mine));
            if (!Measuring)
            {
                s_CaseValues++;
                if (equal)
                {
                    s_CaseExact++;
                    return true;
                }

                if (!Tolerant || float.IsNaN(stock) || float.IsNaN(mine) || float.IsInfinity(stock) ||
                    float.IsInfinity(mine))
                    return false;

                double ratio = Math.Abs((double)stock - mine) / ToleranceOf(category, stock, mine);
                if (ratio <= 1)
                {
                    if (ratio > s_CaseWorstRatio)
                    {
                        s_CaseWorstRatio = ratio;
                        s_CaseWorstAt = $"{category} {at}";
                    }

                    return true;
                }

                // Over tolerance: the frame is marked, and CheckFrames decides at the end of the case.
                MarkFrame(
                    $"{category} {at}: stock {stock.ToString("R", CultureInfo.InvariantCulture)} mine {mine.ToString("R", CultureInfo.InvariantCulture)} ({ratio:G3} × tolerance)");
                return true;
            }

            Record(StatOf(category), category, at, stock, mine, equal);
            Record(StatOf(SuitePrefix + Suite()), category, at, stock, mine, equal);
            return true;
        }

        private const string SuitePrefix = "suite ";

        private static string Suite()
        {
            int space = s_Scope.IndexOf(' ');
            return space < 0 ? s_Scope : s_Scope.Substring(0, space);
        }

        private static void Record(Stat stat, string category, string at, float stock, float mine, bool equal)
        {
            stat.Values++;
            string where = $"{s_Scope} {at}";
            if (equal)
            {
                stat.Exact++;
                stat.Buckets[0]++;
                return;
            }

            stat.FirstInexactAt ??= where;
            if (float.IsNaN(stock) || float.IsNaN(mine) || float.IsInfinity(stock) || float.IsInfinity(mine))
            {
                stat.NanMismatch++;
                return;
            }

            double abs = Math.Abs((double)stock - mine);
            double rel = abs / Math.Max(Math.Abs((double)stock), 1e-6);
            long ulps = Math.Abs((long)BitConverter.SingleToInt32Bits(stock) - BitConverter.SingleToInt32Bits(mine));
            if (abs > stat.MaxAbs)
            {
                stat.MaxAbs = abs;
                stat.MaxAbsAt =
                    $"{where}: stock {stock.ToString("R", CultureInfo.InvariantCulture)} mine {mine.ToString("R", CultureInfo.InvariantCulture)}";
            }

            if (rel > stat.MaxRel)
            {
                stat.MaxRel = rel;
                stat.MaxRelAt = where;
            }

            double ratio = abs / ToleranceOf(category, stock, mine);
            if (ratio > stat.MaxRatio)
            {
                stat.MaxRatio = ratio;
                stat.MaxRatioAt =
                    $"{where} [{category}]: stock {stock.ToString("R", CultureInfo.InvariantCulture)} mine {mine.ToString("R", CultureInfo.InvariantCulture)}";
            }

            if (Math.Sign(stock) == Math.Sign(mine)) stat.MaxUlps = Math.Max(stat.MaxUlps, ulps);
            int bucket = 1;
            while (bucket < s_Buckets.Length && abs > s_Buckets[bucket]) bucket++;
            stat.Buckets[bucket]++;

            int band = FrameBand(at);
            if (!stat.MaxAbsByFrameBand.TryGetValue(band, out (double abs, string at) bandMax) || abs > bandMax.abs)
                stat.MaxAbsByFrameBand[band] = (abs, where);
        }

        /// <summary>
        ///     A discrete fact (a count, name, index, flag or event log) against BoneBurst's. True when equal or
        ///     measuring; a mismatch is counted.
        /// </summary>
        public static bool Same(string category, string at, bool equal)
        {
            if (!Measuring)
            {
                s_CaseValues++;
                if (equal) s_CaseExact++;
                return equal;
            }

            Stat stat = StatOf(category);
            stat.Values++;
            if (equal)
            {
                stat.Exact++;
                stat.Buckets[0]++;
            }
            else
            {
                stat.FirstInexactAt ??= $"{s_Scope} {at}";
                stat.Buckets[s_Buckets.Length]++;
            }

            return true;
        }

        private static Stat StatOf(string category)
        {
            if (!s_Stats.TryGetValue(category, out Stat stat)) s_Stats[category] = stat = new Stat();
            return stat;
        }

        /// <summary>
        ///     0 for the setup pose and frame 0, then 1 (frames 1–9), 2 (10–99), 3 (100+).
        /// </summary>
        private static int FrameBand(string at)
        {
            Match match = s_Frame.Match(at);
            if (!match.Success) return 0;
            int frame = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
            return frame == 0 ? 0 : frame < 10 ? 1 : frame < 100 ? 2 : 3;
        }

        /// <summary>
        ///     Values compared, each once (the per-suite rows repeat the float ones).
        /// </summary>
        public static long TotalValues => s_Stats.Where(p => !p.Key.StartsWith(SuitePrefix)).Sum(p => p.Value.Values);

        public static long TotalInexact =>
            s_Stats.Where(p => !p.Key.StartsWith(SuitePrefix)).Sum(p => p.Value.Values - p.Value.Exact);

        public static string Report(string title)
        {
            string[] bands = { "f0", "f1-9", "f10-99", "f100+" };
            StringBuilder r = new();
            r.AppendLine(title);
            r.AppendLine($"{TotalValues:N0} values compared, {TotalInexact:N0} not bit-exact");
            r.AppendLine();
            r.AppendLine("Rows \"suite …\": every float value that suite compared (discrete facts excluded).");
            r.AppendLine(
                "category | values | exact % | NaN/Inf mismatch | max abs | max rel | max × tolerance | max ulps | abs buckets 0 / ≤1e-7 / ≤1e-6 / ≤1e-5 / ≤1e-4 / ≤1e-3 / ≤1e-2 / more | max abs by frame band");
            foreach (KeyValuePair<string, Stat> pair in s_Stats.OrderBy(p => p.Key, StringComparer.Ordinal))
            {
                Stat s = pair.Value;
                string byBand = string.Join(" ", s.MaxAbsByFrameBand.Select(b => $"{bands[b.Key]}:{b.Value.abs:G3}"));
                r.AppendLine(
                    $"{pair.Key} | {s.Values:N0} | {100.0 * s.Exact / Math.Max(1, s.Values):F2} | {s.NanMismatch} | " +
                    $"{s.MaxAbs:G3} | {s.MaxRel:G3} | {s.MaxRatio:G3} | {s.MaxUlps} | {string.Join(" / ", s.Buckets)} | {byBand}");
            }

            r.AppendLine();
            foreach (KeyValuePair<string, Stat> pair in s_Stats.OrderBy(p => p.Key, StringComparer.Ordinal))
            {
                if (pair.Value.FirstInexactAt == null) continue;
                r.AppendLine($"{pair.Key}:");
                r.AppendLine($"  first inexact: {pair.Value.FirstInexactAt}");
                if (pair.Value.MaxAbsAt != null) r.AppendLine($"  max abs:       {pair.Value.MaxAbsAt}");
                if (pair.Value.MaxRelAt != null) r.AppendLine($"  max rel:       {pair.Value.MaxRelAt}");
                if (pair.Value.MaxRatioAt != null) r.AppendLine($"  max × tol:     {pair.Value.MaxRatioAt}");
                foreach (KeyValuePair<int, (double abs, string at)> band in pair.Value.MaxAbsByFrameBand)
                    r.AppendLine($"  max {bands[band.Key],-6} {band.Value.abs:G3} at {band.Value.at}");
            }

            return r.ToString();
        }
    }
}