using System;
using System.Collections.Generic;
using BoneBurst.Blob;

namespace BoneBurst
{
    /// <summary>
    ///     A skin: placeholders mapped to attachments, plus the bones and constraints it activates. The skins in a
    ///     skeleton file are <see cref="SkeletonBlob.GetSkin" />; combine them at runtime with <see cref="AddSkin" />
    ///     and show the result with <c>BoneBurstSkeleton.SetSkin</c>
    ///     (<c>Doc/Format/Skins-TintBlack-Culling.md</c> §1).
    /// </summary>
    /// <remarks>
    ///     Attachments are indices into the skeleton's blob, so a skin belongs to one skeleton asset. The entry
    ///     order follows the stock <c>Dictionary</c> rules (§1.1): a new key appends, an overwrite keeps its position,
    ///     a removed position is reused by the next insert (most recently freed first). Order matters where the
    ///     stock runtime walks a skin: <see cref="AddSkin" />, a skin swap, and path-constraint sorting.
    ///     <para>
    ///         Editing the skin a skeleton already shows changes nothing on that skeleton until it is set again,
    ///         as in the stock runtime; build a new skin and set it.
    ///     </para>
    /// </remarks>
    public sealed class BoneBurstSkin
    {
        /// <summary>
        ///     The blob content the attachment indices refer to.
        /// </summary>
        public readonly BlobContent Content;

        public readonly string Name;
        private readonly List<int> m_Bones = new();
        private readonly List<int> m_Constraints = new();

        private readonly List<Entry> m_Entries = new();
        private readonly Stack<int> m_Free = new();
        private readonly Dictionary<(int slot, string placeholder), int> m_Positions = new();

        /// <summary>
        ///     Creates an empty skin for skeletons built from <paramref name="blob" />.
        /// </summary>
        /// <exception cref="ArgumentNullException">A null name or blob.</exception>
        public BoneBurstSkin(string name, SkeletonBlob blob) : this(name, blob?.Content)
        {
        }

        internal BoneBurstSkin(string name, BlobContent content)
        {
            Name = name ?? throw new ArgumentNullException(nameof(name));
            Content = content ?? throw new ArgumentNullException(nameof(content));
        }

        /// <summary>
        ///     Bones the skin activates (bone indices), in list order.
        /// </summary>
        public IReadOnlyList<int> Bones => m_Bones;

        /// <summary>
        ///     Skin-required constraints the skin activates (constraint indices), in list order.
        /// </summary>
        public IReadOnlyList<int> Constraints => m_Constraints;

        /// <summary>
        ///     Bumped by every attachment edit. A skeleton showing this skin re-resolves its attachment lookups when
        ///     it changes, because stock resolves timeline keys through the live skin (activation and update order
        ///     still wait for <c>UpdateCache</c>).
        /// </summary>
        public int Version { get; private set; }

        /// <summary>
        ///     Number of attachment entries.
        /// </summary>
        public int Count => m_Positions.Count;

        /// <summary>
        ///     Maps a placeholder of a slot to an attachment (a blob attachment index). Overwrites in place.
        /// </summary>
        /// <exception cref="ArgumentException">A negative slot, a null placeholder, or an attachment out of range.</exception>
        public void SetAttachment(int slot, string placeholder, int attachment)
        {
            if (attachment < 0 || attachment >= Content.Attachments.Length)
                throw new ArgumentException($"no attachment {attachment} in this skeleton", nameof(attachment));

            (int, string) key = Key(slot, placeholder);
            Version++;
            if (m_Positions.TryGetValue(key, out int position))
            {
                Entry existing = m_Entries[position];
                existing.Attachment = attachment;
                m_Entries[position] = existing;
                return;
            }

            Entry entry = new() { Slot = slot, Placeholder = placeholder, Attachment = attachment };
            if (m_Free.Count > 0)
            {
                position = m_Free.Pop();
                m_Entries[position] = entry;
            }
            else
            {
                position = m_Entries.Count;
                m_Entries.Add(entry);
            }

            m_Positions.Add(key, position);
        }

        /// <summary>
        ///     Removes a placeholder; nothing happens when it is absent.
        /// </summary>
        public void RemoveAttachment(int slot, string placeholder)
        {
            (int, string) key = Key(slot, placeholder);
            if (!m_Positions.TryGetValue(key, out int position)) return;
            Version++;
            m_Positions.Remove(key);
            m_Entries[position] = new Entry { Attachment = -1 };
            m_Free.Push(position);
        }

        /// <summary>
        ///     The attachment index for a slot's placeholder, or -1.
        /// </summary>
        public int GetAttachment(int slot, string placeholder)
        {
            return m_Positions.TryGetValue(Key(slot, placeholder), out int position)
                ? m_Entries[position].Attachment
                : -1;
        }

        /// <summary>
        ///     Every entry in the skin's order.
        /// </summary>
        public IEnumerable<(int slot, string placeholder, int attachment)> Entries()
        {
            foreach (Entry e in m_Entries)
                if (e.Attachment >= 0)
                    yield return (e.Slot, e.Placeholder, e.Attachment);
        }

        /// <summary>
        ///     Adds another skin: its bones and constraints (without duplicates), then its attachments, which
        ///     overwrite this skin's at shared keys (§1.3). Attachments are shared, not copied.
        /// </summary>
        /// <exception cref="ArgumentException"><paramref name="other" /> belongs to another skeleton, or is this skin.</exception>
        public void AddSkin(BoneBurstSkin other)
        {
            if (other == null) throw new ArgumentNullException(nameof(other));
            if (other.Content != Content)
                throw new ArgumentException($"skin '{other.Name}' belongs to another skeleton", nameof(other));

            // Stock throws on self-add (a Dictionary modified while enumerated); refuse it up front.
            if (other == this) throw new ArgumentException("a skin cannot be added to itself", nameof(other));
            foreach (int bone in other.m_Bones)
                if (!m_Bones.Contains(bone))
                    m_Bones.Add(bone);

            foreach (int constraint in other.m_Constraints)
                if (!m_Constraints.Contains(constraint))
                    m_Constraints.Add(constraint);

            foreach (Entry e in other.m_Entries)
                if (e.Attachment >= 0)
                    SetAttachment(e.Slot, e.Placeholder, e.Attachment);
        }

        /// <summary>
        ///     Removes every entry, bone and constraint.
        /// </summary>
        public void Clear()
        {
            Version++;
            m_Entries.Clear();
            m_Positions.Clear();
            m_Free.Clear();
            m_Bones.Clear();
            m_Constraints.Clear();
        }

        internal void AddBone(int bone)
        {
            if (!m_Bones.Contains(bone)) m_Bones.Add(bone);
        }

        internal void AddConstraint(int constraint)
        {
            if (!m_Constraints.Contains(constraint)) m_Constraints.Add(constraint);
        }

        public override string ToString()
        {
            return Name;
        }

        private static (int, string) Key(int slot, string placeholder)
        {
            if (slot < 0) throw new ArgumentException("slot index must be >= 0", nameof(slot));
            if (placeholder == null) throw new ArgumentNullException(nameof(placeholder));
            return (slot, placeholder);
        }

        private struct Entry
        {
            public int Slot;
            public string Placeholder;

            /// <summary>
            ///     Attachment index, or -1 for a free position.
            /// </summary>
            public int Attachment;
        }
    }
}