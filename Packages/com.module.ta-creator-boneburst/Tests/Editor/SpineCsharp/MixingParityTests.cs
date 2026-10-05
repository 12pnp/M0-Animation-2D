using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using BoneBurst.Anim;
using BoneBurst.Blob;
using BoneBurst.Data;
using BoneBurst.Instance;
using NUnit.Framework;
using Spine;
using AnimationState = Spine.AnimationState;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     P4 parity: stock <see cref="AnimationState" /> and <see cref="BoneAnimationState" /> driven by identical
    ///     random scripts (three tracks; set, add with delays, empty set/add, clear; crossfades from default and
    ///     pair mixes; additive, alpha, time scales, reverse, shortest rotation, thresholds). The pose and the full
    ///     listener log (Start, Interrupt, End, Dispose, Complete, Event) are compared after every frame. The steady
    ///     variant drives <see cref="BoneAnimationState" /> through <see cref="BoneAnimationState.TryAdvanceSteady" />
    ///     whenever it accepts the frame (Perf2 plan P6) and must match stock just the same.
    /// </summary>
    public class MixingParityTests
    {
        private const int Seeds = 3, Frames = 180;
        private static readonly float[] s_Deltas = { 0.016666668f, 0.033333335f, 0.007f, 0.1f, 0.016666668f, 0.05f };

        private static IEnumerable<SampleCorpus.Case> Corpus()
        {
            return SampleCorpus.Corpus().Where(c => c.Scale != 0.37f);
        }

        [TestCaseSource(nameof(Corpus))]
        public void RandomScripts_MatchStock(SampleCorpus.Case c)
        {
            RunCase(c, false);
        }

        [TestCaseSource(nameof(Corpus))]
        public void RandomScripts_SteadyStep_MatchStock(SampleCorpus.Case c)
        {
            int steadyFrames = RunCase(c, true);
            Assert.That(steadyFrames, Is.GreaterThan(0), "control: the steady step never ran");
        }

        // Returns the frames the steady step took.
        private static int RunCase(SampleCorpus.Case c, bool steady)
        {
            SkeletonDef def = c.Skeleton.EndsWith(".json")
                ? SkeletonJsonReader.Read(File.ReadAllText(c.Skeleton), c.Scale)
                : SkeletonBinaryReader.Read(File.ReadAllBytes(c.Skeleton), c.Scale);
            ParityDrift.BeginCase(ParityDrift.SizeOf(def, c.Scale));
            if (def.Animations.Length == 0) Assert.Ignore("no animations");
            BlobContent content = BlobBuilder.BuildContent(def, AtlasReader.Read(File.ReadAllText(c.Atlas)));
            List<string> failures = new();
            int frames = 0, steadyFrames = 0;
            for (int seed = 0; seed < Seeds && failures.Count == 0; seed++)
                frames += Run(c, def, content, seed, failures, steady, ref steadyFrames);

            Assert.That(frames, Is.GreaterThan(0));
            ParityDrift.CheckFrames(failures);
            ParityDrift.WriteCaseSummary();
            Assert.IsEmpty(failures, string.Join("\n", failures.Take(20)));
            return steadyFrames;
        }

        private static int Run(SampleCorpus.Case c, SkeletonDef def, BlobContent content, int seed,
            List<string> failures,
            bool steady, ref int steadyFrames)
        {
            SkeletonData data = AnimationParityTests.LoadStock(c, true);
            Skeleton skeleton = new(data);
            Random rng = new(seed * 7919 + def.Animations.Length);
            int n = def.Animations.Length;

            AnimationStateData stockData = new(data) { DefaultMix = seed % 3 == 0 ? 0 : 0.2f };
            BoneAnimationStateData myData = new(content) { DefaultMix = stockData.DefaultMix };
            for (int k = 0; k < 3 && n > 1; k++)
            {
                int from = rng.Next(n), to = rng.Next(n);
                float d = (float)Math.Round(rng.NextDouble() * 0.5, 2);
                stockData.SetMix(data.Animations.Items[from], data.Animations.Items[to], d);
                myData.SetMix(from, to, d);
            }

            AnimationState stock = new(stockData);
            BoneAnimationState mine = new(myData);
            List<string> stockLog = new(), myLog = new();
            stock.Start += e => stockLog.Add($"start {e.TrackIndex} {e.Animation.Name}");
            stock.Interrupt += e => stockLog.Add($"interrupt {e.TrackIndex} {e.Animation.Name}");
            stock.End += e => stockLog.Add($"end {e.TrackIndex} {e.Animation.Name}");
            stock.Dispose += e => stockLog.Add($"dispose {e.TrackIndex} {e.Animation.Name}");
            stock.Complete += e => stockLog.Add($"complete {e.TrackIndex} {e.Animation.Name}");
            stock.Event += (e, ev) => stockLog.Add($"event {e.TrackIndex} {ev.Data.Name}@{ev.Time:R}");
            mine.Start += e => myLog.Add($"start {e.TrackIndex} {e.Name}");
            mine.Interrupt += e => myLog.Add($"interrupt {e.TrackIndex} {e.Name}");
            mine.End += e => myLog.Add($"end {e.TrackIndex} {e.Name}");
            mine.Dispose += e => myLog.Add($"dispose {e.TrackIndex} {e.Name}");
            mine.Complete += e => myLog.Add($"complete {e.TrackIndex} {e.Name}");
            mine.Event += (e, ev) => myLog.Add($"event {e.TrackIndex} {ev.Name}@{ev.Time:R}");

            ManagedPose pose = new(content, -1);
            CommandBuffer buffer = new();
            for (int frame = 0; frame < Frames; frame++)
            {
                if (frame == 0 || rng.NextDouble() < 0.07) Act(rng, data, n, stock, mine, frame);
                float dt = s_Deltas[(frame + seed) % s_Deltas.Length];
                stock.Update(dt);
                skeleton.Update(dt);
                stock.Apply(skeleton);
                skeleton.UpdateWorldTransform(Physics.Update);
                pose.Time += dt;
                if (steady && mine.TryAdvanceSteady(dt, out ApplyCommand command, out int unkeyed))
                {
                    // The system's steady frame: the one command, then the after step only when needed.
                    steadyFrames++;
                    buffer.Clear();
                    buffer.Add(command, mine.GetTrack(0));
                    buffer.UnkeyedState = unkeyed;
                    pose.Pose(buffer);
                    FiredEvent[] fired = pose.FiredEvents();
                    if (mine.SteadyNeedsAfter(fired.Length)) mine.AfterSteady(fired);
                }
                else
                {
                    mine.Update(dt);
                    mine.Apply(buffer);
                    pose.Pose(buffer);
                    mine.AfterApply(buffer, pose.FiredEvents(), pose.TotalAlpha, pose.Rotation);
                }

                string at = $"seed {seed} frame {frame}";
                AnimationParityTests.ComparePose(at, skeleton, pose, def, failures);
                if (!ParityDrift.Same("discrete.events", at, stockLog.SequenceEqual(myLog)))
                    failures.Add(
                        $"{at}: listener log differs\n  stock {string.Join(" | ", stockLog.Skip(Math.Max(0, stockLog.Count - 6)))}\n  new   {string.Join(" | ", myLog.Skip(Math.Max(0, myLog.Count - 6)))}");

                ParityLockstep.CompareAndSync(at, skeleton, pose, failures);
                if (failures.Count > 0) return frame + 1;
            }

            return Frames;
        }

        private static void Act(Random rng, SkeletonData data, int n, AnimationState stock, BoneAnimationState mine,
            int frame)
        {
            int track = frame == 0 ? 0 : rng.Next(3), animation = rng.Next(n);
            bool loop = rng.NextDouble() < 0.7;
            int kind = frame == 0 ? 0 : rng.Next(10);
            TrackEntry se;
            BoneTrackEntry me;
            switch (kind)
            {
                case 3:
                case 4:
                {
                    float delay = rng.NextDouble() < 0.5 ? 0 : (float)Math.Round(rng.NextDouble() * 0.6 - 0.2, 2);
                    se = stock.AddAnimation(track, data.Animations.Items[animation], loop, delay);
                    me = mine.AddAnimation(track, animation, loop, delay);
                    break;
                }
                case 5:
                {
                    float mix = (float)Math.Round(rng.NextDouble() * 0.4, 2);
                    se = stock.SetEmptyAnimation(track, mix);
                    me = mine.SetEmptyAnimation(track, mix);
                    break;
                }
                case 6:
                {
                    float mix = (float)Math.Round(rng.NextDouble() * 0.4, 2);
                    float delay = (float)Math.Round(rng.NextDouble() * 0.3, 2);
                    se = stock.AddEmptyAnimation(track, mix, delay);
                    me = mine.AddEmptyAnimation(track, mix, delay);
                    break;
                }
                case 7:
                    stock.ClearTrack(track);
                    mine.ClearTrack(track);
                    return;
                case 8:
                {
                    float scale = rng.NextDouble() < 0.5 ? 1 : (float)Math.Round(0.5 + rng.NextDouble(), 2);
                    stock.TimeScale = scale;
                    mine.TimeScale = scale;
                    return;
                }
                default:
                    se = stock.SetAnimation(track, data.Animations.Items[animation], loop);
                    me = mine.SetAnimation(track, animation, loop);
                    break;
            }

            if (rng.NextDouble() < 0.25)
            {
                float a = (float)Math.Round(0.3 + rng.NextDouble() * 0.7, 2);
                se.Alpha = a;
                me.Alpha = a;
            }

            if (rng.NextDouble() < 0.2)
            {
                float t = (float)Math.Round(0.5 + rng.NextDouble(), 2);
                se.TimeScale = t;
                me.TimeScale = t;
            }

            if (track > 0 && rng.NextDouble() < 0.4)
            {
                se.Additive = true;
                me.Additive = true;
            }

            if (rng.NextDouble() < 0.1)
            {
                se.Reverse = true;
                me.Reverse = true;
            }

            if (rng.NextDouble() < 0.15)
            {
                se.ShortestRotation = true;
                me.ShortestRotation = true;
            }

            if (rng.NextDouble() < 0.2)
            {
                float d = (float)Math.Round(rng.NextDouble() * 0.5, 2);
                se.MixDuration = d;
                me.MixDuration = d;
            }

            if (rng.NextDouble() < 0.15)
            {
                se.EventThreshold = 0.5f;
                me.EventThreshold = 0.5f;
            }

            if (rng.NextDouble() < 0.15)
            {
                se.MixAttachmentThreshold = 0.5f;
                me.MixAttachmentThreshold = 0.5f;
            }

            if (rng.NextDouble() < 0.15)
            {
                se.MixDrawOrderThreshold = 0.5f;
                me.MixDrawOrderThreshold = 0.5f;
            }

            if (rng.NextDouble() < 0.1)
            {
                se.AlphaAttachmentThreshold = 0.5f;
                me.AlphaAttachmentThreshold = 0.5f;
            }
        }
    }
}