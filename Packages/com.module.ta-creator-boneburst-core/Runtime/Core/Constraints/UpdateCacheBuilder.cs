using System.Collections.Generic;
using BoneBurst.Blob;
using BoneBurst.Data;

namespace BoneBurst.Constraints
{
    /// <summary>
    ///     Builds the update cache for a skin: the order bones and constraints update in (<c>Doc/Format/Constraints.md</c>
    ///     §3, path and physics sorts in <c>Constraints-Path-Physics.md</c> §3.4 and §4.3).
    /// </summary>
    /// <remarks>
    ///     Managed and run only when the skin changes, as the stock <c>UpdateCache</c> is. Every bone gets its applied
    ///     pose copied each world update whether or not a constraint targets it, which gives the same values as the
    ///     stock runtime's per-object constrained poses, so only constraints, slots and the draw order need the
    ///     "constrained" record.
    /// </remarks>
    public static class UpdateCacheBuilder
    {
        public static Result Build(BlobContent content, BoneBurstSkin skin, bool[] boneActive, bool[] constraintActive,
            int[] slotAttachments)
        {
            Builder b = new(content, boneActive);
            Result result = new()
            {
                ConstraintConstrained = new bool[content.ConstraintInfos.Length],
                BoneConstrained = new bool[boneActive.Length]
            };
            for (int i = 0; i < content.ConstraintInfos.Length; i++)
            {
                if (!constraintActive[i]) continue;
                ConstraintBlob d = content.ConstraintDatas[i];
                switch (d.Kind)
                {
                    case ConstraintKind.Ik:
                    {
                        b.SortBone(d.Target);
                        int parent = content.ConstraintBones[d.BonesStart];
                        b.SortBone(parent);
                        b.Cache.Add(~i);
                        b.Sorted[parent] = false;
                        b.SortResetChildren(parent);
                        result.BoneConstrained[parent] = true;
                        if (d.BonesCount > 1) result.BoneConstrained[content.ConstraintBones[d.BonesStart + 1]] = true;
                        break;
                    }
                    case ConstraintKind.Transform:
                    {
                        if (!d.LocalSource) b.SortBone(d.Target);
                        bool worldTarget = !d.LocalTarget;
                        if (worldTarget)
                            for (int k = 0; k < d.BonesCount; k++)
                                b.SortBone(content.ConstraintBones[d.BonesStart + k]);

                        b.Cache.Add(~i);
                        for (int k = 0; k < d.BonesCount; k++)
                            b.SortResetChildren(content.ConstraintBones[d.BonesStart + k]);
                        for (int k = 0; k < d.BonesCount; k++)
                            b.Sorted[content.ConstraintBones[d.BonesStart + k]] = worldTarget;
                        MarkBones(content, d, result.BoneConstrained);
                        break;
                    }
                    case ConstraintKind.Path:
                        SortPathConstraint(content, b, skin, d, slotAttachments);
                        b.Cache.Add(~i);
                        for (int k = 0; k < d.BonesCount; k++)
                            b.SortResetChildren(content.ConstraintBones[d.BonesStart + k]);
                        for (int k = 0; k < d.BonesCount; k++)
                            b.Sorted[content.ConstraintBones[d.BonesStart + k]] = true;
                        MarkBones(content, d, result.BoneConstrained);
                        break;
                    case ConstraintKind.Physics:
                        b.SortBone(d.Target);
                        b.Cache.Add(~i);
                        b.SortResetChildren(d.Target);
                        result.BoneConstrained[d.Target] = true;
                        break;
                    case ConstraintKind.Slider:
                        if (d.Target >= 0 && !d.Local) b.SortBone(d.Target);
                        b.Cache.Add(~i);
                        if (d.Animation >= 0) SortSliderTimelines(content, b, d.Animation, ref result);
                        break;
                }
            }

            for (int i = 0; i < boneActive.Length; i++) b.SortBone(i);
            result.Cache = b.Cache.ToArray();
            return result;
        }

        private static void MarkBones(BlobContent content, in ConstraintBlob d, bool[] constrained)
        {
            for (int k = 0; k < d.BonesCount; k++) constrained[content.ConstraintBones[d.BonesStart + k]] = true;
        }

        private static void SortPathConstraint(BlobContent content, Builder b, BoneBurstSkin skin, in ConstraintBlob d,
            int[] slotAttachments)
        {
            int slot = d.Target, slotBone = content.SlotSetups[slot].Bone;
            if (skin != null) SortPathSkin(content, b, skin, slot, slotBone);
            if (content.DefaultSkin != null && content.DefaultSkin != skin)
                SortPathSkin(content, b, content.DefaultSkin, slot, slotBone);

            SortPath(content, b, slotAttachments[slot], slotBone);
            for (int k = 0; k < d.BonesCount; k++) b.SortBone(content.ConstraintBones[d.BonesStart + k]);
        }

        private static void SortPathSkin(BlobContent content, Builder b, BoneBurstSkin skin, int slot, int slotBone)
        {
            foreach ((int entrySlot, string _, int attachment) in skin.Entries())
                if (entrySlot == slot)
                    SortPath(content, b, attachment, slotBone);
        }

        private static void SortPath(BlobContent content, Builder b, int attachment, int slotBone)
        {
            if (attachment < 0) return;
            AttachmentBlob a = content.Attachments[attachment];
            if (a.Kind != AttachmentKind.Path) return;
            if (a.BonesStart < 0)
            {
                b.SortBone(slotBone);
                return;
            }

            int i = a.BonesStart;
            for (int v = 0; v < a.VertexCount; v++)
            {
                int n = content.Bones[i++];
                for (int end = i + n; i < end; i++) b.SortBone(content.Bones[i]);
            }
        }

        private static void SortSliderTimelines(BlobContent content, Builder b, int animation, ref Result result)
        {
            AnimationBlob anim = content.Animations[animation];
            for (int t = anim.TimelineStart; t < anim.TimelineStart + anim.TimelineCount; t++)
            {
                TimelineBlob tb = content.Timelines[t];
                switch (tb.Kind)
                {
                    case >= TimelineKind.BoneRotate and <= TimelineKind.BoneInherit:
                        b.Sorted[tb.Target] = false;
                        b.SortResetChildren(tb.Target);
                        result.BoneConstrained[tb.Target] = true;
                        break;
                    case <= TimelineKind.SlotAlpha:
                    case TimelineKind.Deform:
                    case TimelineKind.Sequence:
                    case TimelineKind.DrawOrder:
                    case TimelineKind.DrawOrderFolder:
                        result.SlotsConstrained = true;
                        break;
                    case TimelineKind.Event:
                        break;
                    default:
                        if (tb.Target >= 0)
                        {
                            result.ConstraintConstrained[tb.Target] = true;
                            break;
                        }

                        // "Every physics constraint" timelines. A reset timeline here throws in the stock runtime
                        // (Constraints.md §12 item 2); it is treated like the property timelines instead.
                        for (int c = 0; c < content.ConstraintInfos.Length; c++)
                            if (content.ConstraintInfos[c].Kind == ConstraintKind.Physics)
                                result.ConstraintConstrained[c] = true;

                        break;
                }
            }
        }

        public struct Result
        {
            /// <summary>
            ///     A bone index (≥ 0), or <c>~constraint</c> (&lt; 0), in update order. Bones may repeat.
            /// </summary>
            public int[] Cache;

            /// <summary>
            ///     Per constraint: an active slider keys it.
            /// </summary>
            public bool[] ConstraintConstrained;

            /// <summary>
            ///     An active slider keys a slot or the draw order.
            /// </summary>
            public bool SlotsConstrained;

            /// <summary>
            ///     Per bone: an active constraint or slider constrains it, so its applied pose is its constrained pose
            ///     object, which keeps its own world transform (Constraints.md §2.3).
            /// </summary>
            public bool[] BoneConstrained;
        }

        private sealed class Builder
        {
            public readonly List<int> Cache = new();
            public readonly bool[] Sorted;
            private readonly bool[] m_Active;
            private readonly BoneSetup[] m_Bones;
            private readonly int[] m_Children;

            public Builder(BlobContent content, bool[] boneActive)
            {
                m_Bones = content.BoneSetups;
                m_Children = content.BoneChildren;
                m_Active = boneActive;
                Sorted = new bool[boneActive.Length];
                // Stock: sorted = skinRequired, then cleared for the skin's bones and their ancestors; which is
                // exactly the inactive set.
                for (int i = 0; i < Sorted.Length; i++) Sorted[i] = !boneActive[i];
            }

            public void SortBone(int bone)
            {
                if (bone < 0 || Sorted[bone] || !m_Active[bone]) return;
                int parent = m_Bones[bone].Parent;
                if (parent >= 0) SortBone(parent);
                Sorted[bone] = true;
                Cache.Add(bone);
            }

            /// <summary>
            ///     <c>SortReset(bone.children)</c>.
            /// </summary>
            public void SortResetChildren(int bone)
            {
                BoneSetup s = m_Bones[bone];
                for (int k = s.ChildStart; k < s.ChildStart + s.ChildCount; k++)
                {
                    int child = m_Children[k];
                    if (!m_Active[child]) continue;
                    if (Sorted[child]) SortResetChildren(child);
                    Sorted[child] = false;
                }
            }
        }
    }
}