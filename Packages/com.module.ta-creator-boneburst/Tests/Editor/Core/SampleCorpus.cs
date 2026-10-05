using System.Collections.Generic;
using System.IO;
using System.Linq;
using BoneBurst.Data;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     The sample corpus the test suites run over: the vendored sample exports
    ///     (<c>Data~/samples</c>, read from disk, never imported), M2's binary skeleton, and the synthetic
    ///     JSONs that cover what the samples never use (<c>gaps.json</c>, <c>constraints.json</c>,
    ///     <c>clipping.json</c>, <c>gpu.json</c>).
    /// </summary>
    /// <remarks>
    ///     Lives in the neutral Editor test assembly on purpose: the bake, key and GPU suites use it
    ///     without any stock Spine assembly, while the parity suites
    ///     (<c>Module.TA.BoneBurst.Tests.SpineCsharp</c>, <c>Module.TA.BoneBurst.Tests.SpineUnity</c>)
    ///     reach it through their reference here. The strict-float harness compiles this file with them.
    /// </remarks>
    public static class SampleCorpus
    {
        private const string Samples =
            "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples";

        /// <summary>
        ///     The <c>Data~</c> root, for tests that reach a specific file rather than a corpus case.
        /// </summary>
        public const string Data = "Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~";

        public static IEnumerable<Case> Corpus()
        {
            List<Case> cases = new();
            if (Directory.Exists(Samples))
                foreach (string dir in Directory.GetDirectories(Samples).OrderBy(d => d))
                {
                    string atlas = Directory.GetFiles(dir, "*.atlas.txt").FirstOrDefault();
                    foreach (string file in Directory.GetFiles(dir).OrderBy(f => f))
                        if (atlas != null && (file.EndsWith(".json") || file.EndsWith(".skel.bytes")))
                        {
                            cases.Add(new Case(file, atlas, 1));
                            cases.Add(new Case(file, atlas, 0.37f));
                        }
                }

            cases.Add(new Case($"{Data}/m2-mix-and-match/mix-and-match-pro.skel.bytes",
                $"{Data}/m2-mix-and-match/holding-items.atlas.txt", 0.01f));
            cases.Add(new Case($"{Data}/synthetic/gaps.json", $"{Data}/synthetic/synthetic.atlas.txt", 1));
            cases.Add(new Case($"{Data}/synthetic/gaps.json", $"{Data}/synthetic/synthetic.atlas.txt", 0.37f));
            cases.Add(new Case($"{Data}/synthetic/constraints.json", $"{Data}/synthetic/synthetic.atlas.txt", 1));
            cases.Add(new Case($"{Data}/synthetic/constraints.json", $"{Data}/synthetic/synthetic.atlas.txt", 0.37f));
            cases.Add(new Case($"{Data}/synthetic/clipping.json", $"{Data}/synthetic/synthetic.atlas.txt", 1));
            cases.Add(new Case($"{Data}/synthetic/gpu.json", $"{Data}/synthetic/synthetic.atlas.txt", 1));
            return cases;
        }

        /// <summary>
        ///     Reads a case's skeleton export through BoneBurst's own readers, never stock's.
        /// </summary>
        public static SkeletonDef Read(Case c)
        {
            return c.Skeleton.EndsWith(".json")
                ? SkeletonJsonReader.Read(File.ReadAllText(c.Skeleton), c.Scale)
                : SkeletonBinaryReader.Read(File.ReadAllBytes(c.Skeleton), c.Scale);
        }

        public readonly struct Case
        {
            public readonly string Skeleton, Atlas;
            public readonly float Scale;

            public Case(string skeleton, string atlas, float scale)
            {
                Skeleton = skeleton;
                Atlas = atlas;
                Scale = scale;
            }

            public override string ToString()
            {
                return $"{Path.GetFileName(Skeleton)} @{Scale}";
            }
        }
    }
}
