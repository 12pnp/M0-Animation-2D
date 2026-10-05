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
using Unity.Mathematics;
using Random = System.Random;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     P7 GPU skinning parity (<c>Doc/Format/GpuSkinning.md</c>): every frame, the static GPU mesh and pose
    ///     record, evaluated with the vertex shader's arithmetic (<see cref="Skin" />, a transcription of
    ///     <c>BoneBurstCommon.hlsl</c>'s <c>BoneBurstSkin</c>), equal the CPU mesh bit for bit, and the GPU bounds
    ///     contain every CPU vertex. The CPU mesh is itself at parity with spine-unity (MeshGeneratorParityTests, in
    ///     the spine-unity test assembly).
    /// </summary>
    /// <remarks>
    ///     Random scripts force topology changes (animation switches with mixing, skin combines, set attachment,
    ///     setup-pose slots, one attachment shown on two slots then swapped in draw order, z spacing changes); a
    ///     change the topology key misses shows up as a mismatch. A frame that falls back to the CPU must have a
    ///     reason (clipping, or deform on a rendered slot).
    /// </remarks>
    public class GpuSkinningParityTests
    {
        private static readonly float[] s_Deltas = { 0.016666668f, 0.033333335f, 0.007f, 0.1f };

        [ThreadStatic]
        private static int s_Frames, s_ClippingFallbacks;

        private static IEnumerable<SampleCorpus.Case> Corpus()
        {
            return SampleCorpus.Corpus().Where(c => c.Scale != 0.37f);
        }

        [TestCaseSource(nameof(Corpus))]
        public void GpuMesh_MatchesCpuMesh(SampleCorpus.Case c)
        {
            SkeletonDef def = SampleCorpus.Read(c);
            if (def.Animations.Length == 0) Assert.Pass("no animations");
            BlobContent content = BlobBuilder.BuildContent(def, AtlasReader.Read(File.ReadAllText(c.Atlas)));
            List<string> failures = new();
            int gpuFrames = 0;
            s_Frames = s_ClippingFallbacks = 0;
            for (int seed = 0; seed < 4 && failures.Count == 0; seed++)
                gpuFrames += Run(def, content, seed, seed >= 2, failures);

            Assert.IsEmpty(failures, string.Join("\n", failures.Take(20)));
            if (gpuFrames == 0 && s_Frames > 0 && s_ClippingFallbacks == s_Frames)
                // Not a pass: nothing was compared. Every frame clips, and clipping always takes the CPU path.
                Assert.Ignore(
                    $"all {s_Frames} frames clip, so the GPU path is never eligible; each CPU fallback was checked to have clipping");

            Assert.That(gpuFrames, Is.GreaterThan(0), "no frame took the GPU path");
        }

        private static int Run(SkeletonDef def, BlobContent content, int seed, bool tint, List<string> failures)
        {
            Random random = new(seed * 7919 + def.Slots.Length);
            int skin = def.Skins.Length > 1 ? random.Next(-1, def.Skins.Length) : -1;
            using ManagedPose mine = new(content, skin)
            {
                LinearColorSpace = false, ZSpacing = seed % 2 == 0 ? -0.0125f : 0, TintBlack = tint
            };
            BoneAnimationState track = new(new BoneAnimationStateData(content) { DefaultMix = 0.2f });
            CommandBuffer buffer = new();
            (int a, int b)? pendingSwap = null;
            mine.UpdateWorldTransform(PhysicsMode.Update);
            int gpuFrames = Frame($"seed {seed} setup", mine, failures) ? 1 : 0;
            track.SetAnimation(0, random.Next(def.Animations.Length), true);
            for (int frame = 0; frame < 150 && failures.Count == 0; frame++)
            {
                if (pendingSwap is (int sa, int sb))
                {
                    int ia = Array.IndexOf(mine.DrawOrder, sa), ib = Array.IndexOf(mine.DrawOrder, sb);
                    (mine.DrawOrder[ia], mine.DrawOrder[ib]) = (mine.DrawOrder[ib], mine.DrawOrder[ia]);
                    pendingSwap = null;
                }

                if (random.NextDouble() < 0.08) Act(random, def, content, mine, track, ref pendingSwap);
                float dt = s_Deltas[frame % s_Deltas.Length];
                track.Update(dt);
                mine.Time += dt;
                track.Apply(buffer);
                mine.Pose(buffer);
                track.AfterApply(buffer, mine.FiredEvents(), mine.TotalAlpha, mine.Rotation);
                if (Frame($"seed {seed} frame {frame}", mine, failures)) gpuFrames++;
            }

            return gpuFrames;
        }

        private static void Act(Random random, SkeletonDef def, BlobContent content, ManagedPose mine,
            BoneAnimationState track, ref (int, int)? pendingSwap)
        {
            switch (random.Next(7))
            {
                case 0:
                case 1:
                    track.SetAnimation(0, random.Next(def.Animations.Length), random.Next(2) == 0);
                    break;
                case 2:
                {
                    if (content.Skins.Length < 2) break;
                    BoneBurstSkin look = new("look", content);
                    for (int p = 1 + random.Next(3); p > 0; p--)
                        look.AddSkin(content.Skins[random.Next(content.Skins.Length)]);

                    mine.SetSkin(look);
                    if (random.Next(2) == 0) mine.SetupPoseSlots();
                    break;
                }
                case 3:
                {
                    int slot = random.Next(def.Slots.Length);
                    BoneBurstSkin source = mine.Skin ?? content.DefaultSkin;
                    if (source == null || random.Next(4) == 0)
                    {
                        mine.SetAttachment(slot, -1);
                        break;
                    }

                    (int slot, string placeholder, int attachment)[] entries = source.Entries().ToArray();
                    if (entries.Length == 0) break;
                    (int s, string placeholder, int _) = entries[random.Next(entries.Length)];
                    int resolved = content.ResolveAttachment(mine.Skin, s, placeholder);
                    if (resolved >= 0) mine.SetAttachment(s, resolved);
                    break;
                }
                case 5:
                {
                    // One attachment on two slots, swapped next frame: only the slot key tells them apart.
                    int a = random.Next(def.Slots.Length), b = random.Next(def.Slots.Length);
                    int shown = mine.Slots[a].Attachment;
                    if (a == b || shown < 0) break;
                    AttachmentKind kind = content.Attachments[shown].Kind;
                    if (kind != AttachmentKind.Region && kind != AttachmentKind.Mesh &&
                        kind != AttachmentKind.LinkedMesh) break;
                    mine.SetAttachment(b, shown);
                    pendingSwap = (a, b);
                    break;
                }
                case 6:
                    mine.ZSpacing = mine.ZSpacing == 0 ? -0.0125f : 0;
                    break;
                default:
                    mine.SetupPoseSlots();
                    break;
            }
        }

        /// <summary>
        ///     One frame: GPU path, then CPU mesh, compared. True when the frame took the GPU path.
        /// </summary>
        private static bool Frame(string at, ManagedPose m, List<string> failures)
        {
            s_Frames++;
            GpuMeshState state = m.GpuFrame();
            float3 center = m.Center, extents = m.Extents;
            m.BuildMesh();
            if (state == GpuMeshState.NeedsCpu)
            {
                bool deform = false;
                for (int i = 0; i < m.Slots.Length; i++)
                {
                    SlotState s = m.AppliedSlots[i];
                    if (s.Attachment < 0 || s.DeformCount == 0 || s.Color.w == 0 ||
                        !m.BoneActive[m.Content.SlotSetups[i].Bone]) continue;
                    AttachmentKind k = m.Content.Attachments[s.Attachment].Kind;
                    deform |= k == AttachmentKind.Region || k == AttachmentKind.Mesh || k == AttachmentKind.LinkedMesh;
                }

                if (!m.Counts.HasClipping && !deform) failures.Add($"{at}: CPU fallback without clipping or deform");
                if (m.Counts.HasClipping) s_ClippingFallbacks++;
                return false;
            }

            int n = m.Counts.Vertices;
            if (m.Counts.HasClipping) failures.Add($"{at}: GPU path on a clipping frame");
            if (n != m.GpuCounts.Vertices || m.Counts.Submeshes != m.GpuCounts.Submeshes ||
                !m.Indices.Take(m.Counts.Indices).SequenceEqual(m.GpuIndices.Take(m.GpuCounts.Indices)))
            {
                failures.Add($"{at}: vertex count, submeshes or indices differ");
                return true;
            }

            for (int k = 0; k < n; k++)
            {
                SkeletonVertex cpu = m.Vertices[k], gpu = m.GpuVertices[k];
                float3 p = gpu.Position;
                Skin(m.GpuSkinData[k], ref p, out float4 color, out float4 tint, m.GpuRecord, m.GpuInfluences,
                    m.TintBlack);
                bool same = Bits(p.x) == Bits(cpu.Position.x) && Bits(p.y) == Bits(cpu.Position.y) &&
                            Bits(p.z) == Bits(cpu.Position.z) && Bits(gpu.Uv.x) == Bits(cpu.Uv.x) &&
                            Bits(gpu.Uv.y) == Bits(cpu.Uv.y) && Byte(color.x) == cpu.R && Byte(color.y) == cpu.G &&
                            Byte(color.z) == cpu.B && Byte(color.w) == cpu.A;
                if (m.TintBlack) same &= math.all(tint == m.Tint[k]);
                if (!same)
                {
                    failures.Add($"{at}: vertex {k} differs: cpu {cpu.Position} gpu {p}");
                    return true;
                }
            }

            if (n > 0)
            {
                float3 lo = center - extents, hi = center + extents;
                if (m.Min.x < lo.x || m.Min.y < lo.y || m.Max.x > hi.x || m.Max.y > hi.y)
                    failures.Add($"{at}: GPU bounds {lo}..{hi} miss CPU vertices {m.Min}..{m.Max}");

                if (extents.z != m.Extents.z) failures.Add($"{at}: GPU bounds z {extents.z} vs {m.Extents.z}");
            }

            return true;
        }

        /// <summary>
        ///     <c>BoneBurstCommon.hlsl</c> <c>BoneBurstSkin</c>, operation for operation (pose base 0).
        /// </summary>
        private static void Skin(float4 skin, ref float3 position, out float4 color, out float4 tint, float4[] pose,
            float4[] influences, bool tintBlack)
        {
            uint count = (uint)skin.y;
            float2 world;
            if (count == 0)
            {
                uint bone = 2 * (uint)skin.z;
                float4 m = pose[bone];
                float4 t = pose[bone + 1];
                world = new float2(position.x * m.x + position.y * m.y + t.x,
                    position.x * m.z + position.y * m.w + t.y);
            }
            else
            {
                world = new float2(0, 0);
                uint first = (uint)skin.x;
                for (uint i = 0; i < count; i++)
                {
                    float4 influence = influences[first + i];
                    uint bone = 2 * (uint)influence.w;
                    float4 m = pose[bone];
                    float4 t = pose[bone + 1];
                    world.x += (influence.x * m.x + influence.y * m.y + t.x) * influence.z;
                    world.y += (influence.x * m.z + influence.y * m.w + t.y) * influence.z;
                }
            }

            position.xy = world;
            uint slot = (uint)skin.w;
            color = pose[slot];
            tint = tintBlack ? pose[slot + 1] : float4.zero;
        }

        private static int Bits(float value)
        {
            return BitConverter.SingleToInt32Bits(value);
        }

        /// <summary>
        ///     The byte a UNorm8 attribute holding <paramref name="value" /> came from.
        /// </summary>
        private static byte Byte(float value)
        {
            return (byte)math.round(value * 255);
        }
    }
}