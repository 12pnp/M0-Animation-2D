using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using BoneBurst.Blob;
using BoneBurst.Data;
using BoneBurst.Instance;
using NUnit.Framework;
using Spine;
using UnityEngine;
using Physics = Spine.Physics;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     P2 parity: the setup pose, with constraints solved (P5) and physics not stepped
    ///     (<c>UpdateWorldTransform(Physics.None)</c>), posed and meshed by <see cref="MeshBuilder" />, equals stock
    ///     spine-csharp's bones and (spine-unity's own mesh, through <see cref="StockMeshCompare" /> when that
    ///     assembly is present) vertex for vertex.
    /// </summary>
    /// <remarks>
    ///     Runs the managed path (<see cref="ManagedPose" />), the same code the Burst jobs call. The Burst result is
    ///     compared against this managed result in the play-mode tests.
    /// </remarks>
    public class SetupPoseParityTests
    {
        /// <summary>
        ///     The mesh half of this suite: spine-unity's mesh against BoneBurst's, vertices in three dimensions and
        ///     the indices across submeshes. Installed at editor load by the spine-unity test assembly
        ///     (<c>Module.TA.BoneBurst.Tests.SpineUnity</c>); null in the strict-float harness and anywhere without
        ///     that assembly. Returns the vertices compared, for this suite's nothing-was-compared guard.
        /// </summary>
        internal static Func<string, Skeleton, ManagedPose, List<string>, int> StockMeshCompare;

        private static IEnumerable<SampleCorpus.Case> Corpus()
        {
            return SampleCorpus.Corpus();
        }

        [TestCaseSource(nameof(Corpus))]
        public void SetupPose_MatchesStock(SampleCorpus.Case c)
        {
            (SkeletonData data, Atlas atlas) = LoadStock(c);
            SkeletonDef def = c.Skeleton.EndsWith(".json")
                ? SkeletonJsonReader.Read(File.ReadAllText(c.Skeleton), c.Scale)
                : SkeletonBinaryReader.Read(File.ReadAllBytes(c.Skeleton), c.Scale);
            ParityDrift.BeginCase(ParityDrift.SizeOf(def, c.Scale));
            BlobContent content = BlobBuilder.BuildContent(def, AtlasReader.Read(File.ReadAllText(c.Atlas)));

            List<int> skins = new() { -1 };
            skins.AddRange(Enumerable.Range(0, def.Skins.Length).Where(s => def.Skins[s] != def.DefaultSkin).Take(2));
            List<string> failures = new();
            int compared = 0;
            foreach (int skin in skins)
            {
                Skeleton skeleton = new(data);
                if (skin >= 0) skeleton.SetSkin(def.Skins[skin].Name);
                skeleton.UpdateWorldTransform(Physics.None);

                ManagedPose mine = new(content, skin)
                {
                    LinearColorSpace = QualitySettings.activeColorSpace == ColorSpace.Linear
                };
                mine.SetupPoseAndMesh();
                string at = skin < 0 ? "no skin" : def.Skins[skin].Name;
                ParityConditioning.Mark(skeleton, def);

                for (int i = 0; i < def.Bones.Length; i++)
                {
                    Bone bone = skeleton.Bones.Items[i];
                    if (!ParityDrift.Same("discrete.active", at, bone.Active == mine.BoneActive[i]))
                    {
                        failures.Add($"{at}: bone {bone.Data.Name} active {bone.Active} vs {mine.BoneActive[i]}");
                        continue;
                    }

                    if (!bone.Active || !mine.BoneActive[i]) continue;
                    BonePose p = bone.AppliedPose;
                    BoneWorld w = mine.World[i];
                    compared++;
                    if (!AnimationParityTests.SameWorld(at, bone.Data.Name, p, w))
                        failures.Add($"{at}: bone {bone.Data.Name} world differs");
                }

                compared += StockMeshCompare?.Invoke(at, skeleton, mine, failures) ?? 0;
            }

            Assert.That(compared, Is.GreaterThan(0), "nothing was compared");
            ParityDrift.CheckFrames(failures);
            ParityDrift.WriteCaseSummary();
            Assert.IsEmpty(failures, string.Join("\n", failures.Take(30)));
        }

        private static (SkeletonData, Atlas) LoadStock(SampleCorpus.Case c)
        {
            Atlas atlas = new(new StringReader(File.ReadAllText(c.Atlas)), "", new NoTextures());
            atlas.FlipV();
            SkeletonData data;
            if (c.Skeleton.EndsWith(".json"))
            {
                data = new SkeletonJson(atlas) { Scale = c.Scale }.ReadSkeletonData(
                    new StringReader(File.ReadAllText(c.Skeleton)));
            }
            else
            {
                using FileStream stream = File.OpenRead(c.Skeleton);
                data = new SkeletonBinary(atlas) { Scale = c.Scale }.ReadSkeletonData(stream);
            }

            return (data, atlas);
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