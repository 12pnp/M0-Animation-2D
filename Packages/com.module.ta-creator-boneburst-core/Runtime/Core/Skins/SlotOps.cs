using System;
using BoneBurst.Blob;
using BoneBurst.Data;
using BoneBurst.Instance;

namespace BoneBurst
{
    /// <summary>
    ///     Main-thread slot edits with the stock rules: the attachment setter, <c>Skeleton.SetSkin</c> and
    ///     <c>SetupPoseSlots</c> (<c>Doc/Format/Skins-TintBlack-Culling.md</c> §1.5–1.8).
    /// </summary>
    /// <remarks>
    ///     Span-based, so <see cref="InstanceData" /> (native arrays) and <see cref="ManagedPose" /> (managed arrays)
    ///     share one implementation. The spans are the unconstrained slot pose.
    /// </remarks>
    public static class SlotOps
    {
        /// <summary>
        ///     The <c>SlotPose.Attachment</c> setter: no change does nothing; otherwise deform clears unless both
        ///     are vertex attachments with the same timeline attachment, and the sequence index resets to -1.
        /// </summary>
        public static void SetAttachment(BlobContent content, Span<SlotState> slots, Span<float> deform, int slot,
            int attachment)
        {
            SlotState state = slots[slot];
            int old = state.Attachment;
            if (old == attachment) return;
            bool keepDeform = old >= 0 && attachment >= 0 && IsVertex(content.Attachments[old].Kind) &&
                              IsVertex(content.Attachments[attachment].Kind) &&
                              content.Attachments[old].TimelineAttachment ==
                              content.Attachments[attachment].TimelineAttachment;
            if (!keepDeform)
            {
                ClearDeform(content, slots, deform, slot);
                state = slots[slot];
            }

            state.Attachment = attachment;
            state.SequenceIndex = -1;
            slots[slot] = state;
        }

        /// <summary>
        ///     <c>Skeleton.SetSkin(newSkin)</c>'s attachment changes (§1.6). The caller refreshes activation and
        ///     the update cache afterwards, which the stock call does unless the skin is unchanged.
        /// </summary>
        /// <returns>False when <paramref name="newSkin" /> is the current skin: nothing changes, no refresh.</returns>
        public static bool SetSkin(BlobContent content, Span<SlotState> slots, Span<float> deform,
            BoneBurstSkin current, BoneBurstSkin newSkin)
        {
            if (newSkin == current) return false;
            if (newSkin == null) return true;
            if (current != null)
            {
                // AttachAll: only slots showing the old skin's entry switch, each compared to the slot's value as
                // earlier entries left it.
                foreach ((int slot, string placeholder, int attachment) in current.Entries())
                {
                    if (slots[slot].Attachment != attachment) continue;
                    int replacement = newSkin.GetAttachment(slot, placeholder);
                    if (replacement >= 0) SetAttachment(content, slots, deform, slot, replacement);
                }

                return true;
            }

            for (int i = 0; i < slots.Length; i++)
            {
                string name = content.SetupAttachmentNames[i];
                if (name == null) continue;
                int attachment = newSkin.GetAttachment(i, name);
                if (attachment >= 0) SetAttachment(content, slots, deform, i, attachment);
            }

            return true;
        }

        /// <summary>
        ///     <c>Skeleton.SetupPoseSlots</c> (§1.8): setup draw order, then each slot's colour, dark colour,
        ///     sequence index and setup attachment (current skin, then the default skin), with stock's edge states.
        /// </summary>
        public static void SetupPoseSlots(BlobContent content, Span<SlotState> slots, Span<int> drawOrder,
            Span<float> deform, BoneBurstSkin skin)
        {
            for (int i = 0; i < drawOrder.Length; i++) drawOrder[i] = i;
            for (int i = 0; i < slots.Length; i++)
            {
                SlotSetup setup = content.SlotSetups[i];
                SlotState state = slots[i];
                state.Color = setup.Color;
                if (state.HasDarkColor) state.DarkColor = setup.DarkColor;
                state.SequenceIndex = 0;
                string name = content.SetupAttachmentNames[i];
                if (name != null)
                    // A raw null write, then the setter: a found attachment always counts as a change.
                    state.Attachment = -1;

                slots[i] = state;
                SetAttachment(content, slots, deform, i, content.ResolveAttachment(skin, i, name));
            }
        }

        /// <summary>
        ///     Slots as a new stock <c>Slot</c> has them before its first setup pose: no attachment, and a dark colour
        ///     exactly when the slot data has one.
        /// </summary>
        public static void Fresh(BlobContent content, Span<SlotState> slots, Span<float> deform)
        {
            for (int i = 0; i < slots.Length; i++)
                slots[i] = new SlotState { HasDarkColor = content.SlotSetups[i].HasDarkColor, Attachment = -1 };

            deform.Clear();
        }

        private static void ClearDeform(BlobContent content, Span<SlotState> slots, Span<float> deform, int slot)
        {
            int start = content.SlotDeformStart[slot], capacity = content.SlotDeformCapacity[slot];
            for (int k = 0; k < capacity; k++) deform[start + k] = 0;
            SlotState state = slots[slot];
            state.DeformCount = 0;
            slots[slot] = state;
        }

        private static bool IsVertex(AttachmentKind kind)
        {
            return kind != AttachmentKind.Region && kind != AttachmentKind.Point;
        }
    }
}