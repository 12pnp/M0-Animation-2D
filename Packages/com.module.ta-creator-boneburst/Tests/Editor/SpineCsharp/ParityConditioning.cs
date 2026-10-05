using System;
using System.Collections.Generic;
using BoneBurst.Data;
using Spine;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     Finds the bones whose pose is ill-conditioned this frame, so tolerance mode compares them with a wider
    ///     bound (<c>Doc/Review/BoneBurst-ImprovePlan.md</c>, I1).
    /// </summary>
    /// <remarks>
    ///     <para>
    ///         A two-bone IK whose target is out of reach, or whose chain is nearly straight, amplifies the rounding of
    ///         its inputs: the bend is <c>acos(cos)</c>, whose sensitivity <c>1 / sqrt(1 − cos²)</c> is unbounded at
    ///         <c>|cos| = 1</c>, and with non-uniform scale the solver takes a quadratic whose discriminant is then
    ///         near zero. Measured (mix-and-match-pro @0.01, foot-back): ulp-level error on every frame with
    ///         <c>|cos| &lt; 1</c>, 2e-4 on exactly the frames with <c>cos &gt; 1</c>.
    ///     </para>
    ///     <para>
    ///         The chain's bones, their descendants and every bone a constraint drives from them get
    ///         <see cref="Factor" /> × the tolerance for that frame only.
    ///         The strict-float harness still compares them exactly.
    ///     </para>
    /// </remarks>
    internal static class ParityConditioning
    {
        /// <summary>
        ///     Tolerance multiplier for a marked bone. Out of reach, the solver also picks between two candidate
        ///     solutions by distance, a choice that is itself ill-conditioned near the midpoint, so the reference is not
        ///     a stable function of its inputs there. Measured in that regime: 23.6 × (mix-and-match-pro @0.01) and
        ///     149 × (raptor 'Jump', rear_arm_goal) the base tolerance; 1000 × bounds it at about 1 % while still
        ///     failing a gross error. Exactness is the strict-float harness's job.
        /// </summary>
        public const double Factor = 1000;

        /// <summary>
        ///     How close to straight counts as ill-conditioned: <c>1 − |cos| &lt; 1e-3</c>, where the bend's sensitivity
        ///     exceeds ~22 ×.
        /// </summary>
        private const double NearStraight = 1e-3;

        private static readonly HashSet<string> s_Marked = new();

        /// <summary>
        ///     Marks this frame's ill-conditioned bones from the stock skeleton (after its world update).
        /// </summary>
        public static void Mark(Skeleton skeleton, SkeletonDef def)
        {
            s_Marked.Clear();
            if (!ParityDrift.Tolerant) return;
            bool[] marked = null;
            for (int i = 0; i < def.Constraints.Length; i++)
            {
                if (!(def.Constraints[i] is IkDef ik) || ik.Bones.Length != 2) continue;
                BonePose p = skeleton.Bones.Items[ik.Bones[0]].AppliedPose;
                BonePose c = skeleton.Bones.Items[ik.Bones[1]].AppliedPose;
                BonePose t = skeleton.Bones.Items[ik.Target].AppliedPose;
                double l1 = Distance(c.WorldX - p.WorldX, c.WorldY - p.WorldY);
                double l2 = def.Bones[ik.Bones[1]].Length * Distance(c.A, c.C);
                if (l1 <= 0 || l2 <= 0) continue;
                double d = Distance(t.WorldX - p.WorldX, t.WorldY - p.WorldY);
                double cos = (d * d - l1 * l1 - l2 * l2) / (2 * l1 * l2);
                if (1 - Math.Abs(cos) >= NearStraight) continue;
                marked ??= new bool[def.Bones.Length];
                marked[ik.Bones[0]] = marked[ik.Bones[1]] = true;
            }

            if (marked == null) return;

            // Spread to everything the marked bones feed: children, and bones driven by a constraint that reads a
            // marked bone (a transform source, an IK target, a path's slot bone or vertex weights), until nothing changes.
            for (bool changed = true; changed;)
            {
                changed = false;
                for (int i = 0; i < def.Bones.Length; i++)
                {
                    int parent = def.Bones[i].Parent;
                    if (parent >= 0 && marked[parent] && !marked[i]) changed = marked[i] = true;
                }

                foreach (ConstraintDef constraint in def.Constraints)
                {
                    int[] bones;
                    bool reads;
                    switch (constraint)
                    {
                        case TransformDef t:
                            bones = t.Bones;
                            reads = marked[t.Source];
                            break;
                        case IkDef k:
                            bones = k.Bones;
                            reads = marked[k.Target];
                            break;
                        case PathConstraintDef pa:
                            bones = pa.Bones;
                            reads = marked[def.Slots[pa.Slot].Bone] || ReadsMarkedWeights(def, pa.Slot, marked);
                            break;
                        default:
                            continue;
                    }

                    if (!reads) continue;
                    foreach (int bone in bones)
                        if (!marked[bone])
                            changed = marked[bone] = true;
                }
            }

            for (int i = 0; i < def.Bones.Length; i++)
                if (marked[i])
                    s_Marked.Add(def.Bones[i].Name);
        }

        /// <summary>
        ///     A path follows its attachment's vertices, which can be weighted to other bones (mix-and-match-pro's
        ///     leg paths are weighted to the IK leg): true when any path attachment of the slot, in any skin, is
        ///     weighted to a marked bone.
        /// </summary>
        private static bool ReadsMarkedWeights(SkeletonDef def, int slot, bool[] marked)
        {
            foreach (SkinDef skin in def.Skins)
            foreach (SkinEntry entry in skin.Entries)
            {
                if (entry.Slot != slot || !(entry.Attachment is PathAttachmentDef path) || path.Bones == null) continue;
                // Weighted vertices: an influence count, then that many bone indices, per vertex.
                for (int i = 0; i < path.Bones.Length;)
                {
                    int n = path.Bones[i++];
                    for (int end = i + n; i < end; i++)
                        if (marked[path.Bones[i]])
                            return true;
                }
            }

            return false;
        }

        /// <summary>
        ///     The tolerance multiplier for a bone this frame: <see cref="Factor" /> when marked, else 1.
        /// </summary>
        public static double FactorFor(string bone)
        {
            return s_Marked.Count > 0 && s_Marked.Contains(bone) ? Factor : 1;
        }

        private static double Distance(double x, double y)
        {
            return Math.Sqrt(x * x + y * y);
        }
    }
}