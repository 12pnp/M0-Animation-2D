using System;
using System.Collections.Generic;
using System.IO;
using BoneBurst.Data;
using NUnit.Framework;
using UnityEngine;
using Object = UnityEngine.Object;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     <see cref="BoneBurstKeyTable" />: every id unique per skeleton with (A), (B), (C) suffixes, deterministic
    ///     re-bakes, ids equal to M2's <c>PropertyString</c> (<c>PropertyName</c> hash), and the table a
    ///     <see cref="BoneBurstAsset" /> reads from its baked data.
    /// </summary>
    public class BoneBurstKeysTests
    {
        private const string Samples =
            "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples";

        // Every category holds a name "x": the first keeps it, the rest take (A)…(D) in bake order.
        private const string AllNamedX =
            "{\"skeleton\":{\"spine\":\"4.3.00\"}," +
            "\"bones\":[{\"name\":\"root\"},{\"name\":\"x\",\"parent\":\"root\"}]," +
            "\"slots\":[{\"name\":\"x\",\"bone\":\"x\"}]," +
            "\"skins\":[{\"name\":\"default\"},{\"name\":\"x\"}]," +
            "\"events\":{\"x\":{}}," +
            "\"animations\":{\"x\":{}}}";

        private readonly List<Object> m_Owned = new();

        [TearDown]
        public void TearDown()
        {
            foreach (Object owned in m_Owned) Object.DestroyImmediate(owned);
            m_Owned.Clear();
        }

        private static BoneBurstKeyTable Bake(string jsonText)
        {
            return new BoneBurstKeyTable(BoneBurstKeyTable.BuildEntries(SkeletonJsonReader.Read(jsonText)));
        }

        [TestCase(0, "A")]
        [TestCase(1, "B")]
        [TestCase(25, "Z")]
        [TestCase(26, "AA")]
        [TestCase(27, "AB")]
        [TestCase(701, "ZZ")]
        [TestCase(702, "AAA")]
        public void Suffix_IsSpreadsheetStyle(int n, string expected)
        {
            Assert.AreEqual(expected, BoneBurstKeyTable.Suffix(n));
        }

        [Test]
        public void Id_EqualsPropertyNameHash_LikePropertyString()
        {
            Assert.AreEqual(new PropertyName("walk").GetHashCode(), new BoneBurstKey("walk").Id);
            Assert.AreEqual(BoneBurstKey.EmptyId, new BoneBurstKey("").Id);
            Assert.AreEqual(BoneBurstKey.EmptyId, default(BoneBurstKey).Id);
        }

        [Test]
        public void SameNameInEveryCategory_GetsSuffixesInBakeOrder()
        {
            BoneBurstKeyTable keys = Bake(AllNamedX);
            Assert.AreEqual("x", keys.KeyOf(BoneBurstKeyKind.Animation, "x").String);
            Assert.AreEqual("x (A)", keys.KeyOf(BoneBurstKeyKind.Skin, "x").String);
            Assert.AreEqual("x (B)", keys.KeyOf(BoneBurstKeyKind.Event, "x").String);
            Assert.AreEqual("x (C)", keys.KeyOf(BoneBurstKeyKind.Slot, "x").String);
            Assert.AreEqual("x (D)", keys.KeyOf(BoneBurstKeyKind.Bone, "x").String);
        }

        [Test]
        public void Table_RefusesAnIdThatChangedSinceTheBake()
        {
            BoneBurstKeyTable.Entry[] entries = BoneBurstKeyTable.BuildEntries(SkeletonJsonReader.Read(AllNamedX));
            int[] ids = new int[entries.Length];
            for (int i = 0; i < ids.Length; i++) ids[i] = entries[i].Key.Id;
            Assert.DoesNotThrow(() => new BoneBurstKeyTable(entries, ids));

            ids[2]++;
            SkeletonFormatException e =
                Assert.Throws<SkeletonFormatException>(() => new BoneBurstKeyTable(entries, ids));
            StringAssert.Contains("Rebake", e.Message);
        }

        [Test]
        public void Table_RefusesTwoKeysWithOneId()
        {
            BoneBurstKeyTable.Entry[] entries = BoneBurstKeyTable.BuildEntries(SkeletonJsonReader.Read(AllNamedX));
            entries[1].Key = entries[0].Key;
            Assert.Throws<SkeletonFormatException>(() => new BoneBurstKeyTable(entries));
        }

        [TestCase("spineboy-pro/spineboy-pro.json")]
        [TestCase("mix-and-match/mix-and-match-pro.json")]
        [TestCase("Dragon/dragon.json")]
        [TestCase("Goblins/goblins.json")]
        public void Sample_EveryNameBaked_EveryIdUnique_Deterministic(string file)
        {
            string text = File.ReadAllText($"{Samples}/{file}");
            SkeletonDef skeleton = SkeletonJsonReader.Read(text);
            BoneBurstKeyTable keys = Bake(text);

            int expected = skeleton.Animations.Length + skeleton.Skins.Length + skeleton.Events.Length +
                           skeleton.Slots.Length + skeleton.Bones.Length;
            Assert.AreEqual(expected, keys.Entries.Count, "one key per name");
            Assert.Greater(expected, 0, "an empty bake proves nothing");

            HashSet<int> ids = new();
            int suffixed = 0;
            foreach (BoneBurstKeyTable.Entry entry in keys.Entries)
            {
                Assert.IsTrue(ids.Add(entry.Key.Id), $"duplicate id for '{entry.Key}'");
                Assert.AreNotEqual(BoneBurstKey.EmptyId, entry.Key.Id);
                Assert.IsTrue(keys.TryGet(entry.Key.Id, out BoneBurstKeyTable.Entry found));
                Assert.AreEqual(entry.Kind, found.Kind);
                Assert.AreEqual(entry.Name, found.Name);
                if (entry.Key.String != entry.Name)
                {
                    suffixed++;
                    StringAssert.StartsWith(entry.Name + " (", entry.Key.String);
                }
            }

            // Animations are baked first, so they always keep the export's own names.
            foreach (AnimationDef animation in skeleton.Animations)
                Assert.AreEqual(animation.Name, keys.KeyOf(BoneBurstKeyKind.Animation, animation.Name).String);

            BoneBurstKeyTable again = Bake(text);
            for (int i = 0; i < keys.Entries.Count; i++)
                Assert.AreEqual(keys.Entries[i].Key.String, again.Entries[i].Key.String, "re-bake changed a key");

            Debug.Log($"[BoneBurstKeyTable] {file}: {keys.Entries.Count} keys, {suffixed} suffixed");
        }

        [Test]
        public void Asset_KeysFromBakedData_NameOfResolvesKindAndRefusesWrongKind()
        {
            // The asset's keys come from its baked data, not a separate asset.
            string folder = $"{Samples}/spineboy-pro";
            SkeletonDef skeleton = SkeletonJsonReader.Read(File.ReadAllText($"{folder}/spineboy-pro.json"), 0.01f);
            byte[] bytes = BoneBurstDataWriter.Write(skeleton,
                AtlasReader.Read(File.ReadAllText($"{folder}/spineboy-pro.atlas.txt")), 0.01f);
            BoneBurstAsset asset = ScriptableObject.CreateInstance<BoneBurstAsset>();
            m_Owned.Add(asset);
            asset.SetDataBytes(bytes);
            Texture2D page = new(2, 2);
            m_Owned.Add(page);
            asset.SetPageTextures(new[] { page }); // one page per atlas page, so no unaddressed-page error
            BoneBurstKeyTable keys = asset.Keys;
            Assert.AreEqual(BoneBurstKeyTable.BuildEntries(skeleton).Length, keys.Entries.Count);

            Assert.AreEqual("walk", asset.NameOf(new BoneBurstKey("walk").Id, BoneBurstKeyKind.Animation));
            BoneBurstKey headSlot = keys.KeyOf(BoneBurstKeyKind.Slot, "head");
            BoneBurstKey headBone = keys.KeyOf(BoneBurstKeyKind.Bone, "head");
            Assert.AreNotEqual(headSlot.Id, headBone.Id, "slot and bone 'head' must not share an id");
            Assert.AreEqual("head", asset.NameOf(headBone.Id, BoneBurstKeyKind.Bone));
            Assert.Throws<ArgumentException>(() => asset.NameOf(headSlot.Id, BoneBurstKeyKind.Animation));
            Assert.Throws<ArgumentException>(() => asset.NameOf(new BoneBurstKey("no-such").Id,
                BoneBurstKeyKind.Animation));
        }
    }
}