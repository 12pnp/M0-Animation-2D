using System;
using BoneBurst.Blob;
using BoneBurst.Constraints;
using BoneBurst.Data;
using BoneBurst.Instance;
using BoneBurst.TwinSpline;
using Unity.Mathematics;

namespace BoneBurst.Anim
{
    /// <summary>
    ///     Which of <c>AnimationState</c>'s three apply paths a command takes (AnimationState.md §6).
    /// </summary>
    public enum CommandKind : byte
    {
        /// <summary>
        ///     Track 0 at alpha exactly 1: every timeline from Setup, no add, attachments retained (T§5.4).
        /// </summary>
        Fast,

        /// <summary>
        ///     The current entry otherwise: per-timeline <c>from</c>, rotation with direction memory (§6.2).
        /// </summary>
        Current,

        /// <summary>
        ///     A mixing-out entry: per-timeline from and hold, alphaMix / alphaHold, thresholds (§6.3).
        /// </summary>
        MixingFrom
    }

    /// <summary>
    ///     One entry's apply in one frame. Per-timeline data (modes, hold factors, rotation memory) lives in the
    ///     instance's command buffers at the given starts.
    /// </summary>
    public struct ApplyCommand
    {
        public CommandKind Kind;
        public int Animation;
        public float LastTime, Time;

        /// <summary>
        ///     Fast / Current: the entry's alpha. MixingFrom: alphaMix.
        /// </summary>
        public float Alpha;

        public float AlphaHold;
        public bool Add, FireEvents;

        /// <summary>
        ///     Current: attachments are retained (alpha ≥ alphaAttachmentThreshold). MixingFrom: mix is below
        ///     mixAttachmentThreshold.
        /// </summary>
        public bool Retain;

        /// <summary>
        ///     MixingFrom: mix is below mixDrawOrderThreshold.
        /// </summary>
        public bool DrawOrder;

        public float AlphaAttachmentThreshold;

        /// <summary>
        ///     Rotate timelines go through <see cref="TimelineApply.RotateMixed" /> (not additive, not shortest).
        /// </summary>
        public bool RotateMixing;

        public bool FirstFrame;

        /// <summary>
        ///     Starts in the instance's mode, hold-factor and rotation buffers; -1 when unused.
        /// </summary>
        public int ModesStart, HoldFactorsStart, RotationStart;

        // Single-command helpers (tests, direct use).
        public MixFrom From;
        public bool MixOut;

        /// <summary>
        ///     A plain <c>Animation.Apply</c> (a slider), not an <c>AnimationState</c> entry: attachment timelines
        ///     follow Timelines.md §3.4 and keep no per-apply bookkeeping.
        /// </summary>
        public bool Plain;
    }

    /// <summary>
    ///     Bits of a per-timeline mode byte: <see cref="MixFrom" /> in the low two bits, plus <see cref="Hold" />.
    /// </summary>
    public static class TimelineMode
    {
        public const byte FromMask = 3, Hold = 4;
    }

    /// <summary>
    ///     One fired event: the index of its <see cref="EventBlob" /> in the blob.
    /// </summary>
    public struct FiredEvent
    {
        /// <summary>
        ///     Index of the command (entry) whose timeline fired it.
        /// </summary>
        public int Command;

        public int Event;
    }

    /// <summary>
    ///     Applies timelines to an instance's local pose: <c>Doc/Format/Timelines.md</c> §2–3, operation for
    ///     operation. Pointer-based; the sample job and the managed reference both call it.
    /// </summary>
    /// <remarks>
    ///     Timelines write the unconstrained pose (bone locals, slot state, draw order, constraint poses); the
    ///     world pass and constraint solvers read it afterwards.
    /// </remarks>
    public static unsafe class TimelineApply
    {
        /// <summary>
        ///     Runs every command of the frame in order, then the end-of-apply attachment reset.
        /// </summary>
        public static void ApplyAll(in InstanceHeader h)
        {
            for (int c = 0; c < h.CommandCount; c++) h.TotalAlpha[c] = Apply(h, h.Commands[c], c);

            if (h.ApplyRan) EndApply(h);
        }

        /// <summary>
        ///     Applies one entry's timelines in stored order along its command's path. Returns the total alpha the
        ///     timelines were applied with (MixingFrom; stock's <c>totalAlpha</c>).
        /// </summary>
        public static float Apply(in InstanceHeader h, in ApplyCommand c, int commandIndex)
        {
            BlobView blob = h.Blob;
            AnimationBlob animation = blob.Animations[c.Animation];
            *h.CurrentCommand = commandIndex;
            float total = 0;
            for (int i = 0; i < animation.TimelineCount; i++)
            {
                TimelineBlob* t = blob.Timelines + animation.TimelineStart + i;
                switch (c.Kind)
                {
                    case CommandKind.Fast:
                    {
                        ApplyCommand tc = c;
                        tc.From = MixFrom.Setup;
                        tc.Alpha = 1;
                        tc.Add = false;
                        tc.MixOut = false;
                        tc.Retain = true;
                        ApplyTimeline(h, t, tc);
                        break;
                    }
                    case CommandKind.Current:
                    {
                        ApplyCommand tc = c;
                        tc.From = (MixFrom)(h.Modes[c.ModesStart + i] & TimelineMode.FromMask);
                        tc.MixOut = false;
                        if (c.RotateMixing && t->Kind == TimelineKind.BoneRotate)
                            RotateMixed(h, t, c.Time, c.Alpha, tc.From, h.Rotation + c.RotationStart + 2 * i,
                                c.FirstFrame);
                        else
                            ApplyTimeline(h, t, tc);

                        break;
                    }
                    default:
                    {
                        byte mode = h.Modes[c.ModesStart + i];
                        ApplyCommand tc = c;
                        tc.From = (MixFrom)(mode & TimelineMode.FromMask);
                        float alpha;
                        if ((mode & TimelineMode.Hold) != 0)
                        {
                            alpha = c.HoldFactorsStart < 0
                                ? c.AlphaHold
                                : c.AlphaHold * h.HoldFactors[c.HoldFactorsStart + i];
                        }
                        else
                        {
                            if (!c.DrawOrder && t->Kind == TimelineKind.DrawOrder && tc.From == MixFrom.Current)
                                continue;

                            alpha = c.Alpha;
                        }

                        total += alpha;
                        tc.Alpha = alpha;
                        if (c.RotateMixing && t->Kind == TimelineKind.BoneRotate)
                        {
                            RotateMixed(h, t, c.Time, alpha, tc.From, h.Rotation + c.RotationStart + 2 * i,
                                c.FirstFrame);
                        }
                        else if (t->Kind == TimelineKind.SlotAttachment)
                        {
                            tc.Retain = c.Retain && alpha >= c.AlphaAttachmentThreshold;
                            ApplyTimeline(h, t, tc);
                        }
                        else
                        {
                            tc.MixOut = !c.DrawOrder || t->Kind != TimelineKind.DrawOrder || tc.From == MixFrom.Current;
                            ApplyTimeline(h, t, tc);
                        }

                        break;
                    }
                }
            }

            return total;
        }

        /// <summary>
        ///     <c>Animation.Apply</c> (Timelines.md §4) with <c>from = Current</c>, no events and <c>mixOut = false</c>:
        ///     what a slider does. The header's pose pointers are where it writes (the slider passes the applied
        ///     pose).
        /// </summary>
        public static void ApplyAnimation(in InstanceHeader h, int animation, float lastTime, float time, bool loop,
            float alpha, bool add)
        {
            AnimationBlob anim = h.Blob.Animations[animation];
            if (loop && anim.Duration != 0)
            {
                time %= anim.Duration;
                if (lastTime > 0) lastTime %= anim.Duration;
            }

            ApplyCommand c = new()
            {
                Animation = animation, LastTime = lastTime, Time = time, Alpha = alpha, Add = add,
                From = MixFrom.Current, Plain = true
            };
            for (int i = 0; i < anim.TimelineCount; i++) ApplyTimeline(h, h.Blob.Timelines + anim.TimelineStart + i, c);
        }

        /// <summary>
        ///     End of an <c>AnimationState.Apply</c>: slots whose attachment was keyed only temporarily go back to
        ///     their setup attachment (§5.4). The epoch (<c>*UnkeyedState</c>) is owned and advanced by the managed
        ///     <see cref="BoneAnimationState" />, which advances it on every apply as stock does.
        /// </summary>
        public static void EndApply(in InstanceHeader h)
        {
            int attachSetup = *h.UnkeyedState + 1;
            for (int s = 0; s < h.Blob.SlotCount; s++)
                if (h.Slots[s].AttachmentState == attachSetup)
                    SetAttachment(h, s, h.SetupAttachments[s]);
        }

        private static void ApplyTimeline(in InstanceHeader h, TimelineBlob* t, in ApplyCommand c)
        {
            float* frames = h.Blob.Frames + t->FramesStart;
            float time = c.Time, alpha = c.Alpha;
            switch (t->Kind)
            {
                case TimelineKind.BoneRotate:
                    if (!h.BoneActive[t->Target]) return;
                    h.Local[t->Target].Rotation = Relative(h, t, frames, time, alpha, c.From, c.Add,
                        h.Local[t->Target].Rotation, h.Blob.Bones[t->Target].Rotation);
                    return;
                case TimelineKind.BoneTranslateX:
                    if (!h.BoneActive[t->Target]) return;
                    h.Local[t->Target].X = Relative(h, t, frames, time, alpha, c.From, c.Add, h.Local[t->Target].X,
                        h.Blob.Bones[t->Target].X);
                    return;
                case TimelineKind.BoneTranslateY:
                    if (!h.BoneActive[t->Target]) return;
                    h.Local[t->Target].Y = Relative(h, t, frames, time, alpha, c.From, c.Add, h.Local[t->Target].Y,
                        h.Blob.Bones[t->Target].Y);
                    return;
                case TimelineKind.BoneShearX:
                    if (!h.BoneActive[t->Target]) return;
                    h.Local[t->Target].ShearX = Relative(h, t, frames, time, alpha, c.From, c.Add,
                        h.Local[t->Target].ShearX, h.Blob.Bones[t->Target].ShearX);
                    return;
                case TimelineKind.BoneShearY:
                    if (!h.BoneActive[t->Target]) return;
                    h.Local[t->Target].ShearY = Relative(h, t, frames, time, alpha, c.From, c.Add,
                        h.Local[t->Target].ShearY, h.Blob.Bones[t->Target].ShearY);
                    return;
                case TimelineKind.BoneScaleX:
                    if (!h.BoneActive[t->Target]) return;
                    h.Local[t->Target].ScaleX = Scale(h, t, frames, time, alpha, c.From, c.Add, c.MixOut,
                        h.Local[t->Target].ScaleX, h.Blob.Bones[t->Target].ScaleX, 0);
                    return;
                case TimelineKind.BoneScaleY:
                    if (!h.BoneActive[t->Target]) return;
                    h.Local[t->Target].ScaleY = Scale(h, t, frames, time, alpha, c.From, c.Add, c.MixOut,
                        h.Local[t->Target].ScaleY, h.Blob.Bones[t->Target].ScaleY, 0);
                    return;
                case TimelineKind.BoneTranslate:
                case TimelineKind.BoneShear:
                    BoneTwo(h, t, frames, c);
                    return;
                case TimelineKind.BoneTranslateSpline:
                    BoneSpline(h, t, c);
                    return;
                case TimelineKind.BoneScale:
                    BoneScale(h, t, frames, c);
                    return;
                case TimelineKind.BoneInherit:
                    Inherit(h, t, frames, c);
                    return;
                case TimelineKind.SlotRgba:
                case TimelineKind.SlotRgb:
                case TimelineKind.SlotAlpha:
                case TimelineKind.SlotRgba2:
                case TimelineKind.SlotRgb2:
                    SlotColor(h, t, frames, c);
                    return;
                case TimelineKind.SlotAttachment:
                    Attachment(h, t, frames, c);
                    return;
                case TimelineKind.Deform:
                    Deform(h, t, frames, c);
                    return;
                case TimelineKind.Sequence:
                    Sequence(h, t, frames, c);
                    return;
                case TimelineKind.DrawOrder:
                    DrawOrder(h, t, frames, c);
                    return;
                case TimelineKind.DrawOrderFolder:
                    DrawOrderFolder(h, t, frames, c);
                    return;
                case TimelineKind.Event:
                    if (c.FireEvents) Events(h, t, frames, c.LastTime, time);
                    return;
                case TimelineKind.Ik:
                    Ik(h, t, frames, c);
                    return;
                case TimelineKind.Transform:
                case TimelineKind.PathMix:
                    Mixes(h, t, frames, c);
                    return;
                case TimelineKind.PathPosition:
                {
                    if (!h.ConstraintActive[t->Target]) return;
                    ConstraintPose* p = h.Constraints + t->Target;
                    p->Position = Absolute(h, t, frames, time, alpha, c.From, c.Add, p->Position,
                        h.Blob.ConstraintSetups[t->Target].Position);
                    return;
                }
                case TimelineKind.PathSpacing:
                {
                    if (!h.ConstraintActive[t->Target]) return;
                    ConstraintPose* p = h.Constraints + t->Target;
                    p->Spacing = Absolute(h, t, frames, time, alpha, c.From, false, p->Spacing,
                        h.Blob.ConstraintSetups[t->Target].Spacing);
                    return;
                }
                case TimelineKind.SliderTime:
                {
                    if (!h.ConstraintActive[t->Target]) return;
                    ConstraintPose* p = h.Constraints + t->Target;
                    p->Time = Absolute(h, t, frames, time, alpha, c.From, c.Add, p->Time,
                        h.Blob.ConstraintSetups[t->Target].Time);
                    return;
                }
                case TimelineKind.SliderMix:
                {
                    if (!h.ConstraintActive[t->Target]) return;
                    ConstraintPose* p = h.Constraints + t->Target;
                    p->Mix = Absolute(h, t, frames, time, alpha, c.From, c.Add, p->Mix,
                        h.Blob.ConstraintSetups[t->Target].Mix);
                    return;
                }
                case TimelineKind.PhysicsReset:
                    PhysicsReset(h, t, frames, c.LastTime, time);
                    return;
                default:
                    if (t->Kind >= TimelineKind.PhysicsInertia && t->Kind <= TimelineKind.PhysicsMix)
                        Physics(h, t, frames, c);

                    return;
            }
        }

        // ---------------------------------------------------------------- §2 shared machinery

        /// <summary>
        ///     §2.2: index (in floats) of the last key whose time is at or before <paramref name="time" />.
        /// </summary>
        private static int Search(float* frames, int length, float time, int stride)
        {
            for (int i = stride; i < length; i += stride)
                if (frames[i] > time)
                    return i - stride;

            return length - stride;
        }

        /// <summary>
        ///     §2.4: one channel sampled at <paramref name="time" /> from key index <paramref name="i" />.
        /// </summary>
        private static float Sample(in InstanceHeader h, TimelineBlob* t, float* frames, float time, int i,
            int valueOffset,
            int channel)
        {
            int entries = t->Entries;
            float* curves = h.Blob.Curves + t->CurvesStart;
            int type = (int)curves[i / entries];
            switch (type)
            {
                case 0:
                {
                    float before = frames[i], value = frames[i + valueOffset];
                    return value + (time - before) / (frames[i + entries] - before) *
                        (frames[i + entries + valueOffset] - value);
                }
                case 1:
                    return frames[i + valueOffset];
            }

            int b = type - 2 + CurveType.BezierSize * channel;
            if (curves[b] > time)
            {
                float x = frames[i], y = frames[i + valueOffset];
                return y + (time - x) / (curves[b] - x) * (curves[b + 1] - y);
            }

            int n = b + CurveType.BezierSize;
            for (int s = b + 2; s < n; s += 2)
                if (curves[s] >= time)
                {
                    float x = curves[s - 2], y = curves[s - 1];
                    return y + (time - x) / (curves[s] - x) * (curves[s + 1] - y);
                }

            {
                float x = curves[n - 2], y = curves[n - 1];
                return y + (time - x) / (frames[i + entries] - x) * (frames[i + entries + valueOffset] - y);
            }
        }

        private static float SampleOne(in InstanceHeader h, TimelineBlob* t, float* frames, float time)
        {
            int i = Search(frames, t->FrameCount * 2, time, 2);
            return Sample(h, t, frames, time, i, 1, 0);
        }

        private static float BeforeFirst(MixFrom from, float alpha, float current, float setup)
        {
            switch (from)
            {
                case MixFrom.First: return current + (setup - current) * alpha;
                case MixFrom.Current: return current;
                default: return setup;
            }
        }

        // §2.5 relative: rotate, translateX/Y, shearX/Y.
        private static float Relative(in InstanceHeader h, TimelineBlob* t, float* frames, float time, float alpha,
            MixFrom from, bool add, float current, float setup)
        {
            if (time < frames[0]) return BeforeFirst(from, alpha, current, setup);
            float value = SampleOne(h, t, frames, time);
            if (from == MixFrom.Setup) return setup + value * alpha;
            if (add) return current + value * alpha;
            return current + (value + setup - current) * alpha;
        }

        // §2.5 absolute: path position/spacing, physics, slider.
        private static float Absolute(in InstanceHeader h, TimelineBlob* t, float* frames, float time, float alpha,
            MixFrom from, bool add, float current, float setup)
        {
            if (time < frames[0]) return BeforeFirst(from, alpha, current, setup);
            return Combine(SampleOne(h, t, frames, time), alpha, from, add, current, setup);
        }

        private static float Combine(float value, float alpha, MixFrom from, bool add, float current, float setup)
        {
            if (from == MixFrom.Setup) return add ? setup + value * alpha : setup + (value - setup) * alpha;

            return add ? current + value * alpha : current + (value - current) * alpha;
        }

        // §2.5 scale (one channel); valueOffset/channel select the channel for Scale (x, y).
        private static float Scale(in InstanceHeader h, TimelineBlob* t, float* frames, float time, float alpha,
            MixFrom from,
            bool add, bool mixOut, float current, float setup, int channel)
        {
            if (time < frames[0]) return BeforeFirst(from, alpha, current, setup);
            int i = Search(frames, t->FrameCount * t->Entries, time, t->Entries);
            float value = Sample(h, t, frames, time, i, 1 + channel, channel) * setup;
            return ScaleCombine(value, alpha, from, add, mixOut, current, setup);
        }

        private static float ScaleCombine(float value, float alpha, MixFrom from, bool add, bool mixOut, float current,
            float setup)
        {
            if (alpha == 1 && !add) return value;
            float b = from == MixFrom.Setup ? setup : current;
            if (add) return b + (value - setup) * alpha;
            if (mixOut) return b + (Math.Abs(value) * Sign(b) - b) * alpha;
            float b2 = Math.Abs(b) * Sign(value);
            return b2 + (value - b2) * alpha;
        }

        /// <summary>
        ///     <c>Math.Sign</c> on a float: integer -1, 0 or 1; 0 for both zeros. (NaN gives 0 here; the stock
        ///     runtime throws.)
        /// </summary>
        private static int Sign(float value)
        {
            return value > 0 ? 1 : value < 0 ? -1 : 0;
        }

        // ---------------------------------------------------------------- Timelines.md §5.7 rotation mixing

        /// <summary>
        ///     <c>AnimationState.ApplyRotateTimeline</c>: mixes a rotate timeline along the direction chosen on the
        ///     mix's first frame, kept in <paramref name="memory" /> (total, lastDiff) for later frames.
        /// </summary>
        public static void RotateMixed(in InstanceHeader h, TimelineBlob* t, float time, float alpha, MixFrom from,
            float* memory, bool firstFrame)
        {
            if (firstFrame) memory[0] = 0;
            float* frames = h.Blob.Frames + t->FramesStart;
            if (alpha == 1)
            {
                ApplyTimeline(h, t, new ApplyCommand { LastTime = 0, Time = time, Alpha = 1, From = from });
                return;
            }

            int bone = t->Target;
            if (!h.BoneActive[bone]) return;
            BoneLocal* pose = h.Local + bone;
            float setup = h.Blob.Bones[bone].Rotation;
            float r1, r2;
            if (time < frames[0])
            {
                switch (from)
                {
                    case MixFrom.Setup:
                        pose->Rotation = setup;
                        return;
                    case MixFrom.Current:
                        return;
                    default:
                        r1 = pose->Rotation;
                        r2 = setup;
                        break;
                }
            }
            else
            {
                r1 = from == MixFrom.Setup ? setup : pose->Rotation;
                r2 = setup + SampleOne(h, t, frames, time);
            }

            float total, diff = r2 - r1;
            diff -= (float)Math.Ceiling(diff / 360 - 0.5) * 360;
            if (diff == 0)
            {
                total = memory[0];
            }
            else
            {
                float lastTotal, lastDiff;
                if (firstFrame)
                {
                    lastTotal = 0;
                    lastDiff = diff;
                }
                else
                {
                    lastTotal = memory[0];
                    lastDiff = memory[1];
                }

                float loops = lastTotal - lastTotal % 360;
                total = diff + loops;
                bool current = diff >= 0, dir = lastTotal >= 0;
                if (Math.Abs(lastDiff) <= 90 && Sign(lastDiff) != Sign(diff))
                {
                    if (Math.Abs(lastTotal - loops) > 180)
                    {
                        total += 360 * Sign(lastTotal);
                        dir = current;
                    }
                    else if (loops != 0)
                    {
                        total -= 360 * Sign(lastTotal);
                    }
                    else
                    {
                        dir = current;
                    }
                }

                if (dir != current) total += 360 * Sign(lastTotal);
                memory[0] = total;
            }

            memory[1] = diff;
            pose->Rotation = r1 + total * alpha;
        }

        // ---------------------------------------------------------------- §3.2 bones

        private static void BoneTwo(in InstanceHeader h, TimelineBlob* t, float* frames, in ApplyCommand c)
        {
            int bone = t->Target;
            if (!h.BoneActive[bone]) return;
            BoneLocal* p = h.Local + bone;
            BoneSetup setup = h.Blob.Bones[bone];
            bool shear = t->Kind == TimelineKind.BoneShear;
            float x = shear ? p->ShearX : p->X, y = shear ? p->ShearY : p->Y;
            float sx0 = shear ? setup.ShearX : setup.X, sy0 = shear ? setup.ShearY : setup.Y;
            float time = c.Time, alpha = c.Alpha;
            if (time < frames[0])
            {
                switch (c.From)
                {
                    case MixFrom.Setup:
                        x = sx0;
                        y = sy0;
                        break;
                    case MixFrom.First:
                        x = x + (sx0 - x) * alpha;
                        y = y + (sy0 - y) * alpha;
                        break;
                    default:
                        return;
                }
            }
            else
            {
                int i = Search(frames, t->FrameCount * 3, time, 3);
                float vx = Sample(h, t, frames, time, i, 1, 0), vy = Sample(h, t, frames, time, i, 2, 1);
                if (c.From == MixFrom.Setup)
                {
                    x = sx0 + vx * alpha;
                    y = sy0 + vy * alpha;
                }
                else if (c.Add)
                {
                    x = x + vx * alpha;
                    y = y + vy * alpha;
                }
                else
                {
                    x = x + (sx0 + vx - x) * alpha;
                    y = y + (sy0 + vy - y) * alpha;
                }
            }

            if (shear)
            {
                p->ShearX = x;
                p->ShearY = y;
            }
            else
            {
                p->X = x;
                p->Y = y;
            }
        }

        /// <summary>
        ///     A bone's translation from a TwinSpline path, mixed as <see cref="BoneTwo" /> mixes keyed translation: the
        ///     path's point at the animation's time is the bone's place, so (setup + value) in the keyed formulas is
        ///     that point. There is no first frame to be before: a path has a place at every time.
        /// </summary>
        private static void BoneSpline(in InstanceHeader h, TimelineBlob* t, in ApplyCommand c)
        {
            int bone = t->Target;
            if (!h.BoneActive[bone]) return;
            BoneLocal* p = h.Local + bone;
            BoneSetup setup = h.Blob.Bones[bone];
            TwinSplineMath.Pose(h.Blob.DeformFrames + t->ExtraStart, c.Time, out float px, out float py);
            float alpha = c.Alpha;
            if (c.From == MixFrom.Setup)
            {
                p->X = setup.X + (px - setup.X) * alpha;
                p->Y = setup.Y + (py - setup.Y) * alpha;
            }
            else if (c.Add)
            {
                p->X += (px - setup.X) * alpha;
                p->Y += (py - setup.Y) * alpha;
            }
            else
            {
                p->X += (px - p->X) * alpha;
                p->Y += (py - p->Y) * alpha;
            }
        }

        private static void BoneScale(in InstanceHeader h, TimelineBlob* t, float* frames, in ApplyCommand c)
        {
            int bone = t->Target;
            if (!h.BoneActive[bone]) return;
            BoneLocal* p = h.Local + bone;
            BoneSetup setup = h.Blob.Bones[bone];
            float time = c.Time, alpha = c.Alpha;
            if (time < frames[0])
                switch (c.From)
                {
                    case MixFrom.Setup:
                        p->ScaleX = setup.ScaleX;
                        p->ScaleY = setup.ScaleY;
                        return;
                    case MixFrom.First:
                        p->ScaleX = p->ScaleX + (setup.ScaleX - p->ScaleX) * alpha;
                        p->ScaleY = p->ScaleY + (setup.ScaleY - p->ScaleY) * alpha;
                        return;
                    default:
                        return;
                }

            int i = Search(frames, t->FrameCount * 3, time, 3);
            float sx = Sample(h, t, frames, time, i, 1, 0) * setup.ScaleX;
            float sy = Sample(h, t, frames, time, i, 2, 1) * setup.ScaleY;
            float cx = p->ScaleX, cy = p->ScaleY;
            p->ScaleX = ScaleCombine(sx, alpha, c.From, c.Add, c.MixOut, cx, setup.ScaleX);
            p->ScaleY = ScaleCombine(sy, alpha, c.From, c.Add, c.MixOut, cy, setup.ScaleY);
        }

        private static void Inherit(in InstanceHeader h, TimelineBlob* t, float* frames, in ApplyCommand c)
        {
            int bone = t->Target;
            if (!h.BoneActive[bone]) return;
            if (c.MixOut || c.Time < frames[0])
            {
                if (c.From != MixFrom.Current) h.Local[bone].Inherit = h.Blob.Bones[bone].Inherit;
                return;
            }

            h.Local[bone].Inherit = (Inherit)(int)frames[Search(frames, t->FrameCount * 2, c.Time, 2) + 1];
        }

        // ---------------------------------------------------------------- §3.3 slot colours

        private static float Clamp(float v)
        {
            return v < 0 ? 0 : v > 1 ? 1 : v;
        }

        private static void SlotColor(in InstanceHeader h, TimelineBlob* t, float* frames, in ApplyCommand c)
        {
            int slot = t->Target;
            if (!h.BoneActive[h.Blob.Slots[slot].Bone]) return;
            SlotState* p = h.Slots + slot;
            SlotSetup setup = h.Blob.Slots[slot];
            float time = c.Time, alpha = c.Alpha;
            TimelineKind kind = t->Kind;
            bool lightRgb = kind != TimelineKind.SlotAlpha;
            bool lightA = kind == TimelineKind.SlotRgba || kind == TimelineKind.SlotRgba2 ||
                          kind == TimelineKind.SlotAlpha;
            bool dark = kind == TimelineKind.SlotRgba2 || kind == TimelineKind.SlotRgb2;

            if (time < frames[0])
            {
                if (c.From == MixFrom.Current) return;
                if (c.From == MixFrom.Setup)
                {
                    if (lightRgb) p->Color.xyz = setup.Color.xyz;
                    if (lightA) p->Color.w = setup.Color.w;
                    if (dark) p->DarkColor = setup.DarkColor;
                    return;
                }

                if (lightRgb)
                {
                    p->Color.x = p->Color.x + (setup.Color.x - p->Color.x) * alpha;
                    p->Color.y = p->Color.y + (setup.Color.y - p->Color.y) * alpha;
                    p->Color.z = p->Color.z + (setup.Color.z - p->Color.z) * alpha;
                }

                if (lightA) p->Color.w = p->Color.w + (setup.Color.w - p->Color.w) * alpha;
                if (dark)
                {
                    p->DarkColor.x = p->DarkColor.x + (setup.DarkColor.x - p->DarkColor.x) * alpha;
                    p->DarkColor.y = p->DarkColor.y + (setup.DarkColor.y - p->DarkColor.y) * alpha;
                    p->DarkColor.z = p->DarkColor.z + (setup.DarkColor.z - p->DarkColor.z) * alpha;
                }

                return;
            }

            int entries = t->Entries;
            int i = Search(frames, t->FrameCount * entries, time, entries);
            float r = 0, g = 0, b = 0, a = 0, r2 = 0, g2 = 0, b2 = 0;
            int channel = 0;
            if (lightRgb)
            {
                r = Sample(h, t, frames, time, i, 1, 0);
                g = Sample(h, t, frames, time, i, 2, 1);
                b = Sample(h, t, frames, time, i, 3, 2);
                channel = 3;
            }

            if (lightA)
            {
                a = Sample(h, t, frames, time, i, channel + 1, channel);
                channel++;
            }

            if (dark)
            {
                r2 = Sample(h, t, frames, time, i, channel + 1, channel);
                g2 = Sample(h, t, frames, time, i, channel + 2, channel + 1);
                b2 = Sample(h, t, frames, time, i, channel + 3, channel + 2);
            }

            if (alpha != 1)
            {
                bool fromSetup = c.From == MixFrom.Setup;
                float4Blend(ref r, ref g, ref b, ref a, fromSetup ? setup.Color : p->Color, alpha, lightRgb, lightA);
                if (dark)
                {
                    float3 d = fromSetup ? setup.DarkColor : p->DarkColor;
                    r2 = d.x + (r2 - d.x) * alpha;
                    g2 = d.y + (g2 - d.y) * alpha;
                    b2 = d.z + (b2 - d.z) * alpha;
                }
            }

            if (lightRgb)
            {
                p->Color.x = Clamp(r);
                p->Color.y = Clamp(g);
                p->Color.z = Clamp(b);
            }

            if (lightA) p->Color.w = Clamp(a);
            if (dark)
            {
                p->DarkColor.x = Clamp(r2);
                p->DarkColor.y = Clamp(g2);
                p->DarkColor.z = Clamp(b2);
            }
        }

        private static void float4Blend(ref float r, ref float g, ref float b, ref float a, float4 from,
            float alpha, bool rgb, bool withAlpha)
        {
            if (rgb)
            {
                r = from.x + (r - from.x) * alpha;
                g = from.y + (g - from.y) * alpha;
                b = from.z + (b - from.z) * alpha;
            }

            if (withAlpha) a = from.w + (a - from.w) * alpha;
        }

        // ---------------------------------------------------------------- §3.4 / §5.5 attachments

        private static void Attachment(in InstanceHeader h, TimelineBlob* t, float* frames, in ApplyCommand c)
        {
            int slot = t->Target;
            if (!h.BoneActive[h.Blob.Slots[slot].Bone]) return;
            SlotState* p = h.Slots + slot;
            if (c.Plain)
            {
                if (c.MixOut || c.Time < frames[0])
                {
                    if (c.From != MixFrom.Current) SetAttachment(h, slot, h.SetupAttachments[slot]);
                }
                else
                {
                    int key = h.Blob.Ints[t->ExtraStart + Search(frames, t->FrameCount, c.Time, 1)];
                    SetAttachment(h, slot, key < 0 ? -1 : h.KeyAttachment[key]);
                }

                return;
            }

            int attachSetup = *h.UnkeyedState + 1, attachRetain = *h.UnkeyedState + 2;
            if (!c.Retain && p->AttachmentState == attachRetain) return;

            bool useSetup = c.Time < frames[0];
            int attachment = -1;
            if (!useSetup)
            {
                int key = h.Blob.Ints[t->ExtraStart + Search(frames, t->FrameCount, c.Time, 1)];
                useSetup = !c.Retain && key < 0;
                if (!useSetup) attachment = key < 0 ? -1 : h.KeyAttachment[key];
            }

            if (useSetup)
            {
                if (c.From == MixFrom.Current) return;
                attachment = h.SetupAttachments[slot];
            }

            SetAttachment(h, slot, attachment);
            if (c.Retain) p->AttachmentState = attachRetain;
            else if (!useSetup) p->AttachmentState = attachSetup;
        }

        /// <summary>
        ///     The slot attachment setter's side effects (§3.4): no change does nothing; otherwise the sequence
        ///     index resets, and deform clears unless both are vertex attachments sharing a timeline attachment.
        /// </summary>
        public static void SetAttachment(in InstanceHeader h, int slot, int attachment)
        {
            SlotState* p = h.Slots + slot;
            int old = p->Attachment;
            if (old == attachment) return;
            bool keepDeform = old >= 0 && attachment >= 0 && IsVertex(h.Blob.Attachments[old].Kind) &&
                              IsVertex(h.Blob.Attachments[attachment].Kind) &&
                              h.Blob.Attachments[old].TimelineAttachment ==
                              h.Blob.Attachments[attachment].TimelineAttachment;
            if (!keepDeform) ClearDeform(h, slot);
            p->Attachment = attachment;
            p->SequenceIndex = -1;
        }

        private static bool IsVertex(AttachmentKind kind)
        {
            return kind != AttachmentKind.Region && kind != AttachmentKind.Point;
        }

        // ---------------------------------------------------------------- §3.5 deform

        private static bool Matches(in InstanceHeader h, int slot, int timelineAttachment)
        {
            SlotState s = h.Slots[slot];
            return h.BoneActive[h.Blob.Slots[slot].Bone] && s.Attachment >= 0 &&
                   h.Blob.Attachments[s.Attachment].TimelineAttachment == timelineAttachment;
        }

        private static bool TimelineActive(in InstanceHeader h, TimelineBlob* t)
        {
            if (Matches(h, t->Target, t->Attachment)) return true;
            AttachmentBlob a = h.Blob.Attachments[t->Attachment];
            for (int k = 0; k < a.TimelineSlotsCount; k++)
                if (Matches(h, h.Blob.TimelineSlots[a.TimelineSlotsStart + k], t->Attachment))
                    return true;

            return false;
        }

        private static void ClearDeform(in InstanceHeader h, int slot)
        {
            float* d = h.Deform + h.Blob.SlotDeformStart[slot];
            int capacity = h.Blob.SlotDeformCapacity[slot];
            for (int k = 0; k < capacity; k++) d[k] = 0;
            h.Slots[slot].DeformCount = 0;
        }

        private static void Deform(in InstanceHeader h, TimelineBlob* t, float* frames, in ApplyCommand c)
        {
            if (!TimelineActive(h, t)) return;
            AttachmentBlob keyed = h.Blob.Attachments[t->Attachment];
            float time = c.Time;
            int frameCount = t->FrameCount, vertexCount = t->ExtraLength;
            float* all = h.Blob.DeformFrames + t->ExtraStart;

            if (time < frames[0])
            {
                DeformBeforeFirst(h, t->Target, t, c, vertexCount);
                for (int k = 0; k < keyed.TimelineSlotsCount; k++)
                    DeformBeforeFirst(h, h.Blob.TimelineSlots[keyed.TimelineSlotsStart + k], t, c, vertexCount);

                return;
            }

            float percent = 0;
            float* v1, v2 = null;
            if (time >= frames[frameCount - 1])
            {
                v1 = all + (frameCount - 1) * vertexCount;
            }
            else
            {
                int f = Search(frames, frameCount, time, 1);
                percent = DeformPercent(h, t, frames, time, f);
                v1 = all + f * vertexCount;
                v2 = all + (f + 1) * vertexCount;
            }

            DeformSlot(h, t->Target, t, c, vertexCount, percent, v1, v2);
            for (int k = 0; k < keyed.TimelineSlotsCount; k++)
                DeformSlot(h, h.Blob.TimelineSlots[keyed.TimelineSlotsStart + k], t, c, vertexCount, percent, v1, v2);
        }

        // §3.5.2
        private static float DeformPercent(in InstanceHeader h, TimelineBlob* t, float* frames, float time, int f)
        {
            float* curves = h.Blob.Curves + t->CurvesStart;
            int type = (int)curves[f];
            switch (type)
            {
                case 0:
                {
                    float x = frames[f];
                    return (time - x) / (frames[f + 1] - x);
                }
                case 1:
                    return 0;
            }

            int b = type - 2;
            if (curves[b] > time)
            {
                float x = frames[f];
                return curves[b + 1] * (time - x) / (curves[b] - x);
            }

            int n = b + CurveType.BezierSize;
            for (int s = b + 2; s < n; s += 2)
                if (curves[s] >= time)
                {
                    float x = curves[s - 2], y = curves[s - 1];
                    return y + (time - x) / (curves[s] - x) * (curves[s + 1] - y);
                }

            {
                float x = curves[n - 2], y = curves[n - 1];
                return y + (1 - y) * (time - x) / (frames[f + 1] - x);
            }
        }

        // §3.5.3
        private static void DeformBeforeFirst(in InstanceHeader h, int slot, TimelineBlob* t, in ApplyCommand c,
            int vertexCount)
        {
            if (!Matches(h, slot, t->Attachment)) return;
            SlotState* s = h.Slots + slot;
            MixFrom from = s->DeformCount == 0 ? MixFrom.Setup : c.From;
            if (from == MixFrom.Current) return;
            if (from == MixFrom.Setup || c.Alpha == 1)
            {
                ClearDeform(h, slot);
                return;
            }

            // First, alpha < 1: resize, then move toward setup.
            float* d = h.Deform + h.Blob.SlotDeformStart[slot];
            Resize(h, slot, vertexCount);
            AttachmentBlob current = h.Blob.Attachments[s->Attachment];
            if (current.BonesStart < 0)
            {
                float* setup = h.Blob.Vertices + current.VerticesStart;
                for (int k = 0; k < vertexCount; k++) d[k] = d[k] + (setup[k] - d[k]) * c.Alpha;
            }
            else
            {
                float a = 1 - c.Alpha;
                for (int k = 0; k < vertexCount; k++) d[k] = d[k] * a;
            }
        }

        private static void Resize(in InstanceHeader h, int slot, int count)
        {
            float* d = h.Deform + h.Blob.SlotDeformStart[slot];
            SlotState* s = h.Slots + slot;
            if (count > s->DeformCount)
                for (int k = s->DeformCount; k < count; k++)
                    d[k] = 0;
            else
                for (int k = count; k < s->DeformCount; k++)
                    d[k] = 0;

            s->DeformCount = count;
        }

        // §3.5.4
        private static void DeformSlot(in InstanceHeader h, int slot, TimelineBlob* t, in ApplyCommand c,
            int vertexCount,
            float percent, float* v1, float* v2)
        {
            if (!Matches(h, slot, t->Attachment)) return;
            SlotState* s = h.Slots + slot;
            MixFrom from = s->DeformCount == 0 ? MixFrom.Setup : c.From;
            bool fromSetup = from == MixFrom.Setup;
            s->DeformCount = vertexCount;
            float* d = h.Deform + h.Blob.SlotDeformStart[slot];
            AttachmentBlob current = h.Blob.Attachments[s->Attachment];
            bool weighted = current.BonesStart >= 0;
            float* setup = h.Blob.Vertices + current.VerticesStart;
            float alpha = c.Alpha;
            bool add = c.Add;

            if (v2 == null)
            {
                if (alpha == 1)
                {
                    if (add && !fromSetup)
                    {
                        if (weighted)
                            for (int k = 0; k < vertexCount; k++)
                                d[k] = d[k] + v1[k];
                        else
                            for (int k = 0; k < vertexCount; k++)
                                d[k] = d[k] + (v1[k] - setup[k]);
                    }
                    else
                    {
                        for (int k = 0; k < vertexCount; k++) d[k] = v1[k];
                    }
                }
                else if (fromSetup)
                {
                    if (weighted)
                        for (int k = 0; k < vertexCount; k++)
                            d[k] = v1[k] * alpha;
                    else
                        for (int k = 0; k < vertexCount; k++)
                            d[k] = setup[k] + (v1[k] - setup[k]) * alpha;
                }
                else if (add)
                {
                    if (weighted)
                        for (int k = 0; k < vertexCount; k++)
                            d[k] = d[k] + v1[k] * alpha;
                    else
                        for (int k = 0; k < vertexCount; k++)
                            d[k] = d[k] + (v1[k] - setup[k]) * alpha;
                }
                else
                {
                    for (int k = 0; k < vertexCount; k++) d[k] = d[k] + (v1[k] - d[k]) * alpha;
                }

                return;
            }

            if (alpha == 1)
            {
                if (add && !fromSetup)
                {
                    if (weighted)
                        for (int k = 0; k < vertexCount; k++)
                            d[k] = d[k] + (v1[k] + (v2[k] - v1[k]) * percent);
                    else
                        for (int k = 0; k < vertexCount; k++)
                            d[k] = d[k] + (v1[k] + (v2[k] - v1[k]) * percent - setup[k]);
                }
                else if (percent == 0)
                {
                    for (int k = 0; k < vertexCount; k++) d[k] = v1[k];
                }
                else
                {
                    for (int k = 0; k < vertexCount; k++) d[k] = v1[k] + (v2[k] - v1[k]) * percent;
                }
            }
            else if (fromSetup)
            {
                if (weighted)
                    for (int k = 0; k < vertexCount; k++)
                        d[k] = (v1[k] + (v2[k] - v1[k]) * percent) * alpha;
                else
                    for (int k = 0; k < vertexCount; k++)
                        d[k] = setup[k] + (v1[k] + (v2[k] - v1[k]) * percent - setup[k]) * alpha;
            }
            else if (add)
            {
                if (weighted)
                    for (int k = 0; k < vertexCount; k++)
                        d[k] = d[k] + (v1[k] + (v2[k] - v1[k]) * percent) * alpha;
                else
                    for (int k = 0; k < vertexCount; k++)
                        d[k] = d[k] + (v1[k] + (v2[k] - v1[k]) * percent - setup[k]) * alpha;
            }
            else
            {
                for (int k = 0; k < vertexCount; k++)
                    d[k] = d[k] + (v1[k] + (v2[k] - v1[k]) * percent - d[k]) * alpha;
            }
        }

        // ---------------------------------------------------------------- §3.6 sequence

        private static void Sequence(in InstanceHeader h, TimelineBlob* t, float* frames, in ApplyCommand c)
        {
            if (!TimelineActive(h, t)) return;
            AttachmentBlob keyed = h.Blob.Attachments[t->Attachment];
            if (c.MixOut || c.Time < frames[0])
            {
                if (c.From == MixFrom.Current) return;
                ResetSequence(h, t->Target, t->Attachment);
                for (int k = 0; k < keyed.TimelineSlotsCount; k++)
                    ResetSequence(h, h.Blob.TimelineSlots[keyed.TimelineSlotsStart + k], t->Attachment);

                return;
            }

            int i = Search(frames, t->FrameCount * 3, c.Time, 3);
            float before = frames[i];
            int modeAndIndex = (int)frames[i + 1];
            float delay = frames[i + 2];
            SequenceSlot(h, t->Target, t->Attachment, c.Time, before, modeAndIndex, delay);
            for (int k = 0; k < keyed.TimelineSlotsCount; k++)
                SequenceSlot(h, h.Blob.TimelineSlots[keyed.TimelineSlotsStart + k], t->Attachment, c.Time, before,
                    modeAndIndex, delay);
        }

        private static void ResetSequence(in InstanceHeader h, int slot, int timelineAttachment)
        {
            if (Matches(h, slot, timelineAttachment)) h.Slots[slot].SequenceIndex = -1;
        }

        private static void SequenceSlot(in InstanceHeader h, int slot, int timelineAttachment, float time,
            float before,
            int modeAndIndex, float delay)
        {
            if (!Matches(h, slot, timelineAttachment)) return;
            int index = modeAndIndex >> 4, mode = modeAndIndex & 0xF;
            int count = h.Blob.Attachments[h.Slots[slot].Attachment].FrameCount;
            if (mode != 0)
            {
                index += (int)((time - before) / delay + 0.0001f);
                switch (mode)
                {
                    case 1:
                        index = Math.Min(count - 1, index);
                        break;
                    case 2:
                        index %= count;
                        break;
                    case 3:
                    {
                        int n = (count << 1) - 2;
                        index = n == 0 ? 0 : index % n;
                        if (index >= count) index = n - index;
                        break;
                    }
                    case 4:
                        index = Math.Max(count - 1 - index, 0);
                        break;
                    case 5:
                        index = count - 1 - index % count;
                        break;
                    case 6:
                    {
                        int n = (count << 1) - 2;
                        index = n == 0 ? 0 : (index + count - 1) % n;
                        if (index >= count) index = n - index;
                        break;
                    }
                }
            }

            h.Slots[slot].SequenceIndex = index;
        }

        // ---------------------------------------------------------------- §3.7 draw order

        private static void DrawOrder(in InstanceHeader h, TimelineBlob* t, float* frames, in ApplyCommand c)
        {
            int count = h.Blob.SlotCount;
            if (c.MixOut || c.Time < frames[0])
            {
                if (c.From == MixFrom.Current) return;
                for (int k = 0; k < count; k++) h.DrawOrder[k] = k;
                return;
            }

            int* key = h.Blob.Ints + t->ExtraStart + Search(frames, t->FrameCount, c.Time, 1) * (count + 1);
            int* order = key + 1;
            for (int k = 0; k < count; k++) h.DrawOrder[k] = order[k];
        }

        private static void DrawOrderFolder(in InstanceHeader h, TimelineBlob* t, float* frames, in ApplyCommand c)
        {
            int size = t->ExtraLength;
            int* folder = h.Blob.Ints + t->FolderStart;
            int* order = null;
            if (c.MixOut || c.Time < frames[0])
            {
                if (c.From == MixFrom.Current) return;
            }
            else
            {
                int* key = h.Blob.Ints + t->ExtraStart + Search(frames, t->FrameCount, c.Time, 1) * (size + 1);
                if (key[0] == 0) order = key + 1;
            }

            int found = 0;
            for (int k = 0; k < h.Blob.SlotCount && found < size; k++)
            {
                if (!InFolder(folder, size, h.DrawOrder[k])) continue;
                h.DrawOrder[k] = folder[order == null ? found : order[found]];
                found++;
            }
        }

        private static bool InFolder(int* folder, int size, int slot)
        {
            for (int k = 0; k < size; k++)
                if (folder[k] == slot)
                    return true;

            return false;
        }

        // ---------------------------------------------------------------- §3.8 events

        private static void Events(in InstanceHeader h, TimelineBlob* t, float* frames, float lastTime, float time)
        {
            int count = t->FrameCount;
            if (lastTime > time)
            {
                Events(h, t, frames, lastTime, int.MaxValue);
                lastTime = -1;
            }
            else if (lastTime >= frames[count - 1])
            {
                return;
            }

            if (time < frames[0]) return;
            int k;
            if (lastTime < frames[0])
            {
                k = 0;
            }
            else
            {
                k = Search(frames, count, lastTime, 1) + 1;
                while (k > 0 && frames[k - 1] == frames[k]) k--;
            }

            for (; k < count && time >= frames[k]; k++)
            {
                if (*h.EventCount < h.EventCapacity)
                    h.Events[*h.EventCount] = new FiredEvent { Command = *h.CurrentCommand, Event = t->ExtraStart + k };

                (*h.EventCount)++;
            }
        }

        // ---------------------------------------------------------------- §3.9–3.13 constraints

        private static void Ik(in InstanceHeader h, TimelineBlob* t, float* frames, in ApplyCommand c)
        {
            int index = t->Target;
            if (!h.ConstraintActive[index]) return;
            ConstraintPose* p = h.Constraints + index;
            ConstraintPose setup = h.Blob.ConstraintSetups[index];
            float time = c.Time, alpha = c.Alpha;
            if (time < frames[0])
                switch (c.From)
                {
                    case MixFrom.Setup:
                        p->Mix = setup.Mix;
                        p->Softness = setup.Softness;
                        p->BendDirection = setup.BendDirection;
                        p->Compress = setup.Compress;
                        p->Stretch = setup.Stretch;
                        return;
                    case MixFrom.First:
                        p->Mix = p->Mix + (setup.Mix - p->Mix) * alpha;
                        p->Softness = p->Softness + (setup.Softness - p->Softness) * alpha;
                        p->BendDirection = setup.BendDirection;
                        p->Compress = setup.Compress;
                        p->Stretch = setup.Stretch;
                        return;
                    default:
                        return;
                }

            int i = Search(frames, t->FrameCount * 6, time, 6);
            float mix = Sample(h, t, frames, time, i, 1, 0), softness = Sample(h, t, frames, time, i, 2, 1);
            bool fromSetup = c.From == MixFrom.Setup;
            float baseMix = fromSetup ? setup.Mix : p->Mix, baseSoftness = fromSetup ? setup.Softness : p->Softness;
            p->Mix = baseMix + (mix - baseMix) * alpha;
            p->Softness = baseSoftness + (softness - baseSoftness) * alpha;
            if (c.MixOut)
            {
                if (fromSetup)
                {
                    p->BendDirection = setup.BendDirection;
                    p->Compress = setup.Compress;
                    p->Stretch = setup.Stretch;
                }
            }
            else
            {
                p->BendDirection = (int)frames[i + 3];
                p->Compress = frames[i + 4] != 0;
                p->Stretch = frames[i + 5] != 0;
            }
        }

        // Transform (6 mixes) and path mix (3 mixes).
        private static void Mixes(in InstanceHeader h, TimelineBlob* t, float* frames, in ApplyCommand c)
        {
            int index = t->Target;
            if (!h.ConstraintActive[index]) return;
            ConstraintPose* p = h.Constraints + index;
            ConstraintPose setup = h.Blob.ConstraintSetups[index];
            int count = t->Kind == TimelineKind.Transform ? 6 : 3;
            float* current = &p->MixRotate;
            float* setupMixes = &setup.MixRotate;
            float time = c.Time, alpha = c.Alpha;
            if (time < frames[0])
            {
                if (c.From == MixFrom.Current) return;
                for (int k = 0; k < count; k++)
                    current[k] = c.From == MixFrom.Setup
                        ? setupMixes[k]
                        : current[k] + (setupMixes[k] - current[k]) * alpha;

                return;
            }

            int entries = t->Entries;
            int i = Search(frames, t->FrameCount * entries, time, entries);
            float* sampled = stackalloc float[6];
            for (int k = 0; k < count; k++) sampled[k] = Sample(h, t, frames, time, i, k + 1, k);
            bool fromSetup = c.From == MixFrom.Setup;
            for (int k = 0; k < count; k++)
            {
                float b = fromSetup ? setupMixes[k] : current[k];
                current[k] = c.Add ? b + sampled[k] * alpha : b + (sampled[k] - b) * alpha;
            }
        }

        private static float PhysicsGet(ConstraintPose* p, TimelineKind kind)
        {
            switch (kind)
            {
                case TimelineKind.PhysicsInertia: return p->Inertia;
                case TimelineKind.PhysicsStrength: return p->Strength;
                case TimelineKind.PhysicsDamping: return p->Damping;
                case TimelineKind.PhysicsMass: return 1 / p->MassInverse;
                case TimelineKind.PhysicsWind: return p->Wind;
                case TimelineKind.PhysicsGravity: return p->Gravity;
                default: return p->Mix;
            }
        }

        private static void PhysicsSet(ConstraintPose* p, TimelineKind kind, float value)
        {
            switch (kind)
            {
                case TimelineKind.PhysicsInertia:
                    p->Inertia = value;
                    return;
                case TimelineKind.PhysicsStrength:
                    p->Strength = value;
                    return;
                case TimelineKind.PhysicsDamping:
                    p->Damping = value;
                    return;
                case TimelineKind.PhysicsMass:
                    p->MassInverse = 1 / value;
                    return;
                case TimelineKind.PhysicsWind:
                    p->Wind = value;
                    return;
                case TimelineKind.PhysicsGravity:
                    p->Gravity = value;
                    return;
                default:
                    p->Mix = value;
                    return;
            }
        }

        private static int PhysicsGlobalBit(TimelineKind kind)
        {
            switch (kind)
            {
                case TimelineKind.PhysicsInertia: return PhysicsGlobal.Inertia;
                case TimelineKind.PhysicsStrength: return PhysicsGlobal.Strength;
                case TimelineKind.PhysicsDamping: return PhysicsGlobal.Damping;
                case TimelineKind.PhysicsMass: return PhysicsGlobal.Mass;
                case TimelineKind.PhysicsWind: return PhysicsGlobal.Wind;
                case TimelineKind.PhysicsGravity: return PhysicsGlobal.Gravity;
                default: return PhysicsGlobal.Mix;
            }
        }

        // §3.12
        private static void Physics(in InstanceHeader h, TimelineBlob* t, float* frames, in ApplyCommand c)
        {
            TimelineKind kind = t->Kind;
            bool add = c.Add && (kind == TimelineKind.PhysicsWind || kind == TimelineKind.PhysicsGravity);
            float time = c.Time, alpha = c.Alpha;
            if (t->Target >= 0)
            {
                if (!h.ConstraintActive[t->Target]) return;
                ConstraintPose* p = h.Constraints + t->Target;
                ConstraintPose setup = h.Blob.ConstraintSetups[t->Target];
                float value = Absolute(h, t, frames, time, alpha, c.From, add, PhysicsGet(p, kind),
                    PhysicsGet(&setup, kind));
                PhysicsSet(p, kind, value);
                return;
            }

            float v = time >= frames[0] ? SampleOne(h, t, frames, time) : 0;
            int bit = PhysicsGlobalBit(kind);
            for (int i = 0; i < h.Blob.ConstraintCount; i++)
            {
                ConstraintInfo info = h.Blob.ConstraintInfos[i];
                if (info.Kind != ConstraintKind.Physics || !h.ConstraintActive[i] ||
                    (info.Globals & bit) == 0) continue;

                ConstraintPose* p = h.Constraints + i;
                ConstraintPose setup = h.Blob.ConstraintSetups[i];
                float current = PhysicsGet(p, kind), setupValue = PhysicsGet(&setup, kind);
                float value = time < frames[0]
                    ? BeforeFirst(c.From, alpha, current, setupValue)
                    : Combine(v, alpha, c.From, add, current, setupValue);
                PhysicsSet(p, kind, value);
            }
        }

        private static void PhysicsReset(in InstanceHeader h, TimelineBlob* t, float* frames, float lastTime,
            float time)
        {
            if (t->Target >= 0 && !h.ConstraintActive[t->Target]) return;
            int count = t->FrameCount;
            if (lastTime > time)
            {
                PhysicsReset(h, t, frames, lastTime, int.MaxValue);
                lastTime = -1;
            }
            else if (lastTime >= frames[count - 1])
            {
                return;
            }

            if (time < frames[0]) return;
            if (lastTime < frames[0] || time >= frames[Search(frames, count, lastTime, 1) + 1])
            {
                if (t->Target >= 0)
                {
                    PhysicsSolver.Reset(h.PhysicsStates + t->Target, h.Skeleton->Time);
                    return;
                }

                for (int i = 0; i < h.Blob.ConstraintCount; i++)
                    if (h.Blob.ConstraintInfos[i].Kind == ConstraintKind.Physics && h.ConstraintActive[i])
                        PhysicsSolver.Reset(h.PhysicsStates + i, h.Skeleton->Time);
            }
        }
    }
}