using System.Collections.Generic;
using System.IO;
using System.Linq;
using BoneBurst.Data;
using NUnit.Framework;
using Spine;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     P1 parity: every corpus file read by <see cref="SkeletonBinaryReader" /> / <see cref="SkeletonJsonReader" />
    ///     and <see cref="AtlasReader" /> equals what stock spine-csharp reads, value for value.
    /// </summary>
    /// <remarks>
    ///     Corpus: the vendored sample exports (<c>Data~/samples</c>, read from disk, never imported), M2's real skeleton, and
    ///     two synthetic JSONs that cover what the samples never use: <c>gaps.json</c> (sliders, draw-order folders,
    ///     two-colour and single-axis timelines) and <c>constraints.json</c> (constraint branches: one-bone IK
    ///     stretch/compress, local and additive transforms, proportional and fixed paths, physics modes, sliders
    ///     that key slots and constraints), plus <c>clipping.json</c> (concave, inverse, convex-flag, weighted and
    ///     nested clips, end-slot rules) and <c>gpu.json</c> (weight sums other than 1, a negative weight, a flipped
    ///     bone, a coloured dark tint on a rendered slot). Coverage per file: <c>Doc/Parity/Parity.md</c>.
    /// </remarks>
    public class ReaderParityTests
    {
        private static IEnumerable<SampleCorpus.Case> Corpus()
        {
            return SampleCorpus.Corpus();
        }

        [Test]
        public void Corpus_IsPresent()
        {
            // A parity run over nothing is a failure, not a pass.
            Assert.That(Corpus().Count(), Is.GreaterThanOrEqualTo(40), "expected 19 sample files at 2 scales + 3");
        }

        [TestCaseSource(nameof(Corpus))]
        public void Reader_MatchesStock(SampleCorpus.Case c)
        {
            Atlas stockAtlas = new(new StringReader(File.ReadAllText(c.Atlas)), "", new NoTextures());
            SkeletonData stock;
            SkeletonDef mine;
            if (c.Skeleton.EndsWith(".json"))
            {
                stock = new SkeletonJson(stockAtlas) { Scale = c.Scale }.ReadSkeletonData(
                    new StringReader(File.ReadAllText(c.Skeleton)));
                mine = SkeletonJsonReader.Read(File.ReadAllText(c.Skeleton), c.Scale);
            }
            else
            {
                using (FileStream stream = File.OpenRead(c.Skeleton))
                {
                    stock = new SkeletonBinary(stockAtlas) { Scale = c.Scale }.ReadSkeletonData(stream);
                }

                mine = SkeletonBinaryReader.Read(File.ReadAllBytes(c.Skeleton), c.Scale);
            }

            ReaderParityComparer comparer = new();
            comparer.Compare(stock, mine);
            comparer.CompareAtlas(stockAtlas, AtlasReader.Read(File.ReadAllText(c.Atlas)));

            Assert.That(comparer.Checks, Is.GreaterThan(50), "too few comparisons to mean anything");
            Assert.IsEmpty(comparer.Failures, string.Join("\n", comparer.Failures.Take(40)));
        }

        [Test]
        public void Binary_RejectsOtherVersions()
        {
            byte[] data = File.ReadAllBytes($"{SampleCorpus.Data}/m2-mix-and-match/mix-and-match-pro.skel.bytes");
            // Byte 8 is the version string's length prefix; the text "4.3.23" follows. Make it "4.2.23".
            Assert.AreEqual((byte)'3', data[11]);
            data[11] = (byte)'2';
            SkeletonFormatException e =
                Assert.Throws<SkeletonFormatException>(() => SkeletonBinaryReader.Read(data));
            StringAssert.Contains("4.3 only", e.Message);
        }

        [Test]
        public void Binary_TruncatedFile_ThrowsInsteadOfReadingGarbage()
        {
            byte[] data = File.ReadAllBytes($"{SampleCorpus.Data}/m2-mix-and-match/mix-and-match-pro.skel.bytes");
            byte[] cut = data.Take(data.Length / 2).ToArray();
            Assert.Throws<SkeletonFormatException>(() => SkeletonBinaryReader.Read(cut));
        }

        [Test]
        public void Json_RejectsOtherVersions()
        {
            string json = File.ReadAllText($"{SampleCorpus.Data}/synthetic/gaps.json").Replace("4.3.74-beta", "4.2.40");
            Assert.Throws<SkeletonFormatException>(() => SkeletonJsonReader.Read(json));
        }

        private sealed class NoTextures : TextureLoader
        {
            public void Load(AtlasPage page, string path)
            {
            }

            public void Unload(object texture)
            {
            }
        }
    }
}