using System.Collections.Generic;
using System.IO;
using System.Linq;
using BoneBurst.Blob;
using BoneBurst.Data;
using NUnit.Framework;
using UnityEngine;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     Baked data (<see cref="BoneBurstDataWriter" /> → <see cref="BoneBurstDataReader" />) gives back exactly
    ///     the model the source reader built: every field bit for bit, the same blob, the same keys. Plus the
    ///     refusals: damaged, truncated, another version, curves without control points.
    /// </summary>
    /// <remarks>
    ///     Corpus: the sample corpus (<see cref="SampleCorpus.Corpus" />), JSON and binary exports at two
    ///     scales. Format: <c>Doc/Format/BakedData.md</c>.
    /// </remarks>
    public class BakedDataTests
    {
        /// <summary>
        ///     Not written by design (the format doc lists why).
        /// </summary>
        private static readonly string[] Dropped =
            { "MeshDef.Edges", "SkeletonDef.ImagesPath", "SkeletonDef.AudioPath" };

        private static IEnumerable<SampleCorpus.Case> Corpus()
        {
            return SampleCorpus.Corpus();
        }

        [Test]
        public void Corpus_IsPresent()
        {
            // A round trip over nothing is a failure, not a pass.
            Assert.That(Corpus().Count(), Is.GreaterThanOrEqualTo(40));
        }

        [TestCaseSource(nameof(Corpus))]
        public void RoundTrip_GivesBackTheSameModel(SampleCorpus.Case c)
        {
            SkeletonDef source = SampleCorpus.Read(c);
            AtlasDef atlas = AtlasReader.Read(File.ReadAllText(c.Atlas));
            byte[] bytes = BoneBurstDataWriter.Write(source, atlas, c.Scale);
            BoneBurstData data = BoneBurstDataReader.Read(bytes);

            DeepComparer model = new(Dropped);
            model.Compare("skeleton", source, data.Skeleton);
            model.Compare("atlas", atlas, data.Atlas);
            Assert.That(model.Checks, Is.GreaterThan(200), "too few comparisons to mean anything");
            Assert.IsEmpty(model.Failures, string.Join("\n", model.Failures.Take(40)));
            Assert.AreEqual(c.Scale, data.Scale);

            // What the runtime actually uses: the blob built from each must be identical.
            BlobContent expected = BlobBuilder.BuildContent(source, atlas);
            BlobContent actual = BlobBuilder.BuildContent(data.Skeleton, data.Atlas);
            DeepComparer blob = new("BlobContent.Skeleton", "BlobContent.AttachmentDefs");
            blob.Compare("blob", expected, actual);
            Assert.That(blob.Checks, Is.GreaterThan(200), "too few blob comparisons to mean anything");
            Assert.IsEmpty(blob.Failures, string.Join("\n", blob.Failures.Take(40)));

            // Writing what was read gives the same bytes: the format has one encoding per model.
            CollectionAssert.AreEqual(bytes, BoneBurstDataWriter.Write(data.Skeleton, data.Atlas, c.Scale),
                "writing the read-back model gave different bytes");

            long sourceSize = new FileInfo(c.Skeleton).Length + new FileInfo(c.Atlas).Length;
            Debug.Log($"[BakedData] {c}: source {sourceSize:N0} B (skeleton + atlas) -> baked {bytes.Length:N0} B " +
                      $"({100.0 * bytes.Length / sourceSize:F0}%)");
            if (c.Skeleton.EndsWith(".json"))
                Assert.Less(bytes.Length, sourceSize, "baked data is not smaller than the JSON and atlas it replaces");
        }

        [TestCaseSource(nameof(Corpus))]
        public void Keys_AreTheBakedKeys(SampleCorpus.Case c)
        {
            SkeletonDef source = SampleCorpus.Read(c);
            BoneBurstData data = BoneBurstDataReader.Read(
                BoneBurstDataWriter.Write(source, AtlasReader.Read(File.ReadAllText(c.Atlas)), c.Scale));
            BoneBurstKeyTable.Entry[] expected = BoneBurstKeyTable.BuildEntries(source);

            Assert.That(expected.Length, Is.GreaterThan(0), "a skeleton with no keys is not a test");
            Assert.AreEqual(expected.Length, data.Keys.Length);
            for (int i = 0; i < expected.Length; i++)
            {
                string at = $"key {i} ({expected[i].Kind} {expected[i].Name})";
                Assert.AreEqual(expected[i].Key.String, data.Keys[i].Key.String, at);
                Assert.AreEqual(expected[i].Kind, data.Keys[i].Kind, at);
                Assert.AreEqual(expected[i].Name, data.Keys[i].Name, at);
                Assert.AreEqual(expected[i].Index, data.Keys[i].Index, at);
                Assert.AreEqual(expected[i].Key.Id, data.KeyIds[i], at + ": stored id");
                Assert.AreEqual(data.Keys[i].Key.Id, data.KeyIds[i], at + ": id no longer matches its key's hash");
            }
        }

        private static byte[] Gaps()
        {
            return BoneBurstDataWriter.Write(SkeletonJsonReader.Read(File.ReadAllText($"{SampleCorpus.Data}/synthetic/gaps.json")),
                AtlasReader.Read(File.ReadAllText($"{SampleCorpus.Data}/synthetic/synthetic.atlas.txt")), 1, new byte[] { 1, 2, 3 });
        }

        [Test]
        public void SourceDigest_IsKept()
        {
            CollectionAssert.AreEqual(new byte[] { 1, 2, 3 }, BoneBurstDataReader.Read(Gaps()).SourceDigest);
        }

        [Test]
        public void Damaged_IsRefused()
        {
            byte[] bytes = Gaps();
            bytes[bytes.Length / 2] ^= 0x10;
            SkeletonFormatException e = Assert.Throws<SkeletonFormatException>(() => BoneBurstDataReader.Read(bytes));
            StringAssert.Contains("checksum", e.Message);
        }

        [Test]
        public void Truncated_IsRefused()
        {
            byte[] bytes = Gaps();
            Assert.Throws<SkeletonFormatException>(() =>
                BoneBurstDataReader.Read(bytes.Take(bytes.Length - 7).ToArray()));
            Assert.Throws<SkeletonFormatException>(() => BoneBurstDataReader.Read(bytes.Take(10).ToArray()));
        }

        [Test]
        public void OtherVersion_IsRefused()
        {
            byte[] bytes = Gaps();
            bytes[4] = (byte)(BoneBurstData.FormatVersion + 1);
            SkeletonFormatException e = Assert.Throws<SkeletonFormatException>(() => BoneBurstDataReader.Read(bytes));
            StringAssert.Contains("format version", e.Message);
        }

        [Test]
        public void WrongMagic_IsRefused()
        {
            byte[] bytes = Gaps();
            bytes[0] = (byte)'{';
            Assert.Throws<SkeletonFormatException>(() => BoneBurstDataReader.Read(bytes));
        }

        [Test]
        public void CurvesWithoutControlPoints_AreRefused()
        {
            SkeletonDef skeleton = SkeletonJsonReader.Read(File.ReadAllText($"{SampleCorpus.Data}/synthetic/gaps.json"));
            TimelineDef curved = skeleton.Animations.SelectMany(a => a.Timelines).First(t => t.Curves != null);
            curved.Beziers = null;
            Assert.Throws<SkeletonFormatException>(() => BoneBurstDataWriter.Write(skeleton,
                AtlasReader.Read(File.ReadAllText($"{SampleCorpus.Data}/synthetic/synthetic.atlas.txt")), 1));
        }

        [Test]
        public void CurvesThatDoNotRebuild_AreRefused()
        {
            // A control point that no longer matches the baked curve: the writer's own check must catch it.
            SkeletonDef skeleton =
                SkeletonJsonReader.Read(File.ReadAllText($"{SampleCorpus.Data}/samples/spineboy-pro/spineboy-pro.json"));
            TimelineDef curved = skeleton.Animations.SelectMany(a => a.Timelines)
                .First(t => t.Beziers != null && t.Beziers.Length > 0);
            curved.Beziers[0] += 0.25f;
            Assert.Throws<SkeletonFormatException>(() => BoneBurstDataWriter.Write(skeleton, new AtlasDef(), 1));
        }
    }
}