using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using BoneBurst.Anim;
using BoneBurst.Blob;
using BoneBurst.Constraints;
using BoneBurst.Data;
using BoneBurst.Instance;
using NUnit.Framework;
using Spine;
using UnityEngine;
using AnimationState = Spine.AnimationState;
using Physics = Spine.Physics;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     P5 parity: every animation of every corpus file with constraints and physics solved, stock
    ///     <c>Skeleton.UpdateWorldTransform</c> against <see cref="SkeletonUpdate" />, frame by frame.
    /// </summary>
    /// <remarks>
    ///     Both sides run spine-unity's frame (<c>state.Update</c>, <c>skeleton.Update</c>, <c>state.Apply</c>,
    ///     <c>UpdateWorldTransform</c>) after one initial world update at time 0, as spine-unity initialises. The
    ///     script also moves and rotates the skeleton for physics (<c>PhysicsTranslate</c> / <c>PhysicsRotate</c>) and
    ///     cycles the physics mode through Update, Pose, Reset and None. Runs use unflipped, flipped-X and
    ///     non-uniform negative skeleton scales. Compared after every frame: bone poses and applied poses, world
    ///     transforms, constraint poses and applied poses, applied slots and draw order, and spine-unity's mesh.
    /// </remarks>
    public class ConstraintParityTests
    {
        private static readonly float[] s_Deltas =
            { 0.016666668f, 0.033333335f, 0.007f, 0.1f, 0.016666668f, 0.25f, 0.016666668f, 0.016666668f };

        private static IEnumerable<SampleCorpus.Case> Corpus()
        {
            return SampleCorpus.Corpus().Where(c => c.Scale != 0.37f || c.Skeleton.Contains("constraints"));
        }

        [TestCaseSource(nameof(Corpus))]
        public void Constraints_MatchStock(SampleCorpus.Case c)
        {
            SkeletonDef def = c.Skeleton.EndsWith(".json")
                ? SkeletonJsonReader.Read(File.ReadAllText(c.Skeleton), c.Scale)
                : SkeletonBinaryReader.Read(File.ReadAllBytes(c.Skeleton), c.Scale);
            ParityDrift.BeginCase(ParityDrift.SizeOf(def, c.Scale));
            BlobContent content = BlobBuilder.BuildContent(def, AtlasReader.Read(File.ReadAllText(c.Atlas)));
            Assert.That(def.Animations.Length, Is.GreaterThan(0), "no animations to compare");

            List<int> skins = new() { -1 };
            skins.AddRange(Enumerable.Range(0, def.Skins.Length).Where(s => def.Skins[s] != def.DefaultSkin).Take(2));
            (bool loop, float sx, float sy)[] variants =
                { (true, 1, 1), (false, 1, 1), (true, -1, 1), (true, 1, -1.5f) };
            List<string> failures = new();
            int frames = 0;
            for (int a = 0; a < def.Animations.Length && failures.Count == 0; a++)
                foreach (int skin in skins)
                foreach ((bool loop, float sx, float sy) in variants)
                {
                    frames += Play(c, def, content, a, skin, loop, sx, sy, failures);
                    if (failures.Count > 0) break;
                }

            Assert.That(frames, Is.GreaterThan(0), "nothing was played");
            ParityDrift.CheckFrames(failures);
            ParityDrift.WriteCaseSummary();
            Assert.IsEmpty(failures, string.Join("\n", failures.Take(30)));
        }

        private static int Play(SampleCorpus.Case c, SkeletonDef def, BlobContent content, int animation, int skin,
            bool loop, float sx, float sy, List<string> failures)
        {
            SkeletonData data = AnimationParityTests.LoadStock(c, true);
            Skeleton skeleton = new(data);
            if (skin >= 0) skeleton.SetSkin(def.Skins[skin].Name);
            skeleton.ScaleX = sx;
            skeleton.ScaleY = sy;
            AnimationState state = new(new AnimationStateData(data));
            List<string> stockEvents = new(), myEvents = new();
            state.Event += (entry, e) => stockEvents.Add($"{e.Data.Name}@{e.Time:R}");
            state.Complete += entry => stockEvents.Add("complete");

            using ManagedPose mine = new(content, skin)
            {
                ScaleX = sx, ScaleY = sy, LinearColorSpace = QualitySettings.activeColorSpace == ColorSpace.Linear
            };
            BoneAnimationState track = new(new BoneAnimationStateData(content));
            CommandBuffer buffer = new();
            track.Event += (_, e) => myEvents.Add($"{e.Name}@{e.Time:R}");
            track.Complete += _ => myEvents.Add("complete");
            string at = $"'{def.Animations[animation].Name}' skin {(skin < 0 ? "-" : def.Skins[skin].Name)} " +
                        $"{(loop ? "loop" : "once")} scale {sx},{sy}";

            skeleton.UpdateWorldTransform(Physics.Update);
            mine.UpdateWorldTransform(PhysicsMode.Update);
            Compare($"{at} init", skeleton, mine, def, failures);
            if (failures.Count > 0) return 1;

            state.SetAnimation(0, data.Animations.Items[animation], loop);
            track.SetAnimation(0, animation, loop);
            int other = (animation + 1) % def.Animations.Length;
            float duration = Math.Max(def.Animations[animation].Duration, 0.5f), total = 0;
            int frame = 0;
            for (; total <= duration * 2.3f && frame < 300; frame++)
            {
                float dt = s_Deltas[frame % s_Deltas.Length];
                total += dt;
                if (frame == 23 && def.Animations.Length > 1)
                {
                    state.SetAnimation(0, data.Animations.Items[other], loop);
                    track.SetAnimation(0, other, loop);
                }

                state.Update(dt);
                skeleton.Update(dt);
                track.Update(dt);
                mine.Time += dt;
                if (frame % 7 == 3)
                {
                    float mx = (frame % 3 - 1) * 13.5f * c.Scale, my = (frame % 5 - 2) * 7.25f * c.Scale;
                    skeleton.PhysicsTranslate(mx, my);
                    mine.PhysicsTranslate(mx, my);
                }

                if (frame % 11 == 5)
                {
                    float degrees = frame % 2 == 0 ? 12.5f : -30;
                    skeleton.PhysicsRotate(0, 0, degrees);
                    mine.PhysicsRotate(0, 0, degrees);
                }

                Physics physics = frame % 17 == 9 ? Physics.Pose
                    : frame % 29 == 20 ? Physics.Reset
                    : frame % 37 == 30 ? Physics.None
                    : Physics.Update;
                state.Apply(skeleton);
                skeleton.UpdateWorldTransform(physics);
                track.Apply(buffer);
                mine.Pose(buffer, (PhysicsMode)(int)physics);
                track.AfterApply(buffer, mine.FiredEvents(), mine.TotalAlpha, mine.Rotation);

                Compare($"{at} frame {frame}", skeleton, mine, def, failures);
                ParityLockstep.CompareAndSync($"{at} frame {frame}", skeleton, mine, failures);
                if (failures.Count > 0) return frame + 1;
            }

            if (!ParityDrift.Same("discrete.events", at, stockEvents.SequenceEqual(myEvents)))
                failures.Add(
                    $"{at}: events differ\n  stock {string.Join(", ", stockEvents)}\n  new   {string.Join(", ", myEvents)}");

            return frame;
        }

        private static void Compare(string at, Skeleton skeleton, ManagedPose m, SkeletonDef def, List<string> failures)
        {
            ParityConditioning.Mark(skeleton, m.Content.Skeleton);
            int update = (int)AnimationParityTests.Member(skeleton, "update");
            for (int i = 0; i < def.Bones.Length; i++)
            {
                Bone bone = skeleton.Bones.Items[i];
                if (!AnimationParityTests.SameLocal("local", at, bone.Pose, m.Local[i]))
                {
                    failures.Add($"{at}: bone {def.Bones[i].Name} pose differs");
                    return;
                }

                if (!bone.Active) continue;
                BonePose p = bone.AppliedPose;
                BoneWorld w = m.World[i];
                if (!AnimationParityTests.SameWorld(at, def.Bones[i].Name, p, w))
                {
                    failures.Add($"{at}: bone {def.Bones[i].Name} world differs");
                    return;
                }

                // Applied locals are stale by design after a world-mode constraint (local == update).
                if (!ReferenceEquals(bone.Pose, p) && (int)AnimationParityTests.Member(p, "local") != update &&
                    !(ParityDrift.Tolerant
                        ? AnimationParityTests.SameLocalMatrix(at, def.Bones[i].Name, p, m.Applied[i])
                        : AnimationParityTests.SameLocal("applied", at, p, m.Applied[i])))
                {
                    failures.Add($"{at}: bone {def.Bones[i].Name} applied pose differs");
                    return;
                }
            }

            for (int i = 0; i < def.Constraints.Length; i++)
            {
                object constraint = skeleton.Constraints.Items[i];
                ConstraintKind kind = def.Constraints[i].Kind;
                if (!(AnimationParityTests.SameAll("constraint", at,
                          Pose(AnimationParityTests.Member(constraint, "Pose"), kind),
                          Pose(m.Constraints[i], kind)) &
                      AnimationParityTests.SameAll("constraint", at,
                          Pose(AnimationParityTests.Member(constraint, "AppliedPose"), kind),
                          Pose(m.AppliedConstraints[i], kind))))
                {
                    failures.Add($"{at}: constraint {def.Constraints[i].Name} pose differs");
                    return;
                }
            }

            for (int i = 0; i < def.Slots.Length; i++)
            {
                SlotPose p = skeleton.Slots.Items[i].AppliedPose;
                SlotState s = m.AppliedSlots[i];
                Color color = p.GetColor();
                string mineName = s.Attachment < 0 ? null : m.Content.AttachmentDefs[s.Attachment].Name;
                if (!(ParityDrift.Same("slot.color", at, color.r, s.Color.x) &
                      ParityDrift.Same("slot.color", at, color.g, s.Color.y) &
                      ParityDrift.Same("slot.color", at, color.b, s.Color.z) &
                      ParityDrift.Same("slot.color", at, color.a, s.Color.w) &
                      ParityDrift.Same("discrete.attachment", at, p.Attachment?.Name == mineName)))
                {
                    failures.Add($"{at}: applied slot {def.Slots[i].Name} differs");
                    return;
                }
            }

            ExposedList<Slot> order = skeleton.DrawOrder.AppliedPose;
            for (int i = 0; i < order.Count; i++)
                if (!ParityDrift.Same("discrete.draworder", at, order.Items[i].Data.Index == m.AppliedDrawOrder[i]))
                {
                    failures.Add($"{at}: applied draw order differs at {i}");
                    return;
                }

            AnimationParityTests.CompareWorldAndMesh(at, skeleton, m, def, failures);
        }

        private static float[] Pose(object pose, ConstraintKind kind)
        {
            switch (kind)
            {
                case ConstraintKind.Ik:
                    return AnimationParityTests.Floats(pose, "Mix", "Softness", "BendDirection", "Compress", "Stretch");
                case ConstraintKind.Transform:
                    return AnimationParityTests.Floats(pose, "MixRotate", "MixX", "MixY", "MixScaleX", "MixScaleY",
                        "MixShearY");
                case ConstraintKind.Path:
                    return AnimationParityTests.Floats(pose, "Position", "Spacing", "MixRotate", "MixX", "MixY");
                case ConstraintKind.Physics:
                    return AnimationParityTests.Floats(pose, "Inertia", "Strength", "Damping", "MassInverse", "Wind",
                        "Gravity", "Mix");
                default:
                    return AnimationParityTests.Floats(pose, "Time", "Mix");
            }
        }

        private static float[] Pose(ConstraintPose p, ConstraintKind kind)
        {
            switch (kind)
            {
                case ConstraintKind.Ik:
                    return new[] { p.Mix, p.Softness, p.BendDirection, p.Compress ? 1f : 0, p.Stretch ? 1f : 0 };
                case ConstraintKind.Transform:
                    return new[] { p.MixRotate, p.MixX, p.MixY, p.MixScaleX, p.MixScaleY, p.MixShearY };
                case ConstraintKind.Path:
                    return new[] { p.Position, p.Spacing, p.MixRotate, p.MixX, p.MixY };
                case ConstraintKind.Physics:
                    return new[] { p.Inertia, p.Strength, p.Damping, p.MassInverse, p.Wind, p.Gravity, p.Mix };
                default:
                    return new[] { p.Time, p.Mix };
            }
        }
    }
}