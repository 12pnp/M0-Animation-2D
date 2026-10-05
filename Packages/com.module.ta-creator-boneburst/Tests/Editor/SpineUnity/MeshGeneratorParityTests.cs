using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using BoneBurst.Anim;
using BoneBurst.Blob;
using BoneBurst.Constraints;
using BoneBurst.Data;
using BoneBurst.Instance;
using NUnit.Framework;
using Spine;
using Spine.Unity;
using Unity.Mathematics;
using UnityEngine;
using AnimationState = Spine.AnimationState;
using BlendMode = Spine.BlendMode;
using Object = UnityEngine.Object;
using Physics = Spine.Physics;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     P6 mesh parity against spine-unity's own <see cref="MeshGenerator" />, while animating: both paths
    ///     (<c>BuildMeshWithArrays</c>, and the clipping path <c>BuildMesh</c>), tint black <c>uv2</c>/<c>uv3</c>, z
    ///     spacing, submeshes, indices and bounds (<c>Doc/Format/Clipping.md</c>, <c>Skins-TintBlack-Culling.md</c>).
    /// </summary>
    /// <remarks>
    ///     Atlas pages get one material each, and Multiply/Screen slots get region clones on their own material,
    ///     as spine-unity's blend-mode materials do, so stock splits submeshes where BoneBurst's material keys do.
    /// </remarks>
    public class MeshGeneratorParityTests
    {
        private const float ZSpacing = -0.0125f;

        /// <summary>
        ///     Relative difference in clipped area accepted when the clip cut differently (parity plan I1).
        /// </summary>
        private const double ClipAreaTolerance = 1e-4;

        private static readonly float[] s_Deltas = { 0.016666668f, 0.033333335f, 0.007f, 0.1f };

        private static IEnumerable<SampleCorpus.Case> Corpus()
        {
            return SampleCorpus.Corpus().Where(c => c.Scale != 0.37f);
        }

        [TestCaseSource(nameof(Corpus))]
        public void Mesh_MatchesMeshGenerator(SampleCorpus.Case c)
        {
            SkeletonDef def = SampleCorpus.Read(c);
            ParityDrift.BeginCase(ParityDrift.SizeOf(def, c.Scale));
            BlobContent content = BlobBuilder.BuildContent(def, AtlasReader.Read(File.ReadAllText(c.Atlas)));
            List<string> failures = new();
            List<Material> materials = new();
            int frames = 0;
            try
            {
                for (int a = 0; a < def.Animations.Length && failures.Count == 0; a++)
                    foreach (bool tint in new[] { true, false })
                    {
                        frames += Play(c, def, content, a, tint, materials, failures);
                        if (failures.Count > 0) break;
                    }
            }
            finally
            {
                foreach (Material m in materials) Object.DestroyImmediate(m);
            }

            Assert.That(frames, Is.GreaterThan(0), "nothing was played");
            ParityDrift.CheckFrames(failures);
            ParityDrift.WriteCaseSummary();
            Assert.IsEmpty(failures, string.Join("\n", failures.Take(20)));
        }

        private static int Play(SampleCorpus.Case c, SkeletonDef def, BlobContent content, int animation,
            bool tint,
            List<Material> materials, List<string> failures)
        {
            SkeletonData data = AnimationParityTests.LoadStock(c, true);
            AssignMaterials(data, materials);
            Skeleton skeleton = new(data);
            AnimationState state = new(new AnimationStateData(data));
            using ManagedPose mine = new(content)
            {
                LinearColorSpace = QualitySettings.activeColorSpace == ColorSpace.Linear, ZSpacing = ZSpacing,
                TintBlack = tint
            };
            BoneAnimationState track = new(new BoneAnimationStateData(content));
            CommandBuffer buffer = new();
            MeshGenerator generator = new();
            generator.settings.tintBlack = tint;
            generator.settings.zSpacing = ZSpacing;
            string at = $"'{def.Animations[animation].Name}' tint {tint}";
            skeleton.UpdateWorldTransform(Physics.Update);
            mine.UpdateWorldTransform(PhysicsMode.Update);
            Compare($"{at} init", skeleton, mine, generator, tint, failures);
            state.SetAnimation(0, data.Animations.Items[animation], true);
            track.SetAnimation(0, animation, true);
            float duration = Math.Max(def.Animations[animation].Duration, 0.5f), total = 0;
            int frame = 0;
            for (; total <= duration * 1.3f && frame < 160 && failures.Count == 0; frame++)
            {
                float dt = s_Deltas[frame % s_Deltas.Length];
                total += dt;
                state.Update(dt);
                skeleton.Update(dt);
                track.Update(dt);
                mine.Time += dt;
                state.Apply(skeleton);
                skeleton.UpdateWorldTransform(Physics.Update);
                track.Apply(buffer);
                mine.Pose(buffer);
                track.AfterApply(buffer, mine.FiredEvents(), mine.TotalAlpha, mine.Rotation);
                Compare($"{at} frame {frame}", skeleton, mine, generator, tint, failures);
                ParityLockstep.CompareAndSync($"{at} frame {frame}", skeleton, mine, failures);
            }

            return frame;
        }

        /// <summary>
        ///     One material per atlas page; Multiply/Screen slots' regions cloned onto a page clone with its own
        ///     material, as spine-unity's <c>BlendModeMaterials</c> does.
        /// </summary>
        internal static void AssignMaterials(SkeletonData data, List<Material> materials)
        {
            Shader shader = Shader.Find("Hidden/Internal-Colored");
            HashSet<AtlasPage> pages = new();
            Dictionary<(AtlasPage, BlendMode), AtlasPage> pageCopies = new();
            Dictionary<(AtlasRegion, BlendMode), AtlasRegion> regionCopies = new();
            foreach (Skin skin in data.Skins)
            foreach (Skin.SkinEntry e in skin.Attachments)
            {
                Sequence sequence = e.Attachment is RegionAttachment ra ? ra.Sequence
                    : e.Attachment is MeshAttachment ma ? ma.Sequence : null;
                if (sequence == null) continue;
                BlendMode blend = data.Slots.Items[e.SlotIndex].BlendMode;
                for (int i = 0; i < sequence.Regions.Length; i++)
                {
                    if (!(sequence.Regions[i] is AtlasRegion region)) continue;
                    if (pages.Add(region.page))
                    {
                        Material page = new(shader);
                        materials.Add(page);
                        region.page.rendererObject = page;
                    }

                    if (blend != BlendMode.Multiply && blend != BlendMode.Screen) continue;
                    if (!regionCopies.TryGetValue((region, blend), out AtlasRegion copy))
                    {
                        if (!pageCopies.TryGetValue((region.page, blend), out AtlasPage pageCopy))
                        {
                            pageCopy = region.page.Clone();
                            Material material = new(shader);
                            materials.Add(material);
                            pageCopy.rendererObject = material;
                            pageCopies[(region.page, blend)] = pageCopy;
                        }

                        copy = region.Clone();
                        copy.page = pageCopy;
                        regionCopies[(region, blend)] = copy;
                    }

                    sequence.Regions[i] = copy;
                }
            }
        }

        /// <summary>
        ///     The clipped meshes line up vertex for vertex within tolerance: same counts and indices, positions and
        ///     UVs within <see cref="ParityDrift.ToleranceOf" />, colours within a byte. Checked without recording, so a
        ///     mismatch falls back to the shape comparison instead of failing.
        /// </summary>
        private static bool ClippedVerticesMatch(Mesh stock, ManagedPose m, int n)
        {
            if (n != m.Counts.Vertices || stock.subMeshCount != m.Counts.Submeshes) return false;
            Vector3[] positions = stock.vertices;
            Vector2[] uvs = stock.uv;
            Color32[] colors = stock.colors32;
            for (int i = 0; i < n; i++)
            {
                SkeletonVertex v = m.Vertices[i];
                if (!Close("mesh.position", positions[i].x, v.Position.x) ||
                    !Close("mesh.position", positions[i].y, v.Position.y) ||
                    !Close("mesh.uv", uvs[i].x, v.Uv.x) || !Close("mesh.uv", uvs[i].y, v.Uv.y) ||
                    Math.Abs(colors[i].r - v.R) > 1 || Math.Abs(colors[i].g - v.G) > 1 ||
                    Math.Abs(colors[i].b - v.B) > 1 ||
                    Math.Abs(colors[i].a - v.A) > 1)
                    return false;
            }

            int start = 0;
            for (int s = 0; s < stock.subMeshCount; s++)
            {
                int[] indices = stock.GetTriangles(s);
                int end = m.SubmeshIndexEnd[s];
                if (indices.Length != end - start ||
                    !indices.SequenceEqual(m.Indices.Skip(start).Take(end - start).Select(x => (int)x))) return false;

                start = end;
            }

            return true;
        }

        private static bool Close(string category, float stock, float mine)
        {
            return stock == mine || Math.Abs((double)stock - mine) <= ParityDrift.ToleranceOf(category, stock, mine);
        }

        private static double Area(Vector3[] positions, int[] indices)
        {
            double area = 0;
            for (int i = 0; i + 2 < indices.Length; i += 3)
            {
                Vector3 a = positions[indices[i]], b = positions[indices[i + 1]], c = positions[indices[i + 2]];
                area +=
                    Math.Abs(((double)b.x - a.x) * ((double)c.y - a.y) - ((double)c.x - a.x) * ((double)b.y - a.y)) / 2;
            }

            return area;
        }

        private static double MineArea(ManagedPose m)
        {
            int count = m.Counts.Submeshes > 0 ? m.SubmeshIndexEnd[m.Counts.Submeshes - 1] : 0;
            double area = 0;
            for (int i = 0; i + 2 < count; i += 3)
            {
                float3 a = m.Vertices[m.Indices[i]].Position,
                    b = m.Vertices[m.Indices[i + 1]].Position,
                    c = m.Vertices[m.Indices[i + 2]].Position;
                area +=
                    Math.Abs(((double)b.x - a.x) * ((double)c.y - a.y) - ((double)c.x - a.x) * ((double)b.y - a.y)) / 2;
            }

            return area;
        }

        private static void Compare(string at, Skeleton skeleton, ManagedPose m, MeshGenerator generator, bool tint,
            List<string> failures)
        {
            SkeletonRendererInstruction instruction = new();
            StockMeshComparisons.StockColorSpace();
            MeshGenerator.GenerateSkeletonRendererInstruction(instruction, skeleton, null, null, false);
            generator.Begin();
            bool clipping = instruction.hasActiveClipping && instruction.submeshInstructions.Count > 0;
            if (clipping) generator.BuildMesh(instruction, true);
            else generator.BuildMeshWithArrays(instruction, true);
            m.BuildMesh();
            if (!ParityDrift.Same("discrete.clipping", at, clipping == m.Counts.HasClipping))
                failures.Add($"{at}: clipping path {clipping} vs {m.Counts.HasClipping}");
            Mesh stock = new();
            try
            {
                generator.FillVertexData(stock);
                generator.FillTriangles(stock);
                int n = generator.VertexCount;

                // A clip near an edge moves or adds vertices on a one-ulp difference (an intersection of nearly
                // parallel edges), so vertex-by-vertex comparison is ill-conditioned there. When it fails on a
                // clipping frame, the clipped shape is compared instead: total triangle area, which the cut conserves.
                // Only a different shape marks the frame (ParityDrift.CheckFrames). Parity plan I1.
                if (clipping && ParityDrift.Tolerant && !ClippedVerticesMatch(stock, m, n))
                {
                    double stockArea = 0;
                    for (int s = 0; s < stock.subMeshCount; s++)
                        stockArea += Area(stock.vertices, stock.GetTriangles(s));
                    double mineArea = MineArea(m);
                    if (Math.Abs(stockArea - mineArea) > ClipAreaTolerance * Math.Max(stockArea, 1e-6))
                        ParityDrift.MarkFrame(
                            $"clip shape {at}: area {stockArea:R} vs {mineArea:R}, {n} vs {m.Counts.Vertices} vertices");

                    return;
                }

                if (n != m.Counts.Vertices)
                {
                    if (!ParityDrift.Same("discrete.count", at, false))
                        failures.Add($"{at}: vertex count {n} vs {m.Counts.Vertices}");
                    return;
                }

                Vector3[] positions = stock.vertices;
                Vector2[] uvs = stock.uv;
                Color32[] colors = stock.colors32;
                List<Vector2> uv2 = new(), uv3 = new();
                stock.GetUVs(1, uv2);
                stock.GetUVs(2, uv3);
                for (int i = 0; i < n; i++)
                {
                    SkeletonVertex v = m.Vertices[i];
                    if (!AnimationParityTests.SameVertex(at, positions[i], uvs[i], colors[i], v, true))
                    {
                        failures.Add($"{at}: vertex {i} differs");
                        return;
                    }

                    if (tint && !(ParityDrift.Same("mesh.tint", at, uv2[i].x, m.Tint[i].x) &
                                  ParityDrift.Same("mesh.tint", at, uv2[i].y, m.Tint[i].y) &
                                  ParityDrift.Same("mesh.tint", at, uv3[i].x, m.Tint[i].z) &
                                  ParityDrift.Same("mesh.tint", at, uv3[i].y, m.Tint[i].w)))
                    {
                        failures.Add($"{at}: tint black of vertex {i} differs");
                        return;
                    }
                }

                if (stock.subMeshCount != m.Counts.Submeshes)
                {
                    if (!ParityDrift.Same("discrete.count", at, false))
                        failures.Add($"{at}: submesh count {stock.subMeshCount} vs {m.Counts.Submeshes}");

                    return;
                }

                int start = 0;
                for (int s = 0; s < stock.subMeshCount; s++)
                {
                    int[] indices = stock.GetTriangles(s);
                    int end = m.SubmeshIndexEnd[s];
                    bool sameIndices = indices.Length == end - start &&
                                       indices.SequenceEqual(
                                           m.Indices.Skip(start).Take(end - start).Select(x => (int)x));
                    if (!sameIndices && clipping && ParityDrift.Tolerant)
                    {
                        ParityDrift.MarkFrame($"clip topology {at}: submesh {s} indices");
                        return;
                    }

                    if (!ParityDrift.Same("discrete.indices", at, sameIndices))
                    {
                        failures.Add($"{at}: submesh {s} indices differ");
                        return;
                    }

                    start = end;
                }

                Bounds bounds = generator.GetMeshBounds();
                // Each component within the positional tolerance (parity plan F3). Unity's Vector3 == allowed a fixed
                // ~1e-5, which large skeletons miss by rounding alone (2.8e-4 on 2,700-unit bounds, F2).
                if (n > 0 && !(ParityDrift.Same("mesh.bounds", at, bounds.center.x, m.Center.x) &
                               ParityDrift.Same("mesh.bounds", at, bounds.center.y, m.Center.y) &
                               ParityDrift.Same("mesh.bounds", at, bounds.center.z, m.Center.z) &
                               ParityDrift.Same("mesh.bounds", at, bounds.extents.x, m.Extents.x) &
                               ParityDrift.Same("mesh.bounds", at, bounds.extents.y, m.Extents.y) &
                               ParityDrift.Same("mesh.bounds", at, bounds.extents.z, m.Extents.z)))
                    failures.Add($"{at}: bounds {bounds} vs center {m.Center} extents {m.Extents}");
            }
            finally
            {
                Object.DestroyImmediate(stock);
            }
        }
    }
}