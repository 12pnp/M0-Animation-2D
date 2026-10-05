using System;
using System.Collections.Generic;
using BoneBurst.Data;

namespace BoneBurst
{
    /// <summary>
    ///     What a baked <see cref="BoneBurstKey" /> names.
    /// </summary>
    public enum BoneBurstKeyKind
    {
        Animation,
        Skin,
        Event,
        Slot,
        Bone
    }

    /// <summary>
    ///     The name keys of one skeleton: every animation, skin, event, slot and bone name as a
    ///     <see cref="BoneBurstKey" />, each id unique in this skeleton. Baked into the skeleton's
    ///     <c>.sbdata</c> by <see cref="BoneBurstDataWriter" />; <c>BoneBurstAsset.Keys</c> gives it.
    /// </summary>
    /// <remarks>
    ///     Categories are baked in <see cref="BoneBurstKeyKind" /> order, each in the export's own order. A name whose
    ///     id is already taken, by the same name in an earlier category or by a hash collision, becomes
    ///     <c>name (A)</c>, then <c>(B)</c> … <c>(Z)</c>, <c>(AA)</c> until its id is free. The order is fixed, so a
    ///     re-bake of an unchanged export gives the same keys. Attachments are not baked.
    /// </remarks>
    public sealed class BoneBurstKeyTable
    {
        private readonly Dictionary<int, int> m_ById;

        private readonly Entry[] m_Entries;

        /// <summary>
        ///     A table over baked entries. <paramref name="bakedIds" />, when given, are the ids the bake computed;
        ///     each must still equal its key's id, or Unity's <c>PropertyName</c> hash has changed since the bake.
        /// </summary>
        /// <exception cref="SkeletonFormatException">Two keys share an id, or an id changed since the bake.</exception>
        public BoneBurstKeyTable(Entry[] entries, int[] bakedIds = null)
        {
            m_Entries = entries ?? throw new ArgumentNullException(nameof(entries));
            m_ById = new Dictionary<int, int>(entries.Length);
            for (int i = 0; i < entries.Length; i++)
            {
                int id = entries[i].Key.Id;
                if (bakedIds != null && bakedIds[i] != id)
                    throw new SkeletonFormatException(
                        $"key '{entries[i].Key}' was baked as id {bakedIds[i]} but hashes to {id} now. Rebake the skeleton.");

                if (!m_ById.TryAdd(id, i))
                    throw new SkeletonFormatException(
                        $"keys '{entries[i].Key}' and '{entries[m_ById[id]].Key}' share id {id}. Rebake the skeleton.");
            }
        }

        public IReadOnlyList<Entry> Entries => m_Entries;

        /// <summary>
        ///     The entry for a key id.
        /// </summary>
        public bool TryGet(int id, out Entry entry)
        {
            if (m_ById.TryGetValue(id, out int index))
            {
                entry = m_Entries[index];
                return true;
            }

            entry = default;
            return false;
        }

        public bool TryGet(BoneBurstKey key, out Entry entry)
        {
            return TryGet(key.Id, out entry);
        }

        /// <summary>
        ///     The key baked for a name as the export spells it (it may carry a suffix). Empty when not baked.
        /// </summary>
        public BoneBurstKey KeyOf(BoneBurstKeyKind kind, string name)
        {
            foreach (Entry entry in m_Entries)
                if (entry.Kind == kind && entry.Name == name)
                    return entry.Key;

            return default;
        }

        /// <summary>
        ///     The keys for a parsed skeleton, every id unique (see the class remarks for the order and suffixes).
        /// </summary>
        public static Entry[] BuildEntries(SkeletonDef skeleton)
        {
            List<Entry> entries = new();
            HashSet<int> used = new() { BoneBurstKey.EmptyId };
            Add(entries, used, BoneBurstKeyKind.Animation, Names(skeleton.Animations, a => a.Name));
            Add(entries, used, BoneBurstKeyKind.Skin, Names(skeleton.Skins, s => s.Name));
            Add(entries, used, BoneBurstKeyKind.Event, Names(skeleton.Events, e => e.Name));
            Add(entries, used, BoneBurstKeyKind.Slot, Names(skeleton.Slots, s => s.Name));
            Add(entries, used, BoneBurstKeyKind.Bone, Names(skeleton.Bones, b => b.Name));
            return entries.ToArray();
        }

        /// <summary>
        ///     The n-th suffix, spreadsheet style: 0 → A, 25 → Z, 26 → AA, 27 → AB.
        /// </summary>
        public static string Suffix(int n)
        {
            string letters = string.Empty;
            for (int i = n + 1; i > 0; i = (i - 1) / 26) letters = (char)('A' + (i - 1) % 26) + letters;

            return letters;
        }

        private static string[] Names<T>(T[] items, Func<T, string> name)
        {
            if (items == null) return Array.Empty<string>();
            string[] names = new string[items.Length];
            for (int i = 0; i < items.Length; i++) names[i] = name(items[i]);

            return names;
        }

        private static void Add(List<Entry> entries, HashSet<int> used, BoneBurstKeyKind kind, string[] names)
        {
            for (int index = 0; index < names.Length; index++)
            {
                string name = names[index] ?? string.Empty;
                string candidate = name;
                for (int n = 0; !used.Add(BoneBurstKey.IdOf(candidate)); n++) candidate = $"{name} ({Suffix(n)})";

                entries.Add(new Entry { Key = new BoneBurstKey(candidate), Kind = kind, Name = name, Index = index });
            }
        }

        /// <summary>
        ///     One baked name: its key (the name, suffixed when its id was taken), what it names, the name as the
        ///     export spells it, and its index in that category.
        /// </summary>
        [Serializable]
        public struct Entry
        {
            public BoneBurstKey Key;
            public BoneBurstKeyKind Kind;
            public string Name;
            public int Index;
        }
    }
}