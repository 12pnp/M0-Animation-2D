using System.Collections.Generic;
using System.Linq;
using BoneBurst.Instance;
using Spine;
using Spine.Unity;
using UnityEditor;
using UnityEngine;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     The spine-unity halves of the parity suites' mesh comparisons, installed at editor load into the
    ///     strict suites' hooks (<see cref="AnimationParityTests.StockMeshCompare" /> and
    ///     <see cref="SetupPoseParityTests.StockMeshCompare" />). This assembly is the only test code that references
    ///     spine-unity; delete it and the rest of the suites still run, without the stock mesh comparisons.
    /// </summary>
    internal static class StockMeshComparisons
    {
        [InitializeOnLoadMethod]
        private static void Install()
        {
            AnimationParityTests.StockMeshCompare = CompareAnimation;
            SetupPoseParityTests.StockMeshCompare = CompareSetupPose;
        }

        /// <summary>
        ///     Sets spine-unity's colour space from <c>QualitySettings</c>, as the BoneBurst side reads it. spine-unity
        ///     keeps it in a static (<c>MeshGenerator.linearColorSpaceGlobal</c>) that only <c>SkeletonRenderer</c>
        ///     initialises; left unset it means gamma, and additive slots with alpha below 1 were compared across
        ///     colour spaces (up to 73 of 255 per channel; parity plan F2).
        /// </summary>
        internal static void StockColorSpace()
        {
            MeshGenerator.linearColorSpaceGlobal = QualitySettings.activeColorSpace == ColorSpace.Linear;
        }

        /// <summary>
        ///     spine-unity's mesh for the animating skeleton against BoneBurst's, vertex for vertex (positions and
        ///     UVs in two dimensions: the animation-parity pass).
        /// </summary>
        private static void CompareAnimation(string at, Skeleton skeleton, ManagedPose m, List<string> failures)
        {
            SkeletonRendererInstruction instruction = new();
            StockColorSpace();
            MeshGenerator.GenerateSkeletonRendererInstruction(instruction, skeleton, null, null, false);
            if (instruction.hasActiveClipping) return; // clipping is P6

            MeshGenerator generator = new();
            generator.Begin();
            generator.BuildMeshWithArrays(instruction, true);
            m.BuildMesh();
            Mesh stock = new();
            try
            {
                generator.FillVertexData(stock);
                if (generator.VertexCount != m.Counts.Vertices)
                {
                    if (!ParityDrift.Same("discrete.count", at, false))
                        failures.Add($"{at}: vertex count {generator.VertexCount} vs {m.Counts.Vertices}");

                    return;
                }

                Vector3[] positions = stock.vertices;
                Vector2[] uvs = stock.uv;
                Color32[] colors = stock.colors32;
                for (int i = 0; i < generator.VertexCount; i++)
                {
                    SkeletonVertex v = m.Vertices[i];
                    if (!AnimationParityTests.SameVertex(at, positions[i], uvs[i], colors[i], v, false))
                    {
                        failures.Add($"{at}: vertex {i} differs");
                        return;
                    }
                }
            }
            finally
            {
                Object.DestroyImmediate(stock);
            }
        }

        /// <summary>
        ///     spine-unity's mesh for the setup pose against BoneBurst's — vertices in three dimensions (the z
        ///     spacing) and, spine-unity splitting submeshes by material object and no materials being loaded here,
        ///     the indices in order across all submeshes. Returns the vertices compared, for the suite's
        ///     nothing-was-compared guard.
        /// </summary>
        private static int CompareSetupPose(string at, Skeleton skeleton, ManagedPose mine, List<string> failures)
        {
            SkeletonRendererInstruction instruction = new();
            StockColorSpace();
            MeshGenerator.GenerateSkeletonRendererInstruction(instruction, skeleton, null, null, false);
            if (instruction.hasActiveClipping)
                // spine-unity takes its clipping path, which orders region vertices differently (P6).
                return 0;

            MeshGenerator generator = new();
            generator.Begin();
            generator.BuildMeshWithArrays(instruction, true);
            Mesh stock = new();
            try
            {
                generator.FillVertexData(stock);
                generator.FillTriangles(stock);
                if (generator.VertexCount != mine.Counts.Vertices)
                {
                    if (!ParityDrift.Same("discrete.count", at, false))
                        failures.Add($"{at}: vertex count {generator.VertexCount} vs {mine.Counts.Vertices}");

                    return 1;
                }

                Vector3[] positions = stock.vertices;
                Vector2[] uvs = stock.uv;
                Color32[] colors = stock.colors32;
                for (int i = 0; i < generator.VertexCount; i++)
                {
                    SkeletonVertex v = mine.Vertices[i];
                    if (!AnimationParityTests.SameVertex(at, positions[i], uvs[i], colors[i], v, true))
                    {
                        failures.Add(
                            $"{at}: vertex {i} position {positions[i]} vs {v.Position}, uv {uvs[i]} vs {v.Uv}, " +
                            $"colour {colors[i]} vs ({v.R}, {v.G}, {v.B}, {v.A})");
                        return 1;
                    }
                }

                List<int> stockIndices = new();
                for (int s = 0; s < stock.subMeshCount; s++) stockIndices.AddRange(stock.GetIndices(s));
                if (!ParityDrift.Same("discrete.indices", at,
                        stockIndices.SequenceEqual(mine.Indices.Select(x => (int)x))))
                    failures.Add($"{at}: indices differ ({stockIndices.Count} vs {mine.Indices.Length})");

                return generator.VertexCount + 1;
            }
            finally
            {
                Object.DestroyImmediate(stock);
            }
        }
    }
}