using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using BoneBurst.Anim;
using BoneBurst.Blob;
using BoneBurst.Data;
using BoneBurst.Instance;
using NUnit.Framework;
using Spine;
using UnityEngine;
using Animation = Spine.Animation;
using AnimationState = Spine.AnimationState;
using Physics = Spine.Physics;

namespace BoneBurst.Tests
{
    /// <summary>
    ///     P3 parity: every animation of every corpus file, played by stock <see cref="AnimationState" /> and by
    ///     <see cref="BoneAnimationState" /> + <see cref="TimelineApply" />, frame by frame with identical deltas.
    /// </summary>
    /// <remarks>
    ///     Both sides run spine-unity's frame: <c>state.Update</c>, <c>skeleton.Update</c>, <c>state.Apply</c>, then
    ///     <c>UpdateWorldTransform(Physics.Update)</c>. Pass A keeps constraints and compares what timelines write:
    ///     bone locals, slot state (colour, attachment, sequence index, deform), draw order, constraint poses, and
    ///     delivered events with Complete. Pass B removes constraints on both sides and compares world transforms
    ///     and (spine-unity's mesh, through <see cref="StockMeshCompare" /> when that assembly is present) while
    ///     animating; constraint solving itself is
    ///     <see cref="ConstraintParityTests" />. Each run switches to another animation part-way (mix duration 0).
    /// </remarks>
    public class AnimationParityTests
    {
        private const int SwitchFrame = 23;
        private static readonly float[] s_Deltas = { 0.016666668f, 0.033333335f, 0.007f, 0.1f, 0.016666668f, 0.25f };

        /// <summary>
        ///     The mesh half of <see cref="CompareWorldAndMesh" />: spine-unity's mesh against BoneBurst's. Installed
        ///     at editor load by the spine-unity test assembly (<c>Module.TA.BoneBurst.Tests.SpineUnity</c>); null in
        ///     the strict-float harness and in any project without that assembly, where the world-transform half alone
        ///     runs.
        /// </summary>
        internal static Action<string, Skeleton, ManagedPose, List<string>> StockMeshCompare;

        private static IEnumerable<SampleCorpus.Case> Corpus()
        {
            // One scale per file: scale only reaches timelines through values the reader already checks.
            return SampleCorpus.Corpus().Where(c => c.Scale != 0.37f);
        }

        [TestCaseSource(nameof(Corpus))]
        public void Animations_MatchStock(SampleCorpus.Case c)
        {
            SkeletonDef def = c.Skeleton.EndsWith(".json")
                ? SkeletonJsonReader.Read(File.ReadAllText(c.Skeleton), c.Scale)
                : SkeletonBinaryReader.Read(File.ReadAllBytes(c.Skeleton), c.Scale);
            ParityDrift.BeginCase(ParityDrift.SizeOf(def, c.Scale));
            BlobContent content = BlobBuilder.BuildContent(def, AtlasReader.Read(File.ReadAllText(c.Atlas)));
            BlobContent bare = BareContent(c);
            Assert.That(def.Animations.Length, Is.GreaterThan(0), "no animations to compare");

            List<string> failures = new();
            int frames = 0;
            for (int a = 0; a < def.Animations.Length; a++)
                foreach (bool loop in new[] { true, false })
                {
                    frames += Play(c, def, content, a, loop, true, failures);
                    frames += Play(c, def, bare, a, loop, false, failures);
                    if (failures.Count > 30) break;
                }

            Assert.That(frames, Is.GreaterThan(0), "nothing was played");
            ParityDrift.CheckFrames(failures);
            ParityDrift.WriteCaseSummary();
            Assert.IsEmpty(failures, string.Join("\n", failures.Take(30)));
        }

        private static int Play(SampleCorpus.Case c, SkeletonDef def, BlobContent content, int animation,
            bool loop,
            bool keepConstraints, List<string> failures)
        {
            SkeletonData data = LoadStock(c, keepConstraints);
            Skeleton skeleton = new(data);
            AnimationState state = new(new AnimationStateData(data));
            List<string> stockEvents = new(), myEvents = new();
            state.Event += (entry, e) => stockEvents.Add($"{e.Data.Name}@{e.Time:R}/{e.Int}/{e.Float:R}/{e.String}");
            state.Complete += entry => stockEvents.Add("complete");

            ManagedPose mine = new(content, -1)
            {
                LinearColorSpace = QualitySettings.activeColorSpace == ColorSpace.Linear
            };
            BoneAnimationState track = new(new BoneAnimationStateData(content));
            CommandBuffer buffer = new();
            track.Event += (_, e) => myEvents.Add($"{e.Name}@{e.Time:R}/{e.Int}/{e.Float:R}/{e.String}");
            track.Complete += _ => myEvents.Add("complete");
            string at =
                $"'{def.Animations[animation].Name}' {(loop ? "loop" : "once")}{(keepConstraints ? "" : " no-constraints")}";

            state.SetAnimation(0, data.Animations.Items[animation], loop);
            track.SetAnimation(0, animation, loop);
            int other = (animation + 1) % def.Animations.Length;
            float duration = Math.Max(def.Animations[animation].Duration, 0.1f), total = 0;
            int frame = 0;
            for (; total <= duration * 2.3f && frame < 300; frame++)
            {
                float dt = s_Deltas[frame % s_Deltas.Length];
                total += dt;
                if (frame == SwitchFrame && def.Animations.Length > 1)
                {
                    state.SetAnimation(0, data.Animations.Items[other], loop);
                    track.SetAnimation(0, other, loop);
                }

                state.Update(dt);
                skeleton.Update(dt);
                state.Apply(skeleton);
                skeleton.UpdateWorldTransform(Physics.Update);
                track.Update(dt);
                mine.Time += dt;
                track.Apply(buffer);
                mine.Pose(buffer);
                track.AfterApply(buffer, mine.FiredEvents(), mine.TotalAlpha, mine.Rotation);

                int before = failures.Count;
                if (keepConstraints)
                    ComparePose($"{at} frame {frame}", skeleton, mine, def, failures);
                else
                    CompareWorldAndMesh($"{at} frame {frame}", skeleton, mine, def, failures);

                ParityLockstep.CompareAndSync($"{at} frame {frame}", skeleton, mine, failures);
                if (failures.Count > before) break;
            }

            if (keepConstraints && !ParityDrift.Same("discrete.events", at, stockEvents.SequenceEqual(myEvents)))
                failures.Add(
                    $"{at}: events differ\n  stock {string.Join(", ", stockEvents)}\n  new   {string.Join(", ", myEvents)}");

            return frame;
        }

        internal static void ComparePose(string at, Skeleton skeleton, ManagedPose m, SkeletonDef def,
            List<string> failures)
        {
            ParityConditioning.Mark(skeleton, m.Content.Skeleton);
            for (int i = 0; i < def.Bones.Length; i++)
            {
                BonePose p = skeleton.Bones.Items[i].Pose;
                BoneLocal l = m.Local[i];
                if (!SameLocal("local", at, p, l))
                {
                    failures.Add($"{at}: bone {def.Bones[i].Name} local differs");
                    return;
                }
            }

            for (int i = 0; i < def.Slots.Length; i++)
            {
                SlotPose p = skeleton.Slots.Items[i].Pose;
                SlotState s = m.Slots[i];
                Color color = p.GetColor();
                if (!(ParityDrift.Same("slot.color", at, color.r, s.Color.x) &
                      ParityDrift.Same("slot.color", at, color.g, s.Color.y) &
                      ParityDrift.Same("slot.color", at, color.b, s.Color.z) &
                      ParityDrift.Same("slot.color", at, color.a, s.Color.w)))
                {
                    failures.Add($"{at}: slot {def.Slots[i].Name} colour {color} vs {s.Color}");
                    return;
                }

                Color? dark = p.GetDarkColor();
                if (dark.HasValue && s.HasDarkColor &&
                    !(ParityDrift.Same("slot.dark", at, dark.Value.r, s.DarkColor.x) &
                      ParityDrift.Same("slot.dark", at, dark.Value.g, s.DarkColor.y) &
                      ParityDrift.Same("slot.dark", at, dark.Value.b, s.DarkColor.z)))
                {
                    failures.Add($"{at}: slot {def.Slots[i].Name} dark colour differs");
                    return;
                }

                string mineName = s.Attachment < 0 ? null : m.Content.AttachmentDefs[s.Attachment].Name;
                if (!ParityDrift.Same("discrete.attachment", at, p.Attachment?.Name == mineName &&
                                                                 p.SequenceIndex == s.SequenceIndex &&
                                                                 p.Deform.Count == s.DeformCount))
                {
                    failures.Add($"{at}: slot {def.Slots[i].Name} attachment/sequence/deform count differs");
                    return;
                }

                if (p.Deform.Count != s.DeformCount) continue; // measuring: the deform arrays do not line up
                int start = m.Content.SlotDeformStart[i];
                for (int k = 0; k < s.DeformCount; k++)
                    if (!ParityDrift.Same("deform", at, p.Deform.Items[k], m.Deform[start + k]))
                    {
                        failures.Add($"{at}: slot {def.Slots[i].Name} deform[{k}] differs");
                        return;
                    }
            }

            ExposedList<Slot> order = skeleton.DrawOrder.Pose;
            for (int i = 0; i < order.Count; i++)
                if (!ParityDrift.Same("discrete.draworder", at, order.Items[i].Data.Index == m.DrawOrder[i]))
                {
                    failures.Add($"{at}: draw order differs at {i}");
                    return;
                }

            for (int i = 0; i < def.Constraints.Length; i++)
            {
                object pose = Member(skeleton.Constraints.Items[i], "Pose");
                ConstraintPose mp = m.Constraints[i];
                float[] stock, mine;
                switch (def.Constraints[i].Kind)
                {
                    case ConstraintKind.Ik:
                        stock = Floats(pose, "Mix", "Softness", "BendDirection", "Compress", "Stretch");
                        mine = new[]
                            { mp.Mix, mp.Softness, mp.BendDirection, mp.Compress ? 1f : 0, mp.Stretch ? 1f : 0 };
                        break;
                    case ConstraintKind.Transform:
                        stock = Floats(pose, "MixRotate", "MixX", "MixY", "MixScaleX", "MixScaleY", "MixShearY");
                        mine = new[] { mp.MixRotate, mp.MixX, mp.MixY, mp.MixScaleX, mp.MixScaleY, mp.MixShearY };
                        break;
                    case ConstraintKind.Path:
                        stock = Floats(pose, "Position", "Spacing", "MixRotate", "MixX", "MixY");
                        mine = new[] { mp.Position, mp.Spacing, mp.MixRotate, mp.MixX, mp.MixY };
                        break;
                    case ConstraintKind.Physics:
                        stock = Floats(pose, "Inertia", "Strength", "Damping", "MassInverse", "Wind", "Gravity", "Mix");
                        mine = new[]
                            { mp.Inertia, mp.Strength, mp.Damping, mp.MassInverse, mp.Wind, mp.Gravity, mp.Mix };
                        break;
                    default:
                        stock = Floats(pose, "Time", "Mix");
                        mine = new[] { mp.Time, mp.Mix };
                        break;
                }

                if (!SameAll("constraint", at, stock, mine))
                {
                    failures.Add($"{at}: constraint {def.Constraints[i].Name} pose differs");
                    return;
                }
            }
        }

        internal static void CompareWorldAndMesh(string at, Skeleton skeleton, ManagedPose m, SkeletonDef def,
            List<string> failures)
        {
            ParityConditioning.Mark(skeleton, m.Content.Skeleton);
            for (int i = 0; i < def.Bones.Length; i++)
            {
                Bone bone = skeleton.Bones.Items[i];
                if (!bone.Active) continue;
                BonePose p = bone.AppliedPose;
                BoneWorld w = m.World[i];
                if (!SameWorld(at, def.Bones[i].Name, p, w))
                {
                    failures.Add($"{at}: bone {def.Bones[i].Name} world differs");
                    return;
                }
            }

            StockMeshCompare?.Invoke(at, skeleton, m, failures);
        }

        internal static SkeletonData LoadStock(SampleCorpus.Case c, bool keepConstraints)
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

            if (!keepConstraints)
            {
                data.Constraints.Clear();
                foreach (Skin skin in data.Skins) skin.Constraints.Clear();
                // Constraint timelines index the cleared list; drop them (BareContent drops the same on our side).
                foreach (Animation animation in data.Animations)
                {
                    ExposedList<Timeline> timelines = animation.Timelines;
                    int kept = 0;
                    for (int i = 0; i < timelines.Count; i++)
                    {
                        string type = timelines.Items[i].GetType().Name;
                        if (type.Contains("Constraint") || type.StartsWith("Slider")) continue;
                        timelines.Items[kept++] = timelines.Items[i];
                    }

                    timelines.Count = kept;
                }
            }

            return data;
        }

        /// <summary>
        ///     Our side of pass B: the file with every constraint, skin constraint list and constraint timeline
        ///     removed, as <see cref="LoadStock" /> removes them from stock.
        /// </summary>
        private static BlobContent BareContent(SampleCorpus.Case c)
        {
            SkeletonDef def = c.Skeleton.EndsWith(".json")
                ? SkeletonJsonReader.Read(File.ReadAllText(c.Skeleton), c.Scale)
                : SkeletonBinaryReader.Read(File.ReadAllBytes(c.Skeleton), c.Scale);
            def.Constraints = Array.Empty<ConstraintDef>();
            foreach (SkinDef skin in def.Skins) skin.Constraints = Array.Empty<int>();
            foreach (AnimationDef animation in def.Animations)
                animation.Timelines.RemoveAll(t => t.Kind >= TimelineKind.Ik && t.Kind <= TimelineKind.SliderMix);

            return BlobBuilder.BuildContent(def, AtlasReader.Read(File.ReadAllText(c.Atlas)));
        }

        /// <summary>
        ///     A stock world transform equals BoneBurst's (<see cref="ParityDrift.Same(string, string, float, float)" />:
        ///     equal, or NaN on both sides). An active bone under an inactive, never-posed parent (a skin-required bone
        ///     with no skin) inherits NaN in both runtimes, and <c>NaN != NaN</c> would report that agreement as a
        ///     difference. Every value is compared (no short circuit), so a measurement records all six.
        /// </summary>
        internal static bool SameWorld(string at, string bone, BonePose p, BoneWorld w)
        {
            // The common case, all six bit-equal, counts them without building a label (the suites compare ~10^8
            // values; a string per bone per frame made the Editor suite outlast the Test Runner's timeout).
            if (!ParityDrift.Measuring && Equal(p.A, w.A) && Equal(p.B, w.B) && Equal(p.C, w.C) && Equal(p.D, w.D) &&
                Equal(p.WorldX, w.X) && Equal(p.WorldY, w.Y))
            {
                ParityDrift.CountExact(6);
                return true;
            }

            at = $"{at} bone {bone}";
            ParityDrift.Factor = ParityConditioning.FactorFor(bone);
            bool same = ParityDrift.Same("world.abcd", at, p.A, w.A) & ParityDrift.Same("world.abcd", at, p.B, w.B) &
                        ParityDrift.Same("world.abcd", at, p.C, w.C) & ParityDrift.Same("world.abcd", at, p.D, w.D) &
                        ParityDrift.Same("world.xy", at, p.WorldX, w.X) &
                        ParityDrift.Same("world.xy", at, p.WorldY, w.Y);
            ParityDrift.Factor = 1;
            return same;
        }

        private static bool Equal(float a, float b)
        {
            return a == b || (float.IsNaN(a) && float.IsNaN(b));
        }

        /// <summary>
        ///     A stock local pose equals BoneBurst's. <paramref name="category" />: <c>local</c> or <c>applied</c>.
        /// </summary>
        internal static bool SameLocal(string category, string at, BonePose p, BoneLocal l)
        {
            return ParityDrift.Same(category + ".xy", at, p.X, l.X) & ParityDrift.Same(category + ".xy", at, p.Y, l.Y) &
                   ParityDrift.Same(category + ".rotation", at, p.Rotation, l.Rotation) &
                   ParityDrift.Same(category + ".scale-shear", at, p.ScaleX, l.ScaleX) &
                   ParityDrift.Same(category + ".scale-shear", at, p.ScaleY, l.ScaleY) &
                   ParityDrift.Same(category + ".scale-shear", at, p.ShearX, l.ShearX) &
                   ParityDrift.Same(category + ".scale-shear", at, p.ShearY, l.ShearY) &
                   ParityDrift.Same("discrete.inherit", at, (int)p.Inherit == (int)l.Inherit);
        }

        /// <summary>
        ///     A stock applied pose equals BoneBurst's, compared as the transform it describes: the local matrix
        ///     <c>(a, b, c, d)</c> and the translation. The applied pose is decomposed from a world transform (atan2 and
        ///     square roots); when a bone's scale is near zero its angles are undefined and one ulp moves them anywhere,
        ///     while the matrix stays well-defined on both sides (parity plan F3). The strict-float harness compares the
        ///     angles themselves (<see cref="SameLocal" />).
        /// </summary>
        internal static bool SameLocalMatrix(string at, string bone, BonePose p, BoneLocal l)
        {
            Matrix(p.Rotation, p.ScaleX, p.ScaleY, p.ShearX, p.ShearY, out float a1, out float b1, out float c1,
                out float d1);
            Matrix(l.Rotation, l.ScaleX, l.ScaleY, l.ShearX, l.ShearY, out float a2, out float b2, out float c2,
                out float d2);
            at = $"{at} bone {bone}";
            ParityDrift.Factor = ParityConditioning.FactorFor(bone);
            bool same = ParityDrift.Same("applied.matrix", at, a1, a2) &
                        ParityDrift.Same("applied.matrix", at, b1, b2) &
                        ParityDrift.Same("applied.matrix", at, c1, c2) &
                        ParityDrift.Same("applied.matrix", at, d1, d2) &
                        ParityDrift.Same("applied.xy", at, p.X, l.X) & ParityDrift.Same("applied.xy", at, p.Y, l.Y) &
                        ParityDrift.Same("discrete.inherit", at, (int)p.Inherit == (int)l.Inherit);
            ParityDrift.Factor = 1;
            return same;
        }

        private static void Matrix(float rotation, float scaleX, float scaleY, float shearX, float shearY, out float a,
            out float b, out float c, out float d)
        {
            const double degRad = Math.PI / 180;
            double rx = (rotation + (double)shearX) * degRad, ry = (rotation + 90.0 + shearY) * degRad;
            a = (float)(Math.Cos(rx) * scaleX);
            b = (float)(Math.Cos(ry) * scaleY);
            c = (float)(Math.Sin(rx) * scaleX);
            d = (float)(Math.Sin(ry) * scaleY);
        }

        /// <summary>
        ///     Two value lists of the same layout (constraint poses) are the same, value by value.
        /// </summary>
        internal static bool SameAll(string category, string at, float[] stock, float[] mine)
        {
            if (!ParityDrift.Same("discrete.count", at, stock.Length == mine.Length) ||
                stock.Length != mine.Length) return false;

            bool same = true;
            for (int i = 0; i < stock.Length; i++) same &= ParityDrift.Same(category, at, stock[i], mine[i]);
            return same;
        }

#if !BONEBURST_PARITY_HARNESS
        /// <summary>
        ///     One vertex of spine-unity's mesh against BoneBurst's: position, UV and colour (colour in bytes).
        ///     Used by the mesh comparisons of this suite's callers, spine-unity assembly included.
        /// </summary>
        internal static bool SameVertex(string at, Vector3 position, Vector2 uv, Color32 color, SkeletonVertex v,
            bool withZ)
        {
            return ParityDrift.Same("mesh.position", at, position.x, v.Position.x) &
                   ParityDrift.Same("mesh.position", at, position.y, v.Position.y) &
                   (!withZ || ParityDrift.Same("mesh.position", at, position.z, v.Position.z)) &
                   ParityDrift.Same("mesh.uv", at, uv.x, v.Uv.x) & ParityDrift.Same("mesh.uv", at, uv.y, v.Uv.y) &
                   ParityDrift.Same("mesh.color", at, color.r, v.R) & ParityDrift.Same("mesh.color", at, color.g, v.G) &
                   ParityDrift.Same("mesh.color", at, color.b, v.B) & ParityDrift.Same("mesh.color", at, color.a, v.A);
        }
#endif

        internal static object Member(object o, string name)
        {
            for (Type t = o?.GetType(); t != null; t = t.BaseType)
            {
                const BindingFlags all = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic |
                                         BindingFlags.DeclaredOnly;
                PropertyInfo p = t.GetProperty(name, all);
                if (p != null && p.GetIndexParameters().Length == 0) return p.GetValue(o);
                FieldInfo f = t.GetField(name, all) ??
                              t.GetField(char.ToLowerInvariant(name[0]) + name.Substring(1), all);
                if (f != null) return f.GetValue(o);
            }

            return null;
        }

        internal static float[] Floats(object pose, params string[] names)
        {
            return names.Select(n => Member(pose, n) switch
            {
                float f => f,
                int i => i,
                bool b => b ? 1f : 0f,
                _ => float.NaN
            }).ToArray();
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