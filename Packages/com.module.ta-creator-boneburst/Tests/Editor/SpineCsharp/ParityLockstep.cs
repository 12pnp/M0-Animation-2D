using System.Collections.Generic;
using BoneBurst.Anim;
using BoneBurst.Constraints;
using BoneBurst.Data;
using BoneBurst.Instance;
using Spine;
using Unity.Mathematics;
using UnityEngine;
using Inherit = BoneBurst.Data.Inherit;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     Keeps a stock skeleton and a <see cref="ManagedPose" /> on the same inputs frame after frame, so a tolerance
    ///     compares one frame of rounding, never many compounded (<c>Doc/Review/BoneBurst-ParityPlan.md</c>, F3).
    /// </summary>
    /// <remarks>
    ///     <para>
    ///         Under Unity's Mono the two runtimes round differently (F1, F2). Physics, IK and slider feedback carry the
    ///         difference into the next frame and amplify it: 0.8 world units after 60 frames, which no tolerance can
    ///         tell from a bug. After a frame has been compared, <see cref="CompareAndSync" /> first compares the state
    ///         that frame hands to the next (physics, the worlds of inactive bones), then copies stock's carried state
    ///         into BoneBurst: local and applied bone poses, bone worlds, constraint poses, slot colours, physics.
    ///     </para>
    ///     <para>
    ///         Comparing the carried state before overwriting it matters: a bug that stores a wrong velocity but draws
    ///         this frame correctly would otherwise be hidden by the copy. In the strict-float harness the copy writes
    ///         identical values, so lockstep changes nothing there.
    ///     </para>
    /// </remarks>
    internal static class ParityLockstep
    {
        private static readonly string[] s_PhysicsFields =
        {
            "ux", "uy", "cx", "cy", "tx", "ty", "xOffset", "xLag", "xVelocity", "yOffset", "yLag", "yVelocity",
            "rotateOffset", "rotateLag", "rotateVelocity", "scaleOffset", "scaleLag", "scaleVelocity", "remaining",
            "lastTime"
        };

        /// <summary>
        ///     Compares the physics state with stock's (a failure is added to <paramref name="failures" />), then syncs
        ///     every carried value from stock.
        /// </summary>
        public static void CompareAndSync(string at, Skeleton skeleton, ManagedPose m, List<string> failures)
        {
            // The pose's own model: the animation suite's no-constraints runs use a copy without constraints.
            SkeletonDef def = m.Content.Skeleton;
            for (int i = 0; i < def.Constraints.Length; i++)
            {
                object constraint = skeleton.Constraints.Items[i];
                if (def.Constraints[i].Kind == ConstraintKind.Physics)
                {
                    float[] stock = AnimationParityTests.Floats(constraint, s_PhysicsFields);
                    bool reset = (bool)AnimationParityTests.Member(constraint, "reset");
                    ref PhysicsState s = ref m.PhysicsStates[i];
                    float[] mine =
                    {
                        s.Ux, s.Uy, s.Cx, s.Cy, s.Tx, s.Ty, s.XOffset, s.XLag, s.XVelocity, s.YOffset, s.YLag,
                        s.YVelocity, s.RotateOffset, s.RotateLag, s.RotateVelocity, s.ScaleOffset, s.ScaleLag,
                        s.ScaleVelocity, s.Remaining, s.LastTime
                    };
                    if (!(AnimationParityTests.SameAll("physics.state", at, stock, mine) &
                          ParityDrift.Same("discrete.physics", at, reset == s.Reset)))
                        failures.Add($"{at}: constraint {def.Constraints[i].Name} physics state differs");

                    s.Ux = stock[0];
                    s.Uy = stock[1];
                    s.Cx = stock[2];
                    s.Cy = stock[3];
                    s.Tx = stock[4];
                    s.Ty = stock[5];
                    s.XOffset = stock[6];
                    s.XLag = stock[7];
                    s.XVelocity = stock[8];
                    s.YOffset = stock[9];
                    s.YLag = stock[10];
                    s.YVelocity = stock[11];
                    s.RotateOffset = stock[12];
                    s.RotateLag = stock[13];
                    s.RotateVelocity = stock[14];
                    s.ScaleOffset = stock[15];
                    s.ScaleLag = stock[16];
                    s.ScaleVelocity = stock[17];
                    s.Remaining = stock[18];
                    s.LastTime = stock[19];
                    s.Reset = reset;
                }

                SyncConstraintPose(AnimationParityTests.Member(constraint, "Pose"), def.Constraints[i].Kind,
                    ref m.Constraints[i]);
                SyncConstraintPose(AnimationParityTests.Member(constraint, "AppliedPose"), def.Constraints[i].Kind,
                    ref m.AppliedConstraints[i]);
            }

            for (int i = 0; i < def.Bones.Length; i++)
            {
                Bone bone = skeleton.Bones.Items[i];

                // An inactive bone is not posed from its locals, but constraints can still move its world (physics,
                // paths), and its active children read it next frame: carried state, compared here because the
                // suites compare active bones only (parity plan I1: gaps.json bone b).
                if ((!bone.Active || !m.BoneActive[i]) &&
                    !AnimationParityTests.SameWorld(at + " inactive", def.Bones[i].Name, bone.AppliedPose, m.World[i]))
                    failures.Add($"{at}: inactive bone {def.Bones[i].Name} world differs");

                m.World[i] = World(bone.AppliedPose);
                if (!ReferenceEquals(bone.Pose, bone.AppliedPose)) m.OtherWorld[i] = World(bone.Pose);
                m.Local[i] = Local(skeleton.Bones.Items[i].Pose);

                // The applied pose can outlive its frame (stale after a world-mode constraint), and local or additive
                // constraints read it next frame, so it is carried state too.
                m.Applied[i] = Local(skeleton.Bones.Items[i].AppliedPose);
            }

            for (int i = 0; i < def.Slots.Length; i++)
            {
                SlotPose p = skeleton.Slots.Items[i].Pose;
                Color color = p.GetColor();
                m.Slots[i].Color = new float4(color.r, color.g, color.b, color.a);
                Color? dark = p.GetDarkColor();
                if (dark.HasValue) m.Slots[i].DarkColor = new float3(dark.Value.r, dark.Value.g, dark.Value.b);
            }

            ParityDrift.EndFrame();
        }

        private static BoneWorld World(BonePose p)
        {
            return new BoneWorld { A = p.A, B = p.B, C = p.C, D = p.D, X = p.WorldX, Y = p.WorldY };
        }

        private static BoneLocal Local(BonePose p)
        {
            return new BoneLocal
            {
                X = p.X, Y = p.Y, Rotation = p.Rotation, ScaleX = p.ScaleX, ScaleY = p.ScaleY, ShearX = p.ShearX,
                ShearY = p.ShearY, Inherit = (Inherit)(int)p.Inherit
            };
        }

        private static void SyncConstraintPose(object pose, ConstraintKind kind, ref ConstraintPose mine)
        {
            switch (kind)
            {
                case ConstraintKind.Ik:
                {
                    float[] v = AnimationParityTests.Floats(pose, "Mix", "Softness", "BendDirection", "Compress",
                        "Stretch");
                    mine.Mix = v[0];
                    mine.Softness = v[1];
                    mine.BendDirection = (int)v[2];
                    mine.Compress = v[3] != 0;
                    mine.Stretch = v[4] != 0;
                    break;
                }
                case ConstraintKind.Transform:
                {
                    float[] v = AnimationParityTests.Floats(pose, "MixRotate", "MixX", "MixY", "MixScaleX", "MixScaleY",
                        "MixShearY");
                    mine.MixRotate = v[0];
                    mine.MixX = v[1];
                    mine.MixY = v[2];
                    mine.MixScaleX = v[3];
                    mine.MixScaleY = v[4];
                    mine.MixShearY = v[5];
                    break;
                }
                case ConstraintKind.Path:
                {
                    float[] v = AnimationParityTests.Floats(pose, "Position", "Spacing", "MixRotate", "MixX", "MixY");
                    mine.Position = v[0];
                    mine.Spacing = v[1];
                    mine.MixRotate = v[2];
                    mine.MixX = v[3];
                    mine.MixY = v[4];
                    break;
                }
                case ConstraintKind.Physics:
                {
                    float[] v = AnimationParityTests.Floats(pose, "Inertia", "Strength", "Damping", "MassInverse",
                        "Wind", "Gravity", "Mix");
                    mine.Inertia = v[0];
                    mine.Strength = v[1];
                    mine.Damping = v[2];
                    mine.MassInverse = v[3];
                    mine.Wind = v[4];
                    mine.Gravity = v[5];
                    mine.Mix = v[6];
                    break;
                }
                default:
                {
                    float[] v = AnimationParityTests.Floats(pose, "Time", "Mix");
                    mine.Time = v[0];
                    mine.Mix = v[1];
                    break;
                }
            }
        }
    }
}